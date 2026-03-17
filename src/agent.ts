/** Agent spawning and lifecycle management */

import { existsSync } from "node:fs";
import { getDb } from "./db.ts";
import { emit } from "./events.ts";
import { sendMail, checkMail, markRead } from "./mail.ts";
import { queryMemories, renderMemories, markUsed } from "./memory.ts";
import { getTask, incrementRetryCount, updateTask, checkoutTask, releaseTask } from "./tasks.ts";
import type { Agent, AgentCapability, AgentStatus, SpawnResult } from "./types.ts";
import { resolveModel, resolveEffort } from "./models.ts";
import { createWorktree, removeWorktree } from "./worktree.ts";
import { installAgentHooks } from "./hooks.ts";
import { buildCheckpointBlock } from "./checkpoint.ts";
import { buildPromptFromTemplate } from "./templates.ts";

/** Common English stopwords for keyword extraction */
const STOPWORDS = new Set([
	"the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
	"of", "with", "by", "from", "is", "it", "as", "be", "was", "are",
	"been", "this", "that", "these", "those", "will", "can", "has", "have",
	"had", "not", "all", "any", "its", "you", "your", "should", "must",
	"into", "also", "than", "then", "when", "what", "which", "who", "how",
	"each", "make", "like", "use", "just", "only", "new", "one", "two",
]);

/** System prompts per capability */
// @ts-ignore -- kept as reference, templates are primary
const SYSTEM_PROMPTS: Record<AgentCapability, string> = {
	builder: `You are a builder agent. Your job is to implement code changes for the given task.
Focus on writing clean, working code. When done, commit your changes and report back.

## Spec File
If a spec file exists at \`.grove/specs/<task-id>.md\`, read it before starting. It contains your objective, acceptance criteria, owned files, context, and dependencies. You MUST only modify files listed in the spec's "File Scope" section — modifying other files risks merge conflicts with parallel builders.

## Merge Ready Signal
After committing your changes and verifying they compile (typecheck passes), you MUST send a merge_ready signal:
\`\`\`bash
grove mail send --from <your-agent-name> --to orchestrator --subject "merge_ready: <your-agent-name>" --body "Verified: typecheck passed, changes committed." --type merge_ready
\`\`\`
The orchestrator will NOT merge your branch until it receives this signal. Only send it after your changes are committed and validated.

## CLAUDE.md Sync Reminder
If your changes affect how agents work, how commands behave, or how the orchestrator should operate, update the relevant section in CLAUDE.md to reflect the new behavior.`,

	scout: `You are a scout agent. Your job is to explore the codebase and gather information.
Do NOT modify any files. Read, search, and analyze only. Report your findings.`,

	reviewer: `You are a reviewer agent. Your job is to review code changes for quality and correctness.
Do NOT modify any files. Read and analyze the code, then report your verdict.

## Response Format

Always end your review with one of these two verdicts on its own line:

**PASS** — The implementation is correct, complete, and meets the task requirements.

**FAIL: <reason>** — The implementation has issues. Describe what is wrong and what the builder must fix.

## Review Checklist
- Does the code correctly implement the task requirements?
- Are there obvious bugs, missing edge cases, or broken logic?
- Does it follow the patterns and conventions of the surrounding codebase?
- Are any files missing or incomplete?`,

	lead: `You are a lead agent. You are a **coordinator**, not an implementer. Your job is to decompose tasks, spawn worker agents, wait for them to finish, and verify their results.

## Critical Rule: NEVER Edit Project Files

**You MUST NOT edit, write, or modify any project source files directly.** All code changes MUST go through builder agents. You may only write to \`.grove/specs/\` (spec files) and use \`grove\` CLI commands.

If you catch yourself about to use Write or Edit on a source file — STOP. Spawn a builder instead.

## Mandatory Scout Phase

**Every task MUST begin with a scout phase.** No exceptions. Even if you think you know the codebase, spawn a scout to confirm your assumptions. Scouts are fast and cheap; wrong assumptions are expensive.

The only thing you write directly is spec files in \`.grove/specs/\`.

## Delegation Reasoning (REQUIRED)

Before every action, log your reasoning:
- "**Spawning scout** for <subtask> because <reason>."
- "**Spawning builder** for <subtask> because <reason>."
- "**Spawning reviewer** for <subtask> because <reason>."

This must appear in your output before each spawn decision. The orchestrator uses this to audit your choices.

## Workflow

### Phase 1 — Scout (MANDATORY, never skip)

Spawn one or more scouts to understand the codebase before any implementation:

\`\`\`bash
grove task add scout-<topic> "Scout <topic>" --description "<what to find: file paths, patterns, interfaces>"
grove spawn scout-<topic> -n <name>-scout -c scout --parent <your-name>
\`\`\`

For tasks spanning 2+ subsystems, spawn parallel scouts with distinct focus areas:
\`\`\`bash
grove spawn scout-backend -n backend-scout -c scout --parent <your-name>
grove spawn scout-frontend -n frontend-scout -c scout --parent <your-name>
\`\`\`

**After spawning scouts, WAIT for their results before proceeding.** Use the waiting protocol below.

### Waiting for Sub-agents (REQUIRED)

After spawning any agent, you MUST wait for it to complete. Do NOT proceed to the next phase until all agents from the current phase have reported back.

**Waiting protocol:**
\`\`\`bash
# Check for messages from your sub-agents
grove mail check <your-name>

# If no mail yet, check agent status
grove status

# If a sub-agent is still running, wait and check again
sleep 30 && grove mail check <your-name>
\`\`\`

**Timeout rule:** If a sub-agent has not reported back within 3 minutes:
1. Run \`grove status\` to check if it is still running or has stalled
2. Check its logs: \`cat .grove/logs/<agent-name>/stderr.log\`
3. If stalled (no recent activity): stop it with \`grove stop <agent-name>\` and spawn a replacement
4. If still actively running: continue waiting with another \`sleep 30\` cycle

Do NOT move to Phase 2 without scout results. Do NOT move to Phase 3 without builder results.

### Phase 2 — Spec & Build

Use scout findings to write precise specs and spawn builders.

**Before spawning each builder**, write a spec file at \`.grove/specs/<task-id>.md\`:
\`\`\`markdown
# <task-id>
## Objective
<What this builder must accomplish>
## Acceptance Criteria
- [ ] <Criterion 1>
- [ ] <Criterion 2>
## File Scope (owned files)
- path/to/file1.ts
- path/to/file2.ts
## Context
<Relevant types, patterns, interfaces from scout findings>
## Dependencies
<Other tasks this depends on, or "none">
\`\`\`

**File ownership rule**: Each builder's spec MUST list the files it owns. Verify no two builders own the same file before spawning.

Then spawn the builder:
\`\`\`bash
grove task add <task-id> "<title>" --description "<detailed spec with exact file paths from scout>"
grove spawn <task-id> -n <agent-name> -c builder --parent <your-name>
\`\`\`
- Give each sub-task a unique, descriptive task-id
- Write clear, specific descriptions grounded in code paths the scout found
- Use \`--parent\` so sub-workers are tracked under you

**After spawning builders, WAIT for them to complete using the waiting protocol above.**

### Phase 3 — Review (recommended for complex changes)

\`\`\`bash
grove spawn <review-task-id> -n <name>-reviewer -c reviewer --parent <your-name>
\`\`\`
Reviewers report PASS or FAIL. If FAIL, spawn a corrective builder (max 3 revision attempts before escalating).

### Phase 4 — Verify & Report

1. **Verify results** — Review what workers produced:
   \`\`\`bash
   git diff main...<worker-branch>   # Review the diff
   \`\`\`

2. **Record learnings**:
   \`\`\`bash
   grove memory add <domain> <type> "<one sentence>"
   \`\`\`

3. **Report completion**:
   \`\`\`bash
   grove mail send --from <your-name> --to orchestrator --subject "Task complete" --body "<summary>" --type done
   \`\`\`

9. **Send merge_ready signal** — After verifying all sub-agents' work compiles and is correct, send the merge_ready signal for yourself and each completed sub-agent:
   \`\`\`bash
   grove mail send --from <sub-agent-name> --to orchestrator --subject "merge_ready: <sub-agent-name>" --body "Verified by lead." --type merge_ready
   grove mail send --from <your-name> --to orchestrator --subject "merge_ready: <your-name>" --body "All sub-work verified." --type merge_ready
   \`\`\`
   The orchestrator will NOT merge any branch until it has a merge_ready signal. Builders send their own signal after typecheck, but as lead you may also send on behalf of sub-agents if you've verified their work.

   Your completion report MUST include a **Sub-agent Activity Summary**:
   \`\`\`
   ## Sub-agent Activity
   - Spawned: <agent-name> (<capability>) — <outcome>
   \`\`\`

## Rules
- **NEVER edit project source files directly** — only builders do that.
- **ALWAYS start with a scout** — no exceptions.
- **ALWAYS wait for sub-agents** — do not proceed to the next phase until the current phase completes.
- Do NOT merge branches — the orchestrator handles merges.
- Do NOT spawn more than 4 sub-workers at a time.
- Always ground builder specs in code paths a scout has actually read.
- Always write a spec file before spawning a builder.
- Always verify file ownership non-overlap before spawning parallel builders.
- If a sub-agent hasn't reported in 3 minutes, check its status and retry if stalled.
- If a worker fails, read its logs (\`.grove/logs/<agent-name>/stderr.log\`) to diagnose.
- Cap builder revisions at 3 — if a builder fails review 3 times, escalate via mail to orchestrator.

## Named Failure Modes (avoid these)
- **SELF_IMPLEMENTATION** — Editing source files directly instead of spawning a builder. Leads coordinate; they do not implement. This is the #1 failure mode.
- **SCOUT_SKIP** — Skipping the scout phase. Always costs more time downstream in broken builds and vague specs.
- **PHASE_SKIP** — Moving to the next phase before the current phase's agents have completed. Leads to specs written without scout data or reviews run on incomplete code.
- **STALL_IGNORE** — Not checking on sub-agents that haven't reported in 3+ minutes. Leads to the lead timing out waiting for a dead agent.
- **SPEC_WITHOUT_SCOUT** — Writing a builder spec without scout findings. Produces vague specs and broken builds.
- **SILENT_FAILURE** — Not mailing the orchestrator when blocked or when a worker fails after 3 retries.
- **INFINITE_REVISION** — Retrying a builder more than 3 times without escalating.
- **SILENT_DELEGATION** — Not logging delegation reasoning before each spawn. The orchestrator cannot audit what the lead did or why.
- **OVERLAPPING_FILE_SCOPE** — Two or more builders owning the same file. Causes merge conflicts.`,
};

