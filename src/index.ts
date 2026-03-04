#!/usr/bin/env bun
/** Grove — Windows-native multi-agent orchestrator for Claude Code */

import { Command } from "commander";
import { closeDb, groveDir, initDb } from "./db.ts";
import { getCurrentBranch } from "./worktree.ts";
import { existsSync } from "node:fs";
import { createTask, getTask, listTasks } from "./tasks.ts";
import { spawnAgent, stopAgent, listAgents, cleanAgent } from "./agent.ts";
import { sendMail, checkMail, markRead, listMail } from "./mail.ts";
import { addMemory, listMemories, removeMemory } from "./memory.ts";
import { startDashboard } from "./dashboard.ts";
import { startFeed, showRecentEvents } from "./feed.ts";
import { enqueue, updateStatus } from "./merge-queue.ts";
import { resolve } from "./merge-resolver.ts";
import { prime } from "./prime.ts";
import { installHooks, uninstallHooks, statusHooks } from "./hooks.ts";
import type { AgentCapability, MailType, TaskStatus, MergeTier } from "./types.ts";
import type { MemoryType } from "./memory.ts";

const program = new Command();

program
	.name("grove")
	.description("Windows-native multi-agent orchestrator for Claude Code")
	.version("0.1.0");

// ── grove init ──────────────────────────────────────────────────────────
program
	.command("init")
	.description("Initialize .grove/ in the current project")
	.action(async () => {
		if (existsSync(groveDir())) {
			console.log("Grove already initialized.");
			return;
		}

		initDb();
		const branch = await getCurrentBranch();
		await Bun.write(`${groveDir()}/base-branch.txt`, branch);

		// Install Claude Code hooks for SessionStart/UserPromptSubmit integration
		await installHooks(process.cwd());

		// Write orchestrator instructions to CLAUDE.md
		const groveSection = `<!-- grove:start -->
# Grove — Multi-Agent Orchestrator

**You are an orchestrator. NEVER edit project files directly. Immediately delegate ALL work to agents and stay available for new input.**

NEVER use Read, Glob, Grep, or Bash to explore project files yourself. ALL exploration must go through scout agents.

## Core Rule

When the user gives you a task:
1. Create the task: \`grove task add <id> "<title>" --description "<detailed spec>"\`
2. Spawn an agent: \`grove spawn <task-id> -n <name> -c <capability>\`
3. Briefly confirm what you dispatched, then **stop and wait for the user's next input**

Do NOT poll, loop, or block waiting for agents to finish. Agents report back via mail — you'll see their messages automatically on your next turn (the \`UserPromptSubmit\` hook injects unread mail).

## Agent Capabilities

| Flag | Role | When to Use |
|------|------|-------------|
| \`-c builder\` | Implement code | Single-file or focused changes with clear instructions |
| \`-c scout\` | Read-only explore | Need codebase analysis before deciding what to build |
| \`-c reviewer\` | Read-only review | Validate an agent's completed work |
| \`-c lead\` | Autonomous coordinator | **Default for most tasks.** Decomposes work, spawns sub-agents, verifies results |

**Prefer \`-c lead\` for any task that is non-trivial.** Leads handle their own scout → build → review cycle. Only use \`-c builder\` when the task is simple and you can write a complete spec yourself in one sentence.

## Reacting to Agent Mail

When you see agent completion mail injected before your turn:
1. Run \`grove merge --all\` to integrate all completed branches
2. Run \`grove clean\` to remove finished worktrees
3. Report the results to the user
4. If any agents failed, read their logs (\`.grove/logs/<name>/stderr.log\`) and decide whether to retry

## Spawning Examples

\`\`\`bash
# Complex feature — use a lead
grove task add auth-system "Implement user authentication with JWT" --description "Add login/signup endpoints, middleware, and tests"
grove spawn auth-system -n auth-lead -c lead

# Simple fix — use a builder directly
grove task add fix-typo "Fix typo in README.md" --description "Change 'recieve' to 'receive' on line 42"
grove spawn fix-typo -n fix-typo-builder -c builder

# Need to understand code first — use a scout
grove task add explore-api "Map all API endpoints and their handlers" --description "List every route, its HTTP method, handler file, and middleware"
grove spawn explore-api -n api-scout -c scout
\`\`\`

## Command Reference

| Command | Description |
|---------|-------------|
| \`grove task add <id> <title> [-d "<desc>"]\` | Create a task |
| \`grove spawn <task-id> -n <name> -c <cap>\` | Spawn agent (builder/scout/reviewer/lead) |
| \`grove status\` | Show all agents and their state |
| \`grove merge --all\` | Merge all completed agent branches |
| \`grove merge --branch <name>\` | Merge a specific branch |
| \`grove mail check orchestrator\` | Check for agent messages (auto-injected by hook) |
| \`grove stop <name>\` | Stop a running agent |
| \`grove clean\` | Remove finished worktrees |
| \`grove dashboard\` | Live TUI dashboard |
| \`grove feed\` | Stream event feed |
| \`grove memory add <domain> <type> <content>\` | Record a learning |

## Conventions

- **NEVER edit project files directly** — all changes happen in agent worktrees
- Each agent owns its worktree exclusively
- Leads spawn their own sub-agents — you do not need to micromanage them
- After merging, always \`grove clean\` to free disk space
- When multiple independent tasks arrive, spawn multiple agents in parallel
<!-- grove:end -->
`;

		const claudeMdPath = `${process.cwd()}/CLAUDE.md`;
		if (existsSync(claudeMdPath)) {
			const existing = await Bun.file(claudeMdPath).text();
			// Replace existing grove section or append
			const grovePattern = /<!-- grove:start -->[\s\S]*?<!-- grove:end -->\n?/;
			if (grovePattern.test(existing)) {
				await Bun.write(claudeMdPath, existing.replace(grovePattern, groveSection));
			} else {
				await Bun.write(claudeMdPath, `${existing}\n${groveSection}`);
			}
		} else {
			await Bun.write(claudeMdPath, groveSection);
		}

		console.log(`Initialized .grove/ (base branch: ${branch})`);
		console.log("Installed hooks → .claude/settings.local.json");
		console.log("Created CLAUDE.md");
	});

