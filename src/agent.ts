/** Agent spawning and lifecycle management */

import { existsSync } from "node:fs";
import { getDb } from "./db.ts";
import { emit } from "./events.ts";
import { sendMail } from "./mail.ts";
import { queryMemories, renderMemories, markUsed } from "./memory.ts";
import { updateTask } from "./tasks.ts";
import type { Agent, AgentCapability, AgentStatus, SpawnResult } from "./types.ts";
import { createWorktree, removeWorktree } from "./worktree.ts";

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
const SYSTEM_PROMPTS: Record<AgentCapability, string> = {
	builder: `You are a builder agent. Your job is to implement code changes for the given task.
Focus on writing clean, working code. When done, commit your changes and report back.`,

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

	lead: `You are a lead agent. Your job is to decompose a high-level task into sub-tasks, spawn worker agents to complete them, and verify the results.

## Delegation Reasoning (REQUIRED)

Before every action, log your reasoning explicitly in your output:
- "**Handling directly** because <reason (e.g. single-file change, trivial fix, code already read)>."
- "**Spawning <capability>** for <subtask> because <reason (e.g. multi-step, scope unclear, need ground truth)>."

This must appear in your output before each delegation decision. The orchestrator uses this to audit your choices.

## Workflow

1. **Assess complexity** — Determine scope before touching any code:
   - **Simple** (single file, trivial change in <5 lines, code already read): Do it yourself. Log: "**Handling directly** because <reason>."
   - **Moderate** (one clear task, exact files known): Spawn a single builder. Log: "**Spawning builder** for <subtask> because <reason>."
   - **Complex** (multiple files, unclear scope, or code not yet read): **Spawn a scout first. Always.** Log: "**Spawning scout** for <subtask> because <reason>."

   > **Spawn bias**: Default to spawning builders or scouts for non-trivial work. Only self-handle if the change is <5 lines and you have already read all affected files.

   > **Scout bias**: When in doubt, scout. Scouts are fast, read-only, and free you to plan concurrently. Writing a builder spec without scouting first produces vague specs and broken builds.

2. **Phase 1 — Scout** (skip only if you already know the exact files and changes needed):
   \`\`\`bash
   grove task add scout-<topic> "Scout <topic>" --description "<what to find: file paths, patterns, interfaces>"
   grove spawn scout-<topic> -n <name>-scout -c scout --parent <your-name>
   \`\`\`
   Wait for scout mail, then use its findings to write precise builder specs.

3. **Phase 2 — Build** — Spawn builders grounded in scout findings:
   \`\`\`bash
   grove task add <task-id> "<title>" --description "<detailed spec with exact file paths from scout>"
   grove spawn <task-id> -n <agent-name> -c builder --parent <your-name>
   \`\`\`
   - Give each sub-task a unique, descriptive task-id (e.g., "feat-x-api", "feat-x-tests")
   - Write clear, specific descriptions grounded in code paths the scout found
   - Use \`--parent\` so sub-workers are tracked under you

4. **Phase 3 — Review** (optional but recommended for complex changes):
   \`\`\`bash
   grove spawn <review-task-id> -n <name>-reviewer -c reviewer --parent <your-name>
   \`\`\`
   Reviewers report PASS or FAIL. If FAIL, spawn a corrective builder (max 3 revision attempts before escalating).

5. **Monitor progress** — Poll for completion:
   \`\`\`bash
   grove status                    # See all agent states
   grove mail check <your-name>    # Check for messages from workers
   \`\`\`
   Wait for workers to reach "completed" or "failed" status.

6. **Verify results** — Review what workers produced:
   \`\`\`bash
   git diff main...<worker-branch>   # Review the diff
   \`\`\`

7. **Record learnings** — Before reporting done, record key findings:
   \`\`\`bash
   grove memory add <domain> <type> "<one sentence>"
   \`\`\`

8. **Report completion** — When all sub-work is done and verified:
   \`\`\`bash
   grove mail send --from <your-name> --to orchestrator --subject "Task complete" --body "<summary>" --type done
   \`\`\`

   Your completion report MUST include a **Sub-agent Activity Summary**:
   \`\`\`
   ## Sub-agent Activity
   - Spawned: <agent-name> (<capability>) — <why spawned>
   - Handled directly: <subtask> — <why self-handled>
   \`\`\`

## Rules
- Do NOT merge branches — the orchestrator handles merges.
- Do NOT spawn more than 4 sub-workers at a time.
- Prefer spawning builders/scouts over self-handling non-trivial work.
- Always ground builder specs in code paths you (or a scout) have actually read.
- If a worker fails, read its logs (\`.grove/logs/<agent-name>/stderr.log\`) to diagnose.
- Cap builder revisions at 3 — if a builder fails review 3 times, escalate via mail to orchestrator.

## Named Failure Modes (avoid these)
- **SPEC_WITHOUT_SCOUT** — Writing a builder spec without reading the relevant code first. Produces vague specs and broken builds.
- **SCOUT_SKIP** — Skipping scouts for complex multi-file tasks to save time. Always costs more time downstream.
- **UNNECESSARY_SPAWN** — Spawning an agent for a task small enough to do in 3 lines. Overhead exceeds benefit.
- **SILENT_FAILURE** — Not mailing the orchestrator when blocked or when a worker fails after 3 retries.
- **INFINITE_REVISION** — Retrying a builder more than 3 times without escalating.
- **SILENT_DELEGATION** — Not logging delegation reasoning before each action. The orchestrator cannot audit what the lead did or why.`,
};