// System prompts also available via templates/*.md.tmpl — loaded via src/templates.ts

/** Tool restrictions per capability */
const ALLOWED_TOOLS: Record<AgentCapability, string> = {
	builder: "Bash,Read,Write,Edit,Glob,Grep",
	scout: "Bash,Read,Glob,Grep",
	reviewer: "Bash,Read,Glob,Grep",
	lead: "Bash,Read,Write,Edit,Glob,Grep",
};

// Model defaults are configured in src/models.ts

/** Inactivity timeout in ms per capability — agent is killed if no stdout for this long */
const CAPABILITY_TIMEOUTS: Record<AgentCapability, number> = {
	scout: 8 * 60_000,      // 8 minutes
	builder: 10 * 60_000,   // 10 minutes
	reviewer: 5 * 60_000,   // 5 minutes
	lead: 15 * 60_000,      // 15 minutes
};

/** Maximum number of automatic retries for failed agents */
const MAX_RETRIES = 2;

/** Graduated nudge thresholds (ms of silence before each stage triggers) */
const NUDGE_THRESHOLDS = {
	/** Stage 1: Gentle nudge to the agent */
	gentle: 2 * 60_000,    // 2 minutes
	/** Stage 2: Stronger nudge + PID liveness check */
	firm: 4 * 60_000,      // 4 minutes
	/** Stage 3: Escalate to orchestrator */
	escalate: 6 * 60_000,  // 6 minutes
};

/** Default maximum spawn depth (orchestrator=0 → lead=1 → worker=2) */
const MAX_SPAWN_DEPTH = 2;

/** Default maximum active sub-agents per lead (0 = unlimited) */
const MAX_AGENTS_PER_LEAD = 5;

/** Capabilities that leads are allowed to spawn */
const LEAD_SPAWNABLE: ReadonlySet<AgentCapability> = new Set(["builder", "scout", "reviewer"]);

/** Error thrown when agent hierarchy rules are violated */
export class HierarchyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HierarchyError";
	}
}

/**
 * Enforce agent hierarchy rules before spawning.
 * - Orchestrator (no parent) can spawn any capability.
 * - Leads can spawn builders, scouts, and reviewers — but NOT other leads.
 * - Builders, scouts, and reviewers cannot spawn any agents.
 */
function checkHierarchy(parentName: string | undefined, capability: AgentCapability): void {
	if (!parentName) return; // orchestrator can spawn anything

	const db = getDb();
	const parent = db
		.prepare("SELECT capability FROM agents WHERE name = ?")
		.get(parentName) as { capability: AgentCapability } | null;

	if (!parent) return; // parent not found in DB — let depth check handle it

	if (parent.capability !== "lead") {
		throw new HierarchyError(
			`Agent "${parentName}" (${parent.capability}) cannot spawn sub-agents. ` +
			`Only leads and the orchestrator can spawn agents.`,
		);
	}

	if (!LEAD_SPAWNABLE.has(capability)) {
		throw new HierarchyError(
			`Lead "${parentName}" cannot spawn a ${capability}. ` +
			`Leads can only spawn: ${[...LEAD_SPAWNABLE].join(", ")}.`,
		);
	}
}

/**
 * Check if a parent agent has reached its sub-agent limit.
 * Counts children with status IN ('running', 'spawning').
 * Throws if the limit is reached.
 */
export function checkParentAgentLimit(parentName: string, maxAgents?: number): void {
	const limit = maxAgents ?? MAX_AGENTS_PER_LEAD;
	if (limit === 0) return; // unlimited

	const db = getDb();
	const row = db
		.prepare(
			"SELECT COUNT(*) as count FROM agents WHERE parent_name = ? AND status IN ('running', 'spawning')",
		)
		.get(parentName) as { count: number };

	if (row.count >= limit) {
		throw new Error(
			`Parent agent "${parentName}" has reached its sub-agent limit (${row.count}/${limit} active). ` +
			`Wait for existing sub-agents to complete before spawning more, or increase the limit with --max-agents.`,
		);
	}
}