// ── grove prime ─────────────────────────────────────────────────────────
program
	.command("prime")
	.description("Print orchestrator context (used by SessionStart hook)")
	.action(() => {
		prime();
	});

// ── grove hooks ─────────────────────────────────────────────────────────
const hooksCmd = program.command("hooks").description("Manage Claude Code hook integration");

hooksCmd
	.command("install")
	.description("Install grove hooks into .claude/settings.local.json")
	.option("-f, --force", "Overwrite existing hooks entries entirely")
	.action(async (opts: { force?: boolean }) => {
		await installHooks(process.cwd(), opts.force);
		console.log("Hooks installed → .claude/settings.local.json");
	});

hooksCmd
	.command("uninstall")
	.description("Remove grove hooks from .claude/settings.local.json")
	.action(async () => {
		await uninstallHooks(process.cwd());
		console.log("Hooks removed from .claude/settings.local.json");
	});

hooksCmd
	.command("status")
	.description("Check if grove hooks are installed")
	.action(() => {
		const installed = statusHooks(process.cwd());
		console.log(installed ? "Hooks installed." : "Hooks not installed.");
	});

// ── grove task ──────────────────────────────────────────────────────────
const taskCmd = program.command("task").description("Manage tasks");

taskCmd
	.command("add")
	.argument("<task-id>", "Unique task identifier")
	.argument("<title>", "Task title")
	.option("-d, --description <text>", "Task description")
	.action((taskId: string, title: string, opts: { description?: string }) => {
		const task = createTask({ taskId, title, description: opts.description });
		console.log(`Created task: ${task.taskId} — ${task.title}`);
	});

taskCmd
	.command("list")
	.option("-s, --status <status>", "Filter by status")
	.action((opts: { status?: string }) => {
		const tasks = listTasks(opts.status as TaskStatus | undefined);
		if (tasks.length === 0) {
			console.log("No tasks.");
			return;
		}
		for (const t of tasks) {
			const assignee = t.assignedTo ? ` → ${t.assignedTo}` : "";
			console.log(`  [${t.status}] ${t.taskId}: ${t.title}${assignee}`);
		}
	});