/** Tool restrictions per capability */
const ALLOWED_TOOLS: Record<AgentCapability, string> = {
	builder: "Bash,Read,Write,Edit,Glob,Grep",
	scout: "Bash,Read,Glob,Grep",
	reviewer: "Bash,Read,Glob,Grep",
	lead: "Bash,Read,Write,Edit,Glob,Grep",
};

/** Spawn a new Claude Code agent in a worktree */
export async function spawnAgent(opts: {
	name: string;
	capability: AgentCapability;
	taskId: string;
	taskDescription: string;
	baseBranch: string;
	model?: string;
	parentName?: string;
}): Promise<SpawnResult> {
	const db = getDb();

	// Check for name conflicts
	const existing = db
		.prepare("SELECT id FROM agents WHERE name = ? AND status IN ('spawning', 'running')")
		.get(opts.name);
	if (existing) {
		throw new Error(`Agent "${opts.name}" is already active`);
	}

	// Create worktree
	const { worktreePath, branch } = await createWorktree(opts.name, opts.baseBranch);

	// Register agent in DB
	const stmt = db.prepare(`
		INSERT INTO agents (name, capability, status, worktree, branch, task_id, parent_name)
		VALUES (?, ?, 'spawning', ?, ?, ?, ?)
	`);
	stmt.run(
		opts.name,
		opts.capability,
		worktreePath,
		branch,
		opts.taskId,
		opts.parentName ?? null,
	);

	// Query and inject relevant memories (task-aware filtering)
	const memories = queryTaskRelevantMemories(opts.taskDescription);
	const memoryBlock = renderMemories(memories);
	if (memories.length > 0) {
		markUsed(memories.map((m) => m.id));
	}

	// Build sibling context
	const siblingBlock = opts.parentName
		? buildSiblingBlock(opts.parentName, opts.name)
		: "";

	// Build prior work context
	const priorWorkBlock = buildPriorWorkBlock(opts.taskId, opts.name);

	// Build the prompt
	const prompt = buildPrompt(
		opts.capability,
		opts.taskDescription,
		opts.name,
		memoryBlock,
		siblingBlock,
		priorWorkBlock,
	);

	// Write prompt to a file and pipe via stdin (avoids Windows arg length limits)
	const logDir = `${process.cwd()}/.grove/logs/${opts.name}`;
	await Bun.write(`${logDir}/.keep`, "");

	const promptFile = `${logDir}/prompt.txt`;
	await Bun.write(promptFile, prompt);

	const model = opts.model ?? "sonnet";
	const args = [
		"claude",
		"-p",
		"--model",
		model,
		"--allowedTools",
		ALLOWED_TOOLS[opts.capability] ?? "",
		"--dangerously-skip-permissions",
	];

	const proc = Bun.spawn(args, {
		cwd: worktreePath,
		stdout: Bun.file(`${logDir}/stdout.txt`),
		stderr: Bun.file(`${logDir}/stderr.log`),
		stdin: Bun.file(promptFile),
		env: { ...process.env, PATH: process.env.PATH, CLAUDECODE: "" },
	});

	const pid = proc.pid;

	// Update agent with PID and mark running
	db.prepare("UPDATE agents SET pid = ?, status = 'running', updated_at = datetime('now') WHERE name = ?").run(
		pid,
		opts.name,
	);

	emit("agent.spawn", `Spawned ${opts.capability} agent "${opts.name}" on ${branch}`, {
		agent: opts.name,
		detail: `task=${opts.taskId} pid=${pid}`,
	});

	// Update task assignment
	updateTask(opts.taskId, { status: "in_progress", assignedTo: opts.name });

	// Watch for process exit in the background
	// Use getDb() instead of captured `db` — the CLI's postAction hook closes
	// the original connection before this callback fires.
	proc.exited.then(async (exitCode) => {
		const liveDb = getDb();
		const status: AgentStatus = exitCode === 0 ? "completed" : "failed";
		liveDb
			.prepare("UPDATE agents SET status = ?, updated_at = datetime('now') WHERE name = ?")
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

		// Update task
		updateTask(opts.taskId, {
			status: status === "completed" ? "completed" : "failed",
		});
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
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	return { agent, pid };
}

/** Build the full prompt for an agent */
function buildPrompt(
	capability: AgentCapability,
	taskDescription: string,
	agentName: string,
	memoryBlock: string,
	siblingBlock: string,
	priorWorkBlock: string,
): string {
	const systemPart = SYSTEM_PROMPTS[capability];
	const memorySection = memoryBlock ? `\n${memoryBlock}\n` : "";
	const siblingSection = siblingBlock ? `\n${siblingBlock}\n` : "";
	const priorWorkSection = priorWorkBlock ? `\n${priorWorkBlock}\n` : "";

	return `${systemPart}

## Your Identity
- Agent name: ${agentName}
- Role: ${capability}
${memorySection}${siblingSection}${priorWorkSection}
## Your Task
${taskDescription}

## Instructions
- You MUST complete the task described above. Do not ask for clarification — just do it.
- Work only within your current directory (this is a git worktree).
- Read existing files first to understand the codebase before making changes.
- When done, commit all your changes with a descriptive message.
- Be concise in your output.

## Recording Learnings
When you discover something worth remembering for future agents, run:
\`\`\`bash
grove memory add <domain> <type> "<content>"
\`\`\`
- **domain**: topic area (e.g. "auth", "database", "testing", "api")
- **type**: convention | pattern | failure | decision | fact
- **content**: one concise sentence describing the learning

Examples:
\`\`\`bash
grove memory add testing convention "Tests use vitest, not jest"
grove memory add database pattern "All queries use prepared statements with parameterized inputs"
grove memory add auth failure "JWT tokens must be refreshed before API calls or they silently fail"
\`\`\`

Only record things that would genuinely help a future agent. Keep each entry to one sentence.`;
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

/** Get an agent by name */
export function getAgent(name: string): Agent | null {
	const db = getDb();
	return db
		.prepare(
			`SELECT id, name, capability, status, pid, worktree, branch,
			        task_id as taskId, parent_name as parentName,
			        created_at as createdAt, updated_at as updatedAt
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
			        task_id as taskId, parent_name as parentName,
			        created_at as createdAt, updated_at as updatedAt
		   FROM agents ${where} ORDER BY created_at DESC`,
		)
		.all(...params) as Agent[];
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

	await removeWorktree(name);
}