/**
 * Parse a Claude Code session ID from agent stdout.
 * Claude Code outputs the session ID in its startup text.
 * Matches patterns like: "Session: <id>", "session_id: <id>", or UUID-like strings after "session".
 */
function parseSessionId(stdout: string): string | null {
	// Match "Session: <uuid>" or "session: <uuid>" (common Claude Code output)
	const patterns = [
		/session[:\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
		/session.id[:\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
		/--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
	];

	for (const pattern of patterns) {
		const match = stdout.match(pattern);
		if (match?.[1]) return match[1];
	}

	return null;
}

/** Look up a previous agent's session ID by name */
export function getAgentSessionId(agentName: string): string | null {
	const db = getDb();
	const row = db
		.prepare("SELECT session_id FROM agents WHERE name = ?")
		.get(agentName) as { session_id: string | null } | null;
	return row?.session_id ?? null;
}

/** Spawn a new Claude Code agent in a worktree */
export async function spawnAgent(opts: {
	name: string;
	capability: AgentCapability;
	taskId: string;
	taskDescription: string;
	baseBranch: string;
	model?: string;
	parentName?: string;
	depth?: number;
	maxDepth?: number;
	maxAgents?: number;
	resumeSessionId?: string;
}): Promise<SpawnResult> {
	const db = getDb();

	// Check for name conflicts
	const existing = db
		.prepare("SELECT id FROM agents WHERE name = ? AND status IN ('spawning', 'running')")
		.get(opts.name);
	if (existing) {
		throw new Error(`Agent "${opts.name}" is already active`);
	}

	// Enforce per-lead sub-agent budget
	if (opts.parentName) {
		checkParentAgentLimit(opts.parentName, opts.maxAgents);
	}

	// Enforce hierarchy: only leads/orchestrator can spawn, leads cannot spawn leads
	checkHierarchy(opts.parentName, opts.capability);

	// Compute depth: if explicit depth provided use it, else derive from parent
	let depth = opts.depth ?? 0;
	if (depth === 0 && opts.parentName) {
		const parent = db
			.prepare("SELECT depth FROM agents WHERE name = ?")
			.get(opts.parentName) as { depth: number } | null;
		depth = (parent?.depth ?? 0) + 1;
	}

	// Prevent duplicate leads on the same task
	if (opts.capability === "lead") {
		checkDuplicateLead(opts.taskId);
	}

	// Atomic task checkout: prevent double-work on the same task
	const checkout = checkoutTask(opts.taskId, opts.name);
	if (!checkout.success) {
		throw new Error(
			`Task "${opts.taskId}" is already checked out by agent "${checkout.lockedBy}". ` +
			`Cannot spawn "${opts.name}" — another agent owns this task.`,
		);
	}

	// Enforce depth limit
	const maxDepth = opts.maxDepth ?? MAX_SPAWN_DEPTH;
	if (depth > maxDepth) {
		throw new Error(
			`Spawn depth ${depth} exceeds maximum ${maxDepth}. ` +
			`Agent "${opts.name}" cannot be spawned as a child of "${opts.parentName}". ` +
			`Depth chain: orchestrator(0) → lead(1) → worker(2).`,
		);
	}

	// Create worktree, register in DB, and spawn process — with rollback on failure
	let worktreeCreated = false;
	let dbInserted = false;
	let worktreePath: string;
	let branch: string;
	let proc: ReturnType<typeof Bun.spawn>;
	let pid: number;
	let logDir: string;

	try {
		// Create worktree
		const wt = await createWorktree(opts.name, opts.baseBranch);
		worktreePath = wt.worktreePath;
		branch = wt.branch;
		worktreeCreated = true;

		// Deploy capability-specific PreToolUse guards to the worktree
		await installAgentHooks(worktreePath, opts.capability);

		// Register agent in DB
		const stmt = db.prepare(`
			INSERT INTO agents (name, capability, status, worktree, branch, task_id, parent_name, depth)
			VALUES (?, ?, 'spawning', ?, ?, ?, ?, ?)
		`);
		stmt.run(
			opts.name,
			opts.capability,
			worktreePath,
			branch,
			opts.taskId,
			opts.parentName ?? null,
			depth,
		);
		dbInserted = true;

		// Gather context in parallel: memories, sibling info, prior work, scout findings, file ownership
		const memories = queryTaskRelevantMemories(opts.taskDescription);
		const memoryBlock = renderMemories(memories);
		if (memories.length > 0) {
			markUsed(memories.map((m) => m.id));
		}
		const siblingBlock = opts.parentName
			? buildSiblingBlock(opts.parentName, opts.name)
			: "";
		const priorWorkBlock = buildPriorWorkBlock(opts.taskId, opts.name);
		const checkpointBlock = buildCheckpointBlock(opts.taskId, opts.name);
		const goalAncestryBlock = buildGoalAncestryBlock(opts.taskId);

		// Include scout findings for builders and leads (scouts don't need their own findings)
		const scoutFindingsBlock =
			opts.capability === "builder" || opts.capability === "lead"
				? buildScoutFindingsBlock(opts.taskId, opts.name)
				: "";

		// Include file ownership boundaries from spec file (primarily for builders)
		const fileOwnershipBlock =
			opts.capability === "builder" || opts.capability === "lead"
				? await buildFileOwnershipBlock(opts.taskId)
				: "";

		// Build the prompt from overlay templates
		const prompt = buildPrompt(
			opts.capability,
			opts.taskDescription,
			opts.name,
			memoryBlock,
			siblingBlock,
			priorWorkBlock,
			scoutFindingsBlock,
			fileOwnershipBlock,
			checkpointBlock,
			goalAncestryBlock,
			opts.parentName,
			depth,
			opts.taskId,
			branch,
		);

		// Write log dir marker and prompt file in parallel
		logDir = `${process.cwd()}/.grove/logs/${opts.name}`;
		const promptFile = `${logDir}/prompt.txt`;
		await Promise.all([
			Bun.write(`${logDir}/.keep`, ""),
			Bun.write(promptFile, prompt),
		]);

		const model = resolveModel(opts.capability, opts.model);
		const effort = resolveEffort(opts.capability);

		// Build claude args — use --resume if we have a session ID from a previous agent
		const isResume = !!opts.resumeSessionId;
		const args: string[] = ["claude"];
		if (isResume) {
			args.push("--resume", opts.resumeSessionId!);
		} else {
			args.push("-p");
		}
		args.push(
			"--model", model,
			"--effort", effort,
			"--allowedTools", ALLOWED_TOOLS[opts.capability] ?? "",
			"--dangerously-skip-permissions",
		);

		proc = Bun.spawn(args, {
			cwd: worktreePath,
			stdout: Bun.file(`${logDir}/stdout.txt`),
			stderr: Bun.file(`${logDir}/stderr.log`),
			// Only pipe prompt via stdin for fresh sessions; resumed sessions don't need it
			stdin: isResume ? undefined : Bun.file(promptFile),
			env: { ...process.env, PATH: process.env.PATH, CLAUDECODE: "", GROVE_AGENT: "1" },
		});
		// Write prompt to stdin manually — Bun.file() as stdin does not reliably pipe content
		const promptContent = await Bun.file(promptFile).text();
		const stdinWriter = proc.stdin as import("bun").FileSink;
		stdinWriter.write(promptContent);
		stdinWriter.end();

		pid = proc.pid;

		// Update agent with PID and mark running
		db.prepare("UPDATE agents SET pid = ?, status = 'running', updated_at = datetime('now') WHERE name = ?").run(
			pid,
			opts.name,
		);
	} catch (err) {
		// Rollback: clean up DB entry, worktree, and task lock on spawn failure
		if (dbInserted) {
			try { db.prepare("DELETE FROM agents WHERE name = ?").run(opts.name); } catch { /* best-effort */ }
		}
		if (worktreeCreated) {
			try { await removeWorktree(opts.name); } catch { /* best-effort */ }
		}
		try { releaseTask(opts.taskId); } catch { /* best-effort */ }
		throw err;
	}

	emit("agent.spawn", `Spawned ${opts.capability} agent "${opts.name}" on ${branch}`, {
		agent: opts.name,
		detail: `task=${opts.taskId} pid=${pid}`,
	});

	// Update task assignment
	updateTask(opts.taskId, { status: "in_progress", assignedTo: opts.name });

	// If this agent has a parent, bump the parent's last_activity_at (child spawn = parent is active)
	if (opts.parentName) {
		db.prepare("UPDATE agents SET last_activity_at = datetime('now') WHERE name = ?").run(opts.parentName);
	}

	// Poll stdout.txt for new output every 10s and update last_activity_at
	const stdoutFile = `${logDir}/stdout.txt`;
	let lastKnownSize = 0;
	let sessionIdCaptured = !!opts.resumeSessionId; // Already have it if resuming
	const timeoutMs = CAPABILITY_TIMEOUTS[opts.capability];
	const HEARTBEAT_INTERVAL_MS = 60_000;
	let lastHeartbeatAt = Date.now();
	/** Tracks which nudge stage has been sent (0=none, 1=gentle, 2=firm, 3=escalated) */
	let lastNudgeStage = 0;

	// If resuming, store the session ID immediately
	if (opts.resumeSessionId) {
		db.prepare("UPDATE agents SET session_id = ? WHERE name = ?").run(opts.resumeSessionId, opts.name);
	}

	const activityPoller = setInterval(async () => {
		try {
			// Skip if process is already dead — let proc.exited.then() handle
			// status updates authoritatively (it knows the exit code).
			// reconcileZombies() serves as the safety net for orphaned agents.
			if (!isPidAlive(pid)) {
				clearInterval(activityPoller);
				return;
			}

			const file = Bun.file(stdoutFile);
			const size = file.size;
			const now = Date.now();
			if (size > lastKnownSize) {
				lastKnownSize = size;
				lastNudgeStage = 0; // Reset nudge escalation on activity
				getDb()
					.prepare("UPDATE agents SET last_activity_at = datetime('now') WHERE name = ? AND status IN ('running', 'spawning')")
					.run(opts.name);

				// Try to capture session ID from early output (only once)
				if (!sessionIdCaptured) {
					try {
						const content = await file.text();
						const captured = parseSessionId(content);
						if (captured) {
							sessionIdCaptured = true;
							getDb()
								.prepare("UPDATE agents SET session_id = ? WHERE name = ?")
								.run(captured, opts.name);
						}
					} catch {
						// File may be mid-write — retry next poll
					}
				}
				// Send heartbeat mail if enough time has passed since last heartbeat
				if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
					lastHeartbeatAt = now;
					const recipient = opts.parentName ?? "orchestrator";

					// Read last-tool.json for context enrichment
					let lastToolInfo = "";
					try {
						const lastToolPath = `${logDir}/last-tool.json`;
						const lastToolFile = Bun.file(lastToolPath);
						if (await lastToolFile.exists()) {
							const data = JSON.parse(await lastToolFile.text()) as { tool?: string; inputSummary?: string; timestamp?: string };
							if (data.tool) {
								lastToolInfo = ` Last tool: ${data.tool} on ${data.inputSummary ?? "unknown"} at ${data.timestamp ?? "unknown"}`;
							}
						}
					} catch {
						// File may not exist or be unreadable — ignore
					}

					sendMail({
						from: opts.name,
						to: recipient,
						subject: `Heartbeat: ${opts.name}`,
						body: `Agent ${opts.name} heartbeat: ${size} bytes output.${lastToolInfo}`,
						type: "status",
					});
				}
			} else {
				// Graduated stall detection: nudge → firm nudge → escalate → kill
				const agent = getAgent(opts.name);
				if (!agent || agent.status !== "running") return;
				const activityTs = agent.lastActivityAt ?? agent.createdAt;
				const silenceMs = now - new Date(activityTs.endsWith("Z") ? activityTs : activityTs + "Z").getTime();
				const recipient = opts.parentName ?? "orchestrator";
				const pidAlive = agent.pid ? isPidAlive(agent.pid) : false;

				// Stage 1: Gentle nudge (2 min silence)
				if (silenceMs >= NUDGE_THRESHOLDS.gentle && lastNudgeStage < 1) {
					lastNudgeStage = 1;
					// PID dead + no output = not stalled, just dead — skip nudges and let exit handler deal with it
					if (!pidAlive) return;
					sendMail({
						from: "watchdog",
						to: opts.name,
						subject: `Nudge: ${opts.name} appears idle`,
						body: `No output detected for ${Math.round(silenceMs / 60_000)} minutes. If you're blocked, consider trying a different approach or reporting status. Output size: ${lastKnownSize} bytes.`,
						type: "status",
					});
					emit("watchdog.nudge", `Gentle nudge sent to "${opts.name}" after ${Math.round(silenceMs / 60_000)}min silence`, { agent: opts.name });
				}

				// Stage 2: Firm nudge + PID liveness check (4 min silence)
				if (silenceMs >= NUDGE_THRESHOLDS.firm && lastNudgeStage < 2) {
					lastNudgeStage = 2;
					if (!pidAlive) {
						// Process is dead but exit handler hasn't fired — mark failed now
						clearInterval(activityPoller);
						getDb()
							.prepare("UPDATE agents SET status = 'failed', updated_at = datetime('now') WHERE name = ?")
							.run(opts.name);
						emit("agent.failed", `Agent "${opts.name}" process died (detected at firm nudge stage)`, { agent: opts.name });
						sendMail({
							from: "watchdog",
							to: recipient,
							subject: `Agent ${opts.name} process dead`,
							body: `Process PID ${agent.pid} is no longer alive after ${Math.round(silenceMs / 60_000)} minutes of silence. Marked as failed.`,
							type: "error",
						});
						return;
					}
					sendMail({
						from: "watchdog",
						to: opts.name,
						subject: `Warning: ${opts.name} stalled for ${Math.round(silenceMs / 60_000)}min`,
						body: `You have produced no output for ${Math.round(silenceMs / 60_000)} minutes. Process is alive (PID ${agent.pid}). If you are stuck, commit partial work and report your status. You will be stopped if inactivity continues.`,
						type: "status",
					});
					emit("watchdog.nudge", `Firm nudge sent to "${opts.name}" — PID alive, ${Math.round(silenceMs / 60_000)}min silent`, { agent: opts.name });
				}

				// Stage 3: Escalate to orchestrator (6 min silence)
				if (silenceMs >= NUDGE_THRESHOLDS.escalate && lastNudgeStage < 3) {
					lastNudgeStage = 3;
					if (!pidAlive) {
						// Process died between firm nudge and escalation
						clearInterval(activityPoller);
						getDb()
							.prepare("UPDATE agents SET status = 'failed', updated_at = datetime('now') WHERE name = ?")
							.run(opts.name);
						emit("agent.failed", `Agent "${opts.name}" process died (detected at escalation stage)`, { agent: opts.name });
						sendMail({
							from: "watchdog",
							to: recipient,
							subject: `Agent ${opts.name} process dead`,
							body: `Process PID ${agent.pid} died after ${Math.round(silenceMs / 60_000)} minutes of silence. Marked as failed.`,
							type: "error",
						});
						return;
					}
					sendMail({
						from: "watchdog",
						to: recipient,
						subject: `Escalation: ${opts.name} stalled ${Math.round(silenceMs / 60_000)}min`,
						body: `Agent "${opts.name}" (${opts.capability}) has been silent for ${Math.round(silenceMs / 60_000)} minutes despite nudges. Process PID ${agent.pid} is still alive. Task: ${opts.taskId}. Consider stopping and retrying, or allow more time.`,
						type: "error",
					});
					emit("watchdog.escalate", `Escalated stall for "${opts.name}" to ${recipient} after ${Math.round(silenceMs / 60_000)}min`, { agent: opts.name });
				}

				// Final stage: Kill after capability timeout (existing behavior)
				if (silenceMs > timeoutMs) {
					clearInterval(activityPoller);
					if (agent.pid) {
						try { process.kill(agent.pid, "SIGTERM"); } catch { /* already gone */ }
					}
					getDb()
						.prepare("UPDATE agents SET status = 'failed', updated_at = datetime('now') WHERE name = ?")
						.run(opts.name);
					emit("agent.failed", `Agent "${opts.name}" timed out after ${timeoutMs / 60_000}min with no output`, { agent: opts.name });
					sendMail({
						from: "watchdog",
						to: recipient,
						subject: `Agent ${opts.name} timed out`,
						body: `Auto-stopped after ${timeoutMs / 60_000} minutes with no output. Capability: ${opts.capability}. All ${lastNudgeStage} nudge stages were sent before termination.`,
						type: "error",
					});
					// Update task — only if no other agents for this task are still active
					const remainingTimeout = getDb()
						.prepare(
							"SELECT COUNT(*) as count FROM agents WHERE task_id = ? AND name != ? AND status IN ('running', 'spawning')",
						)
						.get(opts.taskId, opts.name) as { count: number };
					if (remainingTimeout.count === 0) {
						updateTask(opts.taskId, { status: "failed" });
						// Release task lock when no more agents are working on it
						try { releaseTask(opts.taskId); } catch { /* task may not exist */ }
					}
				}
			}
		} catch {
			// File may not exist yet — ignore
		}
	}, 10_000);

	// Watch for process exit in the background
	// Use getDb() instead of captured `db` — the CLI's postAction hook closes
	// the original connection before this callback fires.
	proc.exited.then(async (exitCode) => {
		clearInterval(activityPoller);
		const liveDb = getDb();
		const status: AgentStatus = exitCode === 0 ? "completed" : "failed";
		// Only update if still running/spawning, or upgrading from 'failed' to 'completed'.
		// This prevents overwriting a correct status set by reconcileZombies or the watchdog.
		liveDb
			.prepare(
				status === "completed"
					? "UPDATE agents SET status = ?, updated_at = datetime('now') WHERE name = ? AND status IN ('running', 'spawning', 'failed')"
					: "UPDATE agents SET status = ?, updated_at = datetime('now') WHERE name = ? AND status IN ('running', 'spawning')",
			)
			.run(status, opts.name);

		emit(status === "completed" ? "agent.completed" : "agent.failed", `Agent "${opts.name}" ${status} (exit ${exitCode})`, {
			agent: opts.name,
		});

		// Cascade stop: if a lead agent fails, stop all running sub-agents
		if (status === "failed" && opts.capability === "lead") {
			const children = liveDb
				.prepare("SELECT name FROM agents WHERE parent_name = ? AND status IN ('running', 'spawning')")
				.all(opts.name) as { name: string }[];
			for (const child of children) {
				try {
					await stopAgent(child.name);
				} catch {
					// Child may have already exited
				}
			}
		}

		// Build rich completion mail body
		const mailBody = await buildCompletionMailBody(exitCode, worktreePath, logDir);

		// Notify parent (or orchestrator if no parent)
		const recipient = opts.parentName ?? "orchestrator";
		sendMail({
			from: opts.name,
			to: recipient,
			subject: `Agent ${opts.name} ${status}`,
			body: mailBody,
			type: status === "completed" ? "done" : "error",
		});

		// Update task — only if no other agents for this task are still active
		const remainingForTask = liveDb
			.prepare(
				"SELECT COUNT(*) as count FROM agents WHERE task_id = ? AND name != ? AND status IN ('running', 'spawning')",
			)
			.get(opts.taskId, opts.name) as { count: number };
		if (remainingForTask.count === 0) {
			updateTask(opts.taskId, {
				status: status === "completed" ? "completed" : "failed",
			});
			// Release task lock when no more agents are working on it
			try { releaseTask(opts.taskId); } catch { /* task may not exist */ }
		}

		// Auto-retry on failure
		if (status === "failed") {
			await maybeRetryAgent({
				taskId: opts.taskId,
				name: opts.name,
				capability: opts.capability,
				baseBranch: opts.baseBranch,
				taskDescription: opts.taskDescription,
				parentName: opts.parentName,
				depth,
				model: opts.model,
			});
		}
	});

	const agent: Agent = {
		id: 0,
		name: opts.name,
		capability: opts.capability,
		status: "running",
		pid,
		worktree: worktreePath,
		branch,
		taskId: opts.taskId,
		parentName: opts.parentName ?? null,
		depth,
		sessionId: opts.resumeSessionId ?? null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		lastActivityAt: null,
	};

	return { agent, pid, exitPromise: proc.exited };
}

/** Check that no other lead is already actively working the given task */
function checkDuplicateLead(taskId: string): void {
	const db = getDb();
	const existing = db
		.prepare(
			"SELECT name FROM agents WHERE task_id = ? AND capability = 'lead' AND status IN ('running', 'spawning')",
		)
		.get(taskId) as { name: string } | null;
	if (existing) {
		throw new Error(
			`Task ${taskId} already has an active lead: ${existing.name}`,
		);
	}
}

// Hierarchy rules and startup checklists are now embedded in templates/*.md.tmpl

/** Startup checklist per capability */
// @ts-ignore -- kept as reference, templates are primary
const STARTUP_CHECKLISTS: Record<AgentCapability, string[]> = {
	scout: [
		"Read and understand the task description",
		"Explore the relevant codebase areas",
		"Gather file paths, interfaces, and patterns",
		"Report findings to parent via completion",
	],
	builder: [
		"Read and understand the task description",
		"Read the spec file if one exists at `.grove/specs/<task-id>.md`",
		"Read prior work context (if any) to avoid rework",
		"Implement the required changes",
		"Run typecheck: `bun run typecheck` (if applicable)",
		"Commit all changes with a descriptive message",
		"Send merge_ready signal: `grove mail send --from <name> --to orchestrator --subject 'merge_ready: <name>' --body 'Verified.' --type merge_ready`",
	],
	lead: [
		"Read and understand the task description",
		"Assess complexity tier (Simple / Moderate / Complex)",
		"Plan decomposition — identify sub-tasks and file scope",
		"Spawn sub-agents (scouts first if code is unread, then builders)",
		"Monitor, verify, and report completion",
		"Send merge_ready signals for verified sub-agents and self",
	],
	reviewer: [
		"Read and understand the task description",
		"Read all changed files on the branch under review",
		"Verify correctness, completeness, and code quality",
		"Report verdict: PASS or FAIL with details",
	],
};

/** Build the full prompt for an agent using overlay templates */
function buildPrompt(
	capability: AgentCapability,
	taskDescription: string,
	agentName: string,
	memoryBlock: string,
	siblingBlock: string,
	priorWorkBlock: string,
	scoutFindingsBlock: string,
	fileOwnershipBlock: string,
	checkpointBlock: string,
	goalAncestryBlock: string,
	parentName?: string,
	depth?: number,
	taskId?: string,
	branchName?: string,
): string {
	return buildPromptFromTemplate({
		capability,
		agentName,
		taskId: taskId ?? "",
		taskDescription,
		parentName,
		depth,
		branchName,
		memoryBlock,
		siblingBlock,
		priorWorkBlock,
		priorFindings: scoutFindingsBlock,
		fileScope: fileOwnershipBlock,
		checkpointBlock,
		goalAncestryBlock,
	});
}

/** Extract keywords from task description for memory filtering */
function extractKeywords(text: string): string[] {
	const words = text
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 3 && !STOPWORDS.has(w));
	return [...new Set(words)];
}