// ── grove spawn ─────────────────────────────────────────────────────────
program
	.command("spawn")
	.description("Spawn a new agent")
	.argument("<task-id>", "Task to work on")
	.requiredOption("-n, --name <name>", "Unique agent name")
	.option("-c, --capability <type>", "builder | scout | reviewer | lead", "builder")
	.option("-m, --model <model>", "Claude model to use", "sonnet")
	.option("--parent <name>", "Parent agent name")
	.action(
		async (
			taskId: string,
			opts: { name: string; capability: string; model: string; parent?: string },
		) => {
			const task = getTask(taskId);
			if (!task) {
				console.error(`Task "${taskId}" not found. Create it first: grove task add ${taskId} "title"`);
				process.exit(1);
			}

			const baseBranch = (await Bun.file(`${groveDir()}/base-branch.txt`).text()).trim();

			const result = await spawnAgent({
				name: opts.name,
				capability: opts.capability as AgentCapability,
				taskId,
				taskDescription: `${task.title}\n\n${task.description}`,
				baseBranch,
				model: opts.model,
				parentName: opts.parent,
			});

			console.log(`Spawned agent: ${result.agent.name} (PID ${result.pid})`);
			console.log(`  Capability: ${result.agent.capability}`);
			console.log(`  Branch: ${result.agent.branch}`);
			console.log(`  Worktree: ${result.agent.worktree}`);
		},
	);

// ── grove stop ──────────────────────────────────────────────────────────
program
	.command("stop")
	.description("Stop a running agent")
	.argument("<name>", "Agent name")
	.action(async (name: string) => {
		await stopAgent(name);
		console.log(`Stopped agent: ${name}`);
	});

// ── grove status ────────────────────────────────────────────────────────
program
	.command("status")
	.description("Show all agents and their state")
	.action(() => {
		const agents = listAgents();
		if (agents.length === 0) {
			console.log("No agents.");
			return;
		}
		console.log("Agents:");

		const childrenMap = new Map<string, typeof agents>();
		const roots: typeof agents = [];

		for (const a of agents) {
			if (a.parentName) {
				const siblings = childrenMap.get(a.parentName) ?? [];
				siblings.push(a);
				childrenMap.set(a.parentName, siblings);
			}
		}

		// agents are already sorted DESC by created_at; roots keep that order
		const rootNames = new Set<string>();
		for (const a of agents) {
			if (!a.parentName) {
				roots.push(a);
				rootNames.add(a.name);
			}
		}

		// Orphaned children (parent not in agents list) treated as roots
		for (const a of agents) {
			if (a.parentName && !rootNames.has(a.parentName) && !childrenMap.has(a.name)) {
				roots.push(a);
			}
		}

		const fmt = (a: (typeof agents)[0], prefix: string) => {
			const pid = a.pid ? ` (PID ${a.pid})` : "";
			console.log(`${prefix}[${a.status}] ${a.name} — ${a.capability} on ${a.branch}${pid}`);
		};

		for (const root of roots) {
			fmt(root, "  ");
			const children = (childrenMap.get(root.name) ?? []).slice().sort(
				(x, y) => new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime(),
			);
			for (const child of children) {
				fmt(child, "    └─ ");
			}
		}
	});

// ── grove dashboard ─────────────────────────────────────────────────────
program
	.command("dashboard")
	.description("Live TUI dashboard for agent monitoring")
	.option("-i, --interval <ms>", "Poll interval in milliseconds (min: 500)", "2000")
	.action((opts: { interval: string }) => {
		const interval = Math.max(500, Number(opts.interval) || 2000);
		startDashboard(interval);
	});

// ── grove feed ──────────────────────────────────────────────────────────
program
	.command("feed")
	.description("Show a live stream of grove events")
	.option("-f, --follow", "Follow new events in real time (like tail -f)")
	.option("-i, --interval <ms>", "Poll interval in milliseconds when following (min: 500)", "1000")
	.option("-l, --limit <n>", "Number of recent events to show", "30")
	.action((opts: { follow?: boolean; interval: string; limit: string }) => {
		const limit = Math.max(1, Number(opts.limit) || 30);
		const interval = Math.max(500, Number(opts.interval) || 1000);

		if (opts.follow) {
			startFeed({ limit, interval });
		} else {
			showRecentEvents(limit);
		}
	});

