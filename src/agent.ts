/** Agent spawning and lifecycle management */

import { existsSync } from "node:fs";
import { getDb } from "./db.ts";
import { emit } from "./events.ts";
import { sendMail, checkMail, markRead } from "./mail.ts";
import { queryMemories, renderMemories, markUsed } from "./memory.ts";
import { getTask, incrementRetryCount, updateTask } from "./tasks.ts";
import type { Agent, AgentCapability, AgentStatus, SpawnResult } from "./types.ts";
import { resolveModel, resolveEffort } from "./models.ts";
import { createWorktree, removeWorktree } from "./worktree.ts";
import { installAgentHooks } from "./hooks.ts";
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

// System prompts are now in templates/*.md.tmpl — loaded via src/templates.ts

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

		// Gather context in parallel: memories, sibling info, and prior work
		// (these are sync DB queries but grouped for clarity and future async readiness)
		const memories = queryTaskRelevantMemories(opts.taskDescription);
		const memoryBlock = renderMemories(memories);
		if (memories.length > 0) {
			markUsed(memories.map((m) => m.id));
		}
		const siblingBlock = opts.parentName
			? buildSiblingBlock(opts.parentName, opts.name)
			: "";
		const priorWorkBlock = buildPriorWorkBlock(opts.taskId, opts.name);

		// Build the prompt from overlay templates
		const prompt = buildPrompt(
			opts.capability,
			opts.taskDescription,
			opts.name,
			memoryBlock,
			siblingBlock,
			priorWorkBlock,
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
		const args = [
			"claude",
			"-p",
			"--model",
			model,
			"--effort",
			effort,
			"--allowedTools",
			ALLOWED_TOOLS[opts.capability] ?? "",
			"--dangerously-skip-permissions",
		];

		proc = Bun.spawn(args, {
			cwd: worktreePath,
			stdout: Bun.file(`${logDir}/stdout.txt`),
			stderr: Bun.file(`${logDir}/stderr.log`),
			stdin: Bun.file(promptFile),
			env: { ...process.env, PATH: process.env.PATH, CLAUDECODE: "", GROVE_AGENT: "1" },
		});

		pid = proc.pid;

		// Update agent with PID and mark running
		db.prepare("UPDATE agents SET pid = ?, status = 'running', updated_at = datetime('now') WHERE name = ?").run(
			pid,
			opts.name,
		);
	} catch (err) {
		// Rollback: clean up DB entry and worktree on spawn failure
		if (dbInserted) {
			try { db.prepare("DELETE FROM agents WHERE name = ?").run(opts.name); } catch { /* best-effort */ }
		}
		if (worktreeCreated) {
			try { await removeWorktree(opts.name); } catch { /* best-effort */ }
		}
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
	const timeoutMs = CAPABILITY_TIMEOUTS[opts.capability];
	const HEARTBEAT_INTERVAL_MS = 60_000;
	let lastHeartbeatAt = Date.now();

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
				getDb()
					.prepare("UPDATE agents SET last_activity_at = datetime('now') WHERE name = ? AND status IN ('running', 'spawning')")
					.run(opts.name);
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
				// Check timeout: has the agent been silent too long?
				const agent = getAgent(opts.name);
				if (!agent || agent.status !== "running") return;
				const activityTs = agent.lastActivityAt ?? agent.createdAt;
				const silenceMs = now - new Date(activityTs.endsWith("Z") ? activityTs : activityTs + "Z").getTime();
				if (silenceMs > timeoutMs) {
					clearInterval(activityPoller);
					// Kill the process
					if (agent.pid) {
						try { process.kill(agent.pid, "SIGTERM"); } catch { /* already gone */ }
					}
					getDb()
						.prepare("UPDATE agents SET status = 'failed', updated_at = datetime('now') WHERE name = ?")
						.run(opts.name);
					emit("agent.failed", `Agent "${opts.name}" timed out after ${timeoutMs / 60_000}min with no output`, { agent: opts.name });
					const recipient = opts.parentName ?? "orchestrator";
					sendMail({
						from: opts.name,
						to: recipient,
						subject: `Agent ${opts.name} timed out`,
						body: `Auto-stopped after ${timeoutMs / 60_000} minutes with no output. Capability: ${opts.capability}.`,
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

/** Build the full prompt for an agent using overlay templates */
function buildPrompt(
	capability: AgentCapability,
	taskDescription: string,
	agentName: string,
	memoryBlock: string,
	siblingBlock: string,
	priorWorkBlock: string,
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

	emit("agent.spawn", `Auto-retrying task "${opts.taskId}" (attempt ${newCount}/${MAX_RETRIES}) as "${retryName}"`, {
		agent: retryName,
		detail: `previous=${opts.name} retry=${newCount}`,
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