/** Query memories filtered by task-relevant domains, with global fallback */
function queryTaskRelevantMemories(taskDescription: string): ReturnType<typeof queryMemories> {
	const keywords = extractKeywords(taskDescription);

	if (keywords.length === 0) {
		return queryMemories();
	}

	// Query per-keyword domain and deduplicate
	const seen = new Set<number>();
	const relevant: ReturnType<typeof queryMemories> = [];

	for (const keyword of keywords) {
		const matches = queryMemories({ domain: keyword });
		for (const m of matches) {
			if (!seen.has(m.id)) {
				seen.add(m.id);
				relevant.push(m);
			}
		}
	}

	// Fall back to global if no domain matches
	if (relevant.length === 0) {
		return queryMemories();
	}

	// Cap at 20 (MAX_INJECT equivalent), sort by useCount desc
	return relevant
		.sort((a, b) => b.useCount - a.useCount)
		.slice(0, 20);
}

/** Build a context block listing sibling agents (same parent) */
function buildSiblingBlock(parentName: string, selfName: string): string {
	const db = getDb();
	const siblings = db
		.prepare(
			`SELECT name, capability, task_id, branch, status
			 FROM agents WHERE parent_name = ? AND name != ?`,
		)
		.all(parentName, selfName) as Array<{
		name: string;
		capability: string;
		task_id: string;
		branch: string;
		status: string;
	}>;

	if (siblings.length === 0) return "";

	const lines = ["## Sibling Agents", ""];
	lines.push("Other agents working under the same lead:");
	lines.push("");
	lines.push("| Name | Role | Task | Branch | Status |");
	lines.push("|------|------|------|--------|--------|");
	for (const s of siblings) {
		lines.push(`| ${s.name} | ${s.capability} | ${s.task_id} | ${s.branch} | ${s.status} |`);
	}
	lines.push("");
	lines.push("Coordinate to avoid conflicts — don't modify files another sibling is working on.");

	return lines.join("\n");
}