// ── grove mail ──────────────────────────────────────────────────────────
const mailCmd = program.command("mail").description("Inter-agent messaging");

mailCmd
	.command("send")
	.requiredOption("--from <name>", "Sender agent")
	.requiredOption("--to <name>", "Recipient agent")
	.requiredOption("--subject <text>", "Message subject")
	.requiredOption("--body <text>", "Message body")
	.option("--type <type>", "Message type", "status")
	.action((opts: { from: string; to: string; subject: string; body: string; type: string }) => {
		const msg = sendMail({ ...opts, type: opts.type as MailType });
		console.log(`Sent mail #${msg.id}: ${opts.from} → ${opts.to}`);
	});

mailCmd
	.command("check")
	.argument("<name>", "Agent name to check inbox for")
	.action((name: string) => {
		const messages = checkMail(name);
		if (messages.length === 0) {
			console.log("No new messages.");
			return;
		}
		for (const m of messages) {
			console.log(`  #${m.id} [${m.type}] from ${m.from}: ${m.subject}`);
			console.log(`    ${m.body}`);
			markRead(m.id);
		}
	});

mailCmd
	.command("deliver")
	.description("Stop hook: deliver pending orchestrator mail without user prompt")
	.action(async () => {
		// Read stdin JSON from the Stop hook
		const input = await new Response(Bun.stdin.stream()).text();
		let data: { stop_hook_active?: boolean } = {};
		try {
			data = JSON.parse(input) as { stop_hook_active?: boolean };
		} catch {
			// Malformed input — exit silently
			process.exit(0);
		}

		// Anti-loop guard: if we're already continuing due to a stop hook, don't re-trigger
		if (data.stop_hook_active) {
			process.exit(0);
		}

		const messages = checkMail("orchestrator");
		if (messages.length === 0) {
			process.exit(0);
		}

		// Format messages and mark each as read
		const lines: string[] = [`${messages.length} unread message(s) for orchestrator:\n`];
		for (const m of messages) {
			lines.push(`  #${m.id} [${m.type}] from ${m.from}: ${m.subject}`);
			lines.push(`    ${m.body}`);
			markRead(m.id);
		}

		const reason = lines.join("\n");
		process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
	});

mailCmd
	.command("list")
	.option("--from <name>", "Filter by sender")
	.option("--to <name>", "Filter by recipient")
	.option("--unread", "Unread only")
	.action((opts: { from?: string; to?: string; unread?: boolean }) => {
		const messages = listMail(opts);
		if (messages.length === 0) {
			console.log("No messages.");
			return;
		}
		for (const m of messages) {
			const readMark = m.read ? " " : "*";
			console.log(`  ${readMark} #${m.id} [${m.type}] ${m.from} → ${m.to}: ${m.subject}`);
		}
	});

// ── grove memory ────────────────────────────────────────────────────────
const memoryCmd = program.command("memory").description("Persistent agent memory");

memoryCmd
	.command("add")
	.argument("<domain>", "Topic area (e.g. auth, database, testing)")
	.argument("<type>", "convention | pattern | failure | decision | fact")
	.argument("<content>", "One-sentence learning")
	.option("--agent <name>", "Source agent", "orchestrator")
	.action((domain: string, type: string, content: string, opts: { agent: string }) => {
		const memory = addMemory({
			domain,
			type: type as MemoryType,
			content,
			sourceAgent: opts.agent,
		});
		console.log(`Recorded memory #${memory.id}: [${domain}/${type}] ${content}`);
	});

memoryCmd
	.command("list")
	.option("-d, --domain <domain>", "Filter by domain")
	.action((opts: { domain?: string }) => {
		const memories = listMemories(opts);
		if (memories.length === 0) {
			console.log("No memories recorded yet.");
			return;
		}
		console.log("Memories:");
		for (const m of memories) {
			console.log(`  #${m.id} [${m.domain}/${m.type}] ${m.content} (used ${m.useCount}x, by ${m.sourceAgent})`);
		}
	});

memoryCmd
	.command("remove")
	.argument("<id>", "Memory ID to remove")
	.action((id: string) => {
		removeMemory(Number(id));
		console.log(`Removed memory #${id}`);
	});

