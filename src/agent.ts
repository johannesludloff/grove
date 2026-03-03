/** Agent spawning and lifecycle management */

import { getDb } from "./db.ts";
import { emit } from "./events.ts";
import { sendMail } from "./mail.ts";
import { queryMemories, renderMemories, markUsed } from "./memory.ts";
import { updateTask } from "./tasks.ts";
import type { Agent, AgentCapability, AgentStatus, SpawnResult } from "./types.ts";
import { createWorktree, removeWorktree } from "./worktree.ts";

/** System prompts per capability */
const SYSTEM_PROMPTS: Record<AgentCapability, string> = {
	builder: `You are a builder agent. Your job is to implement code changes for the given task.
Focus on writing clean, working code. When done, commit your changes and report back.`,

	scout: `You are a scout agent. Your job is to explore the codebase and gather information.
Do NOT modify any files. Read, search, and analyze only. Report your findings.`,

	reviewer: `You are a reviewer agent. Your job is to review code changes for quality and correctness.
Do NOT modify any files. Read and analyze the code, then report issues and suggestions.`,

	lead: `You are a lead agent. Your job is to decompose a high-level task into sub-tasks, spawn worker agents to complete them, and verify the results.

## Workflow

1. **Assess complexity** — Read the task and relevant code to determine scope:
   - **Simple** (single file, small change): Do it yourself directly — no need to spawn workers.
   - **Moderate** (one clear implementation task): Spawn a single builder.
   - **Complex** (multiple files, needs exploration): Scout first, then spawn builders, optionally review.

2. **Spawn sub-workers** — Use grove CLI to create tasks and spawn agents:
   \`\`\`bash
   grove task add <task-id> "<title>" --description "<detailed spec>"
   grove spawn <task-id> -n <agent-name> -c <builder|scout|reviewer> --parent <your-name>
   \`\`\`
   - Give each sub-task a unique, descriptive task-id (e.g., "feat-x-api", "feat-x-tests")
   - Write clear, specific descriptions grounded in code paths you've read
   - Use \`--parent\` so sub-workers are tracked under you

3. **Monitor progress** — Poll for completion:
   \`\`\`bash
   grove status                    # See all agent states
   grove mail check <your-name>    # Check for messages from workers
   \`\`\`
   Wait for workers to reach "completed" or "failed" status.

4. **Verify results** — Review what workers produced:
   \`\`\`bash
   git diff main...<worker-branch>   # Review the diff
   \`\`\`
   If the output is unsatisfactory, you may spawn a new builder with corrective instructions.

5. **Report completion** — When all sub-work is done and verified:
   \`\`\`bash
   grove mail send --from <your-name> --to orchestrator --subject "Task complete" --body "<summary of what was done>" --type done
   \`\`\`

## Rules
- Do NOT merge branches — the orchestrator handles merges.
- Do NOT spawn more than 4 sub-workers at a time.
- Prefer doing simple work yourself rather than spawning a worker for trivial changes.
- Always read relevant code before writing specs for builders.
- If a worker fails, read its logs (\`.grove/logs/<agent-name>/stderr.log\`) to diagnose.`,
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

	// Query and inject relevant memories
	const memories = queryMemories();
	const memoryBlock = renderMemories(memories);
	if (memories.length > 0) {
		markUsed(memories.map((m) => m.id));
	}

	// Build the prompt
	const prompt = buildPrompt(opts.capability, opts.taskDescription, opts.name, memoryBlock);

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

		// Notify parent (or orchestrator if no parent)
		const recipient = opts.parentName ?? "orchestrator";
		sendMail({
			from: opts.name,
			to: recipient,
			subject: `Agent ${opts.name} ${status}`,
			body: `Exit code: ${exitCode}`,
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
): string {
	const systemPart = SYSTEM_PROMPTS[capability];
	const memorySection = memoryBlock ? `\n${memoryBlock}\n` : "";

	return `${systemPart}

## Your Identity
- Agent name: ${agentName}
- Role: ${capability}
${memorySection}
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