/** Build a goal ancestry block showing the task's parent chain */
function buildGoalAncestryBlock(taskId: string): string {
	const ancestry = getGoalAncestry(taskId);

	// Only show ancestry if there's a parent (chain length > 1)
	if (ancestry.length <= 1) return "";

	const lines = ["## Goal Ancestry", ""];
	lines.push("You are working on this task as part of a larger goal chain:");
	lines.push("");

	// Format: current task → parent → grandparent → ... → root
	const chain = ancestry.map((a) => a.title).join(" → ");
	lines.push(chain);
	lines.push("");

	// Detailed breakdown
	for (const [i, item] of ancestry.entries()) {
		const prefix = i === 0 ? "**Current**" : `Level ${i}`;
		lines.push(`- ${prefix}: ${item.title} (\`${item.taskId}\`)`);
	}
	lines.push("");
	lines.push("Use this context to make better decisions about scope and priorities.");

	return lines.join("\n");
}

/** Build a context block with prior completed agent work on the same task */
function buildPriorWorkBlock(taskId: string, selfName: string): string {
	const db = getDb();

	// Find completion mails from agents that worked on the same task
	const priorWork = db
		.prepare(
			`SELECT m.body, m.from_agent, a.capability
			 FROM mail m JOIN agents a ON m.from_agent = a.name
			 WHERE a.task_id = ? AND a.status = 'completed' AND a.name != ? AND m.type = 'done'
			 ORDER BY m.created_at DESC LIMIT 3`,
		)
		.all(taskId, selfName) as Array<{
		body: string;
		from_agent: string;
		capability: string;
	}>;

	if (priorWork.length === 0) return "";

	const lines = ["## Prior Work on This Task", ""];
	const maxLinesPerEntry = 80;

	for (const pw of priorWork) {
		lines.push(`### ${pw.from_agent} (${pw.capability})`);
		const bodyLines = pw.body.split("\n");
		if (bodyLines.length > maxLinesPerEntry) {
			lines.push(...bodyLines.slice(0, maxLinesPerEntry));
			lines.push(`... (${bodyLines.length - maxLinesPerEntry} more lines truncated)`);
		} else {
			lines.push(pw.body);
		}
		lines.push("");
	}

	return lines.join("\n");
}