// ── grove merge ─────────────────────────────────────────────────────────
program
	.command("merge")
	.description("Merge agent branches into the canonical branch")
	.option("-b, --branch <name>", "Merge a specific branch")
	.option("--all", "Merge all completed agent branches")
	.option("--into <branch>", "Target branch (default: read from .grove/base-branch.txt)")
	.option("--dry-run", "Check conflicts only, don't merge")
	.action(
		async (opts: { branch?: string; all?: boolean; into?: string; dryRun?: boolean }) => {
			if (!opts.branch && !opts.all) {
				console.error("Specify --branch <name> or --all");
				process.exit(1);
			}

			const canonicalBranch =
				opts.into ?? (await Bun.file(`${groveDir()}/base-branch.txt`).text()).trim();
			const repoRoot = process.cwd();

			if (opts.dryRun) {
				console.log(`[dry-run] Target branch: ${canonicalBranch}`);
			}

			/** Get files modified in branch relative to canonical */
			async function getModifiedFiles(branchName: string): Promise<string[]> {
				const proc = Bun.spawn(
					["git", "diff", "--name-only", `${canonicalBranch}...${branchName}`],
					{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
				);
				await proc.exited;
				const out = await new Response(proc.stdout).text();
				return out
					.split("\n")
					.map((l) => l.trim())
					.filter(Boolean);
			}

			/** Dry-run a merge: report modified files and conflict status without committing */
			async function dryRunMerge(branchName: string): Promise<void> {
				const filesModified = await getModifiedFiles(branchName);
				console.log(`\n  Branch: ${branchName}`);
				console.log(
					`  Modified files (${filesModified.length}): ${filesModified.join(", ") || "none"}`,
				);

				const mergeProc = Bun.spawn(
					["git", "merge", "--no-commit", "--no-ff", branchName],
					{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
				);
				const mergeCode = await mergeProc.exited;

				if (mergeCode !== 0) {
					// Conflicts detected — list them then abort
					const conflictProc = Bun.spawn(
						["git", "diff", "--name-only", "--diff-filter=U"],
						{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
					);
					await conflictProc.exited;
					const conflictOut = await new Response(conflictProc.stdout).text();
					const conflictFiles = conflictOut
						.split("\n")
						.map((l) => l.trim())
						.filter(Boolean);

					await Bun.spawn(["git", "merge", "--abort"], {
						cwd: repoRoot,
						stdout: "pipe",
						stderr: "pipe",
					}).exited;

					console.log(`  Conflicts (${conflictFiles.length}): ${conflictFiles.join(", ")}`);
				} else {
					// Clean merge — reset staged changes without creating a commit
					await Bun.spawn(["git", "reset", "--merge"], {
						cwd: repoRoot,
						stdout: "pipe",
						stderr: "pipe",
					}).exited;

					console.log("  No conflicts — would merge cleanly");
				}
			}

			/** Enqueue, resolve, and update queue status for a branch */
			async function doMerge(
				branchName: string,
				agentName: string,
				taskId: string,
			): Promise<void> {
				const filesModified = await getModifiedFiles(branchName);
				const entry = enqueue({ branchName, taskId, agentName, filesModified });
				console.log(`\n  Enqueued: ${branchName} (queue #${entry.id})`);

				const result = await resolve({ branchName, canonicalBranch, repoRoot });

				if (result.success) {
					updateStatus(entry.id, "merged", result.tier as MergeTier);
					console.log(`  Merged via ${result.tier}`);
					if (result.conflictFiles.length > 0) {
						console.log(`  Auto-resolved: ${result.conflictFiles.join(", ")}`);
					}
				} else {
					const hasConflicts = result.conflictFiles.length > 0;
					updateStatus(entry.id, hasConflicts ? "conflict" : "failed");
					console.error(`  Failed: ${result.errorMessage}`);
					if (result.conflictFiles.length > 0) {
						console.error(`  Conflicts: ${result.conflictFiles.join(", ")}`);
					}
				}
			}

			if (opts.branch) {
				const agents = listAgents();
				const agent = agents.find((a) => a.branch === opts.branch);
				const agentName = agent?.name ?? opts.branch;
				const taskId = agent?.taskId ?? "manual";

				if (opts.dryRun) {
					await dryRunMerge(opts.branch);
				} else {
					console.log(`Merging ${opts.branch} into ${canonicalBranch}...`);
					await doMerge(opts.branch, agentName, taskId);
				}
			} else {
				// --all
				const agents = listAgents("completed");
				if (agents.length === 0) {
					console.log("No completed agents to merge.");
					return;
				}

				console.log(
					`Processing ${agents.length} completed agent(s) into ${canonicalBranch}...`,
				);
				for (const agent of agents) {
					if (opts.dryRun) {
						await dryRunMerge(agent.branch);
					} else {
						await doMerge(agent.branch, agent.name, agent.taskId);
					}
				}

				console.log("\nDone.");
			}
		},
	);

// ── grove clean ─────────────────────────────────────────────────────────
program
	.command("clean")
	.description("Clean up completed/stopped agent worktrees")
	.argument("[name]", "Specific agent to clean (or all completed)")
	.action(async (name?: string) => {
		if (name) {
			await cleanAgent(name);
			console.log(`Cleaned up agent: ${name}`);
		} else {
			const agents = listAgents();
			let cleaned = 0;
			for (const a of agents) {
				if (a.status === "completed" || a.status === "stopped" || a.status === "failed") {
					try {
						await cleanAgent(a.name);
						cleaned++;
					} catch {
						// Skip if worktree already gone
					}
				}
			}

			// Stop and clean orphaned agents whose parent has failed or stopped
			const deadParents = new Set(
				agents.filter((a) => a.status === "failed" || a.status === "stopped").map((a) => a.name),
			);
			const orphans = agents.filter(
				(a) =>
					(a.status === "running" || a.status === "spawning") &&
					a.parentName != null &&
					deadParents.has(a.parentName),
			);
			for (const orphan of orphans) {
				console.log(`Stopping orphaned agent ${orphan.name} (parent ${orphan.parentName} is ${agents.find((a) => a.name === orphan.parentName)?.status})`);
				try {
					await stopAgent(orphan.name);
					await cleanAgent(orphan.name);
					cleaned++;
				} catch {
					// Skip if already gone
				}
			}

			console.log(`Cleaned ${cleaned} agent worktree(s).`);
		}
	});

// ── grove guard (PreToolUse hook target) ────────────────────────────────
program
	.command("guard")
	.description("PreToolUse hook: block orchestrator from editing project files directly")
	.option("--warn-read", "Emit a non-blocking warning for read-only exploration tools")
	.action(async (opts: { warnRead?: boolean }) => {
		if (opts.warnRead) {
			// Non-blocking warning for Read/Glob/Grep usage
			process.stderr.write(
				"[grove] WARNING: Orchestrator should delegate exploration to scout agents instead of reading files directly.\n",
			);
			process.exit(0);
		}

		// Read the hook's stdin JSON
		const input = await new Response(Bun.stdin.stream()).text();
		let data: { tool_name?: string; tool_input?: { file_path?: string } };
		try {
			data = JSON.parse(input) as { tool_name?: string; tool_input?: { file_path?: string } };
		} catch {
			// Malformed input — allow (don't block on parse errors)
			process.exit(0);
		}

		const tool = data.tool_name ?? "unknown";
		const filePath = data.tool_input?.file_path ?? "";

		// Allow writes inside .grove/ and .claude/ (orchestrator's own state)
		const normalized = filePath.replace(/\\/g, "/");
		if (normalized.includes("/.grove/") || normalized.includes("/.claude/")) {
			process.exit(0);
		}

		// Block all other file modifications
		process.stderr.write(
			`BLOCKED: Orchestrator cannot use ${tool} on project files. ` +
			`Delegate to an agent instead:\n` +
			`  grove task add <id> "<title>" --description "<spec>"\n` +
			`  grove spawn <task-id> -n <name> -c lead\n`,
		);
		process.exit(2);
	});

// ── Run ─────────────────────────────────────────────────────────────────
program.hook("postAction", (_, actionCommand) => {
	// Don't close DB for long-running commands that poll, or for commands that don't use DB
	const name = actionCommand.name();
	if (name === "dashboard" || name === "feed" || name === "prime" || name === "hooks" || name === "guard") return;
	closeDb();
});

program.parse();