/** Build a context block with scout findings for builder/lead agents on the same task */
function buildScoutFindingsBlock(taskId: string, selfName: string): string {
	const db = getDb();

	// Find completion mails from scout agents that worked on this task (or a parent task prefix)
	const scoutFindings = db
		.prepare(
			`SELECT m.body, m.from_agent, m.subject
			 FROM mail m JOIN agents a ON m.from_agent = a.name
			 WHERE a.task_id = ? AND a.capability = 'scout' AND a.status = 'completed'
			   AND a.name != ? AND m.type = 'done'
			 ORDER BY m.created_at DESC LIMIT 3`,
		)
		.all(taskId, selfName) as Array<{
		body: string;
		from_agent: string;
		subject: string;
	}>;

	// Also look for scouts spawned by the same parent (related task context)
	// This catches scouts on sibling tasks that discovered relevant file paths
	const parentScouts = db
		.prepare(
			`SELECT m.body, m.from_agent, m.subject
			 FROM mail m
			 JOIN agents a ON m.from_agent = a.name
			 JOIN agents self ON self.name = ?
			 WHERE a.capability = 'scout' AND a.status = 'completed'
			   AND a.parent_name = self.parent_name AND a.parent_name IS NOT NULL
			   AND a.task_id != ? AND a.name != ?
			   AND m.type = 'done'
			 ORDER BY m.created_at DESC LIMIT 2`,
		)
		.all(selfName, taskId, selfName) as Array<{
		body: string;
		from_agent: string;
		subject: string;
	}>;

	const allFindings = [...scoutFindings];
	const seenAgents = new Set(scoutFindings.map((f) => f.from_agent));
	for (const pf of parentScouts) {
		if (!seenAgents.has(pf.from_agent)) {
			allFindings.push(pf);
			seenAgents.add(pf.from_agent);
		}
	}

	if (allFindings.length === 0) return "";

	const lines = ["## Scout Findings", ""];
	lines.push("The following scouts have explored the codebase for this task:");
	lines.push("");

	const maxLinesPerFinding = 60;
	for (const sf of allFindings) {
		lines.push(`### ${sf.from_agent}`);
		const bodyLines = sf.body.split("\n");
		if (bodyLines.length > maxLinesPerFinding) {
			lines.push(...bodyLines.slice(0, maxLinesPerFinding));
			lines.push(`... (${bodyLines.length - maxLinesPerFinding} more lines truncated)`);
		} else {
			lines.push(sf.body);
		}
		lines.push("");
	}

	return lines.join("\n");
}

/** Build a context block with file ownership boundaries from the spec file */
async function buildFileOwnershipBlock(taskId: string): Promise<string> {
	const specPath = `${process.cwd()}/.grove/specs/${taskId}.md`;

	try {
		const specFile = Bun.file(specPath);
		if (!(await specFile.exists())) return "";

		const content = await specFile.text();

		// Extract the File Scope section from the spec
		const fileScopeMatch = content.match(/## File Scope[^\n]*\n([\s\S]*?)(?=\n## |\n# |$)/);
		if (!fileScopeMatch?.[1]) return "";

		const fileScopeContent = fileScopeMatch[1].trim();
		if (!fileScopeContent) return "";

		// Extract file paths (lines starting with - or *)
		const filePaths = fileScopeContent
			.split("\n")
			.map((line) => line.replace(/^[\s*-]+/, "").trim())
			.filter((line) => line.length > 0 && (line.includes("/") || line.includes(".")));

		if (filePaths.length === 0) return "";

		const lines = ["## File Ownership Boundaries", ""];
		lines.push("You are authorized to modify ONLY these files:");
		lines.push("");
		for (const fp of filePaths) {
			lines.push(`- \`${fp}\``);
		}
		lines.push("");
		lines.push("**Do NOT modify files outside this list** — other agents may be working on them concurrently.");
		lines.push("If you need changes in other files, report this in your completion mail so the lead can coordinate.");
		lines.push("");

		return lines.join("\n");
	} catch {
		return "";
	}
}

/**
 * Attempt to auto-retry a failed agent's task.
 * Returns true if a retry was spawned, false if retries are exhausted.
 */
async function maybeRetryAgent(opts: {
	taskId: string;
	name: string;
	capability: AgentCapability;
	baseBranch: string;
	taskDescription: string;
	parentName?: string | null;
	depth: number;
	model?: string;
}): Promise<boolean> {
	const task = getTask(opts.taskId);
	if (!task) return false;

	// Check if retries are exhausted
	if (task.retryCount >= MAX_RETRIES) return false;

	const newCount = incrementRetryCount(opts.taskId);
	const retryName = `${opts.name}-retry${newCount}`;

	// Look up previous agent's session ID for --resume
	const previousSessionId = getAgentSessionId(opts.name);

	emit("agent.spawn", `Auto-retrying task "${opts.taskId}" (attempt ${newCount}/${MAX_RETRIES}) as "${retryName}"${previousSessionId ? " with --resume" : ""}`, {
		agent: retryName,
		detail: `previous=${opts.name} retry=${newCount}${previousSessionId ? ` resume=${previousSessionId}` : ""}`,
	});

	// Reset task status so the new agent can pick it up
	updateTask(opts.taskId, { status: "pending" });

	try {
		await spawnAgent({
			name: retryName,
			capability: opts.capability,
			taskId: opts.taskId,
			taskDescription: opts.taskDescription,
			baseBranch: opts.baseBranch,
			parentName: opts.parentName ?? undefined,
			depth: opts.depth,
			model: opts.model,
			resumeSessionId: previousSessionId ?? undefined,
		});

		const recipient = opts.parentName ?? "orchestrator";
		sendMail({
			from: retryName,
			to: recipient,
			subject: `Auto-retrying task ${opts.taskId} (attempt ${newCount}/${MAX_RETRIES})`,
			body: `Agent "${opts.name}" failed. Automatically spawned "${retryName}" to retry. Previous work is available via prior-work context injection.`,
			type: "status",
		});

		return true;
	} catch (err) {
		// Retry spawn failed — notify and give up
		const recipient = opts.parentName ?? "orchestrator";
		sendMail({
			from: opts.name,
			to: recipient,
			subject: `Auto-retry failed for task ${opts.taskId}`,
			body: `Attempted to spawn retry agent "${retryName}" but failed: ${err instanceof Error ? err.message : String(err)}`,
			type: "error",
		});
		updateTask(opts.taskId, { status: "failed" });
		return false;
	}
}

/** Build a rich completion mail body with file list and output tail */
async function buildCompletionMailBody(
	exitCode: number,
	worktreePath: string,
	logDir: string,
): Promise<string> {
	const parts: string[] = [`Exit code: ${exitCode}`];

	// Get files changed on the branch
	try {
		const diffProc = Bun.spawn(["git", "diff", "--name-only", "HEAD~1"], {
			cwd: worktreePath,
			stdout: "pipe",
			stderr: "pipe",
		});
		const diffExit = await diffProc.exited;
		if (diffExit === 0) {
			const fileList = await new Response(diffProc.stdout).text();
			const trimmed = fileList.trim();
			if (trimmed) {
				parts.push(`\nFiles changed:\n${trimmed}`);
			}
		}
	} catch {
		// Worktree may already be gone or no commits made
	}

	// Read last 50 lines of stdout
	const stdoutPath = `${logDir}/stdout.txt`;
	try {
		if (existsSync(stdoutPath)) {
			const content = await Bun.file(stdoutPath).text();
			const lines = content.split("\n");
			const tail = lines.slice(-50).join("\n").trim();
			if (tail) {
				parts.push(`\nOutput (last 50 lines):\n${tail}`);
			}
		}
	} catch {
		// Log file may not exist or be unreadable
	}

	return parts.join("\n");
}

/** Get an agent by its worktree path */
export function getAgentByWorktree(worktreePath: string): Agent | null {
	const db = getDb();
	// Normalize path separators for cross-platform matching
	const normalized = worktreePath.replace(/\\/g, "/").replace(/\/+$/, "");
	return db
		.prepare(
			`SELECT id, name, capability, status, pid, worktree, branch,
			        task_id as taskId, parent_name as parentName, depth,
			        session_id as sessionId,
			        created_at as createdAt, updated_at as updatedAt,
			        last_activity_at as lastActivityAt
		   FROM agents WHERE REPLACE(worktree, '\\', '/') = ?`,
		)
		.get(normalized) as Agent | null;
}

/** Get an agent by name */
export function getAgent(name: string): Agent | null {
	const db = getDb();
	return db
		.prepare(
			`SELECT id, name, capability, status, pid, worktree, branch,
			        task_id as taskId, parent_name as parentName, depth,
			        session_id as sessionId,
			        created_at as createdAt, updated_at as updatedAt,
			        last_activity_at as lastActivityAt
		   FROM agents WHERE name = ?`,
		)
		.get(name) as Agent | null;
}

/** List all agents, optionally filtered by status */
export function listAgents(status?: AgentStatus): Agent[] {
	const db = getDb();
	const where = status ? "WHERE status = ?" : "";
	const params = status ? [status] : [];

	return db
		.prepare(
			`SELECT id, name, capability, status, pid, worktree, branch,
			        task_id as taskId, parent_name as parentName, depth,
			        session_id as sessionId,
			        created_at as createdAt, updated_at as updatedAt,
			        last_activity_at as lastActivityAt
		   FROM agents ${where} ORDER BY created_at DESC`,
		)
		.all(...params) as Agent[];
}

/** Check if a PID is alive (process exists and is running) */
export function isPidAlive(pid: number): boolean {
	try {
		// signal 0 doesn't kill — just checks if process exists
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Reconcile DB state with actual PID liveness.
 * Any agent marked 'running' or 'spawning' whose PID is dead gets marked 'failed'
 * and an error mail is sent to its parent (or orchestrator).
 * Returns the list of agent names that were marked as zombies.
 */
export function reconcileZombies(): string[] {
	const db = getDb();
	const active = db
		.prepare(
			`SELECT name, pid, capability, task_id as taskId, parent_name as parentName,
			        branch, depth
			 FROM agents WHERE status IN ('running', 'spawning')`,
		)
		.all() as Array<{
		name: string;
		pid: number | null;
		capability: string;
		taskId: string;
		parentName: string | null;
		branch: string;
		depth: number;
	}>;

	const zombies: string[] = [];

	for (const agent of active) {
		// No PID recorded or PID is dead → zombie
		if (agent.pid == null || !isPidAlive(agent.pid)) {
			// Check if the agent already sent completion mail — if so, the process
			// exited successfully but the DB status update didn't flush in time.
			// Mark as 'completed' instead of incorrectly flagging as failed.
			const completionMail = db
				.prepare("SELECT id FROM mail WHERE from_agent = ? AND type = 'done' LIMIT 1")
				.get(agent.name) as { id: number } | null;

			if (completionMail) {
				db.prepare(
					"UPDATE agents SET status = 'completed', updated_at = datetime('now') WHERE name = ?",
				).run(agent.name);

				emit("agent.completed", `Agent "${agent.name}" reconciled as completed (completion mail found, PID ${agent.pid ?? "none"} exited)`, {
					agent: agent.name,
				});

				// Update task — only if no other agents for this task are still active
				const remainingCompleted = db
					.prepare(
						"SELECT COUNT(*) as count FROM agents WHERE task_id = ? AND name != ? AND status IN ('running', 'spawning')",
					)
					.get(agent.taskId, agent.name) as { count: number };
				if (remainingCompleted.count === 0) {
					updateTask(agent.taskId, { status: "completed" });
				}
				markRead(completionMail.id);
			} else {
				db.prepare(
					"UPDATE agents SET status = 'failed', updated_at = datetime('now') WHERE name = ?",
				).run(agent.name);

				emit("agent.failed", `Agent "${agent.name}" detected as zombie (PID ${agent.pid ?? "none"} not alive)`, {
					agent: agent.name,
				});

				const recipient = agent.parentName ?? "orchestrator";
				sendMail({
					from: agent.name,
					to: recipient,
					subject: `Agent ${agent.name} died (zombie detected)`,
					body: `Process (PID ${agent.pid ?? "none"}) is no longer alive but DB still showed running. Auto-marked as failed. Capability: ${agent.capability}, task: ${agent.taskId}.`,
					type: "error",
				});

				// Update task — only if no other agents for this task are still active
				const remainingFailed = db
					.prepare(
						"SELECT COUNT(*) as count FROM agents WHERE task_id = ? AND name != ? AND status IN ('running', 'spawning')",
					)
					.get(agent.taskId, agent.name) as { count: number };
				if (remainingFailed.count === 0) {
					updateTask(agent.taskId, { status: "failed" });
				}

				// Auto-retry only genuinely failed agents (no completion mail)
				const task = getTask(agent.taskId);
				if (task) {
					maybeRetryAgent({
						taskId: agent.taskId,
						name: agent.name,
						capability: agent.capability as AgentCapability,
						baseBranch: "main",
						taskDescription: task.description,
						parentName: agent.parentName,
						depth: agent.depth,
					}).catch(() => {
						// Retry errors are already handled inside maybeRetryAgent
					});
				}
			}

			zombies.push(agent.name);
		}
	}

	return zombies;
}

/** Stop a running agent */
export async function stopAgent(name: string): Promise<void> {
	const agent = getAgent(name);
	if (!agent) throw new Error(`Agent "${name}" not found`);
	if (agent.status !== "running" && agent.status !== "spawning") {
		throw new Error(`Agent "${name}" is not running (status: ${agent.status})`);
	}

	// Kill the process
	if (agent.pid) {
		try {
			process.kill(agent.pid, "SIGTERM");
		} catch {
			// Process may already be gone
		}
	}

	const db = getDb();
	db.prepare("UPDATE agents SET status = 'stopped', updated_at = datetime('now') WHERE name = ?").run(name);

	emit("agent.stopped", `Agent "${name}" was stopped`, { agent: name });

	// Update task — mark as failed if no other agents for this task are still active
	const remainingStopped = db
		.prepare(
			"SELECT COUNT(*) as count FROM agents WHERE task_id = ? AND name != ? AND status IN ('running', 'spawning')",
		)
		.get(agent.taskId, name) as { count: number };
	if (remainingStopped.count === 0) {
		updateTask(agent.taskId, { status: "failed" });
		// Release task lock when no more agents are working on it
		try { releaseTask(agent.taskId); } catch { /* task may not exist */ }
	}

	// Cascade stop: stop all running children of this agent
	const children = db
		.prepare("SELECT name FROM agents WHERE parent_name = ? AND status IN ('running', 'spawning')")
		.all(name) as { name: string }[];
	for (const child of children) {
		try {
			await stopAgent(child.name);
		} catch {
			// Child may have already exited
		}
	}
}

/** Clean up a stopped/completed agent's worktree */
export async function cleanAgent(name: string): Promise<void> {
	const agent = getAgent(name);
	if (!agent) throw new Error(`Agent "${name}" not found`);
	if (agent.status === "running" || agent.status === "spawning") {
		throw new Error(`Agent "${name}" is still active. Stop it first.`);
	}

	// Forward any unread mail addressed to this agent to the orchestrator
	// so the orchestrator can pick up orphaned work or completion reports
	const unread = checkMail(name);
	for (const msg of unread) {
		sendMail({
			from: msg.from,
			to: "orchestrator",
			subject: msg.subject,
			body: `[forwarded from dead lead: ${name}]\n\n${msg.body}`,
			type: msg.type,
		});
		markRead(msg.id);
	}

	await removeWorktree(name);

	const db = getDb();
	db.prepare("UPDATE agents SET status = 'cleaned', updated_at = datetime('now') WHERE name = ?").run(name);
}
