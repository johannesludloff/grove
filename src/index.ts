#!/usr/bin/env bun
/** Grove — Windows-native multi-agent orchestrator for Claude Code */

import { Command } from "commander";
import { closeDb, getDb, groveDir, initDb } from "./db.ts";
import { getCurrentBranch, isGitRepo, initGitRepo } from "./worktree.ts";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createTask, getTask, listTasks, updateTask, archiveCompletedTasks, getTaskDependencies } from "./tasks.ts";
import { spawnAgent, stopAgent, listAgents, cleanAgent, reconcileZombies, getAgentByWorktree, isPidAlive } from "./agent.ts";
import { emit } from "./events.ts";
import { sendMail, checkMail, markRead, listMail, hasMergeReadyMail } from "./mail.ts";
import { addMemory, listMemories, removeMemory } from "./memory.ts";
import { DEFAULT_POWER_MODEL, DEFAULT_FAST_MODEL } from "./models.ts";
import { startDashboard } from "./dashboard.ts";
import { startFeed, showRecentEvents } from "./feed.ts";
import { enqueue, updateStatus, list as listMergeQueue } from "./merge-queue.ts";
import { resolve } from "./merge-resolver.ts";
import { prime } from "./prime.ts";
import { installHooks, uninstallHooks, statusHooks } from "./hooks.ts";
import { collectBenchmarks, storeBenchmarkRun, getPreviousRun, displayReport, listRuns } from "./benchmark.ts";
import { startWatchdog, stopWatchdog, isWatchdogRunning } from "./watchdog.ts";
import { runHealthChecks, formatHealthReport } from "./health.ts";
import { writeCheckpoint, readCheckpoint, autoCheckpointFromTool } from "./checkpoint.ts";
import type { AgentCapability, MailType, TaskStatus, MergeTier } from "./types.ts";
import type { MemoryType } from "./memory.ts";
import type { Checkpoint } from "./checkpoint.ts";
import { maybeNotifyUpdate, runUpdate, getGroveVersion } from "./update.ts";
import { syncClaudeMd } from "./claude-md.ts";

const program = new Command();

program
	.name("grove")
	.description("Windows-native multi-agent orchestrator for Claude Code")
	.version(getGroveVersion());

// ── grove init ──────────────────────────────────────────────────────────
program
	.command("init")
	.description("Initialize .grove/ in the current project")
	.action(async () => {
		if (existsSync(groveDir())) {
			console.log("Grove already initialized.");
			return;
		}

		// Auto-initialize git if not in a git repository
		if (!(await isGitRepo())) {
			console.log("No git repository detected — running git init...");
			await initGitRepo();

			// Create an initial empty commit so HEAD exists (required for worktrees)
			const commitProc = Bun.spawn(
				["git", "commit", "--allow-empty", "-m", "Initial commit (grove init)"],
				{ cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
			);
			if ((await commitProc.exited) !== 0) {
				const stderr = await new Response(commitProc.stderr).text();
				throw new Error(`Failed to create initial commit: ${stderr.trim()}`);
			}
		}

		initDb();
		const branch = await getCurrentBranch();
		await Bun.write(`${groveDir()}/base-branch.txt`, branch);

		// Install Claude Code hooks for SessionStart/UserPromptSubmit integration
		await installHooks(process.cwd());

		// Write orchestrator instructions to CLAUDE.md
		await syncClaudeMd(process.cwd());

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
	.option("--depends-on <ids>", "Comma-separated task IDs this task depends on")
	.option("--parent-task <task-id>", "Parent task ID for goal ancestry")
	.action((taskId: string, title: string, opts: { description?: string; dependsOn?: string; parentTask?: string }) => {
		const dependsOn = opts.dependsOn
			? opts.dependsOn.split(",").map((s) => s.trim()).filter(Boolean)
			: undefined;
		try {
			const task = createTask({ taskId, title, description: opts.description, dependsOn, parentTaskId: opts.parentTask });
			const statusNote = task.status === "blocked" ? " (blocked — waiting on dependencies)" : "";
			const parentInfo = task.parentTaskId ? ` (parent: ${task.parentTaskId})` : "";
			console.log(`Created task: ${task.taskId} — ${task.title}${statusNote}${parentInfo}`);
			if (dependsOn?.length) {
				console.log(`  Dependencies: ${dependsOn.join(", ")}`);
			}
		} catch (err: unknown) {
			console.error((err as Error).message);
			process.exit(1);
		}
	});

taskCmd
	.command("update")
	.description("Update a task's status")
	.argument("<task-id>", "Task ID to update")
	.requiredOption("-s, --status <status>", "New status (pending/blocked/in_progress/completed/failed/archived)")
	.action((taskId: string, opts: { status: string }) => {
		const task = getTask(taskId);
		if (!task) {
			console.error(`Task "${taskId}" not found.`);
			process.exit(1);
		}
		const validStatuses: TaskStatus[] = ["pending", "blocked", "in_progress", "completed", "failed", "archived"];
		if (!validStatuses.includes(opts.status as TaskStatus)) {
			console.error(`Invalid status "${opts.status}". Valid: ${validStatuses.join(", ")}`);
			process.exit(1);
		}
		updateTask(taskId, { status: opts.status as TaskStatus });
		console.log(`Task "${taskId}" status → ${opts.status}`);
	});

taskCmd
	.command("list")
	.option("-s, --status <status>", "Filter by status")
	.option("-a, --all", "Show all tasks including archived")
	.action((opts: { status?: string; all?: boolean }) => {
		let tasks: ReturnType<typeof listTasks>;
		if (opts.status) {
			tasks = listTasks(opts.status as TaskStatus);
		} else if (opts.all) {
			tasks = listTasks();
		} else {
			// Default: show only active tasks (exclude archived)
			tasks = listTasks().filter((t) => t.status !== "archived");
		}
		if (tasks.length === 0) {
			console.log("No tasks.");
			return;
		}
		for (const t of tasks) {
			const assignee = t.assignedTo ? ` → ${t.assignedTo}` : "";
			const deps = getTaskDependencies(t.taskId);
			const depsNote = deps.length ? ` (depends on: ${deps.join(", ")})` : "";
			console.log(`  [${t.status}] ${t.taskId}: ${t.title}${assignee}${depsNote}`);
		}
	});

// ── grove spawn ─────────────────────────────────────────────────────────
program
	.command("spawn")
	.description("Spawn a new agent")
	.argument("<task-id>", "Task to work on")
	.requiredOption("-n, --name <name>", "Unique agent name")
	.option("-c, --capability <type>", "builder | scout | reviewer | lead", "builder")
	.option("-m, --model <model>", `Claude model to use (default: scouts/reviewers=${DEFAULT_FAST_MODEL}, builders/leads=${DEFAULT_POWER_MODEL})`)
	.option("--parent <name>", "Parent agent name")
	.option("--depth <n>", "Explicit spawn depth (auto-derived from parent if omitted)")
	.option("--max-depth <n>", "Maximum spawn depth (default: 2)")
	.option("--max-agents <n>", "Maximum active sub-agents per lead (default: 5, 0=unlimited)")
	.action(
		async (
			taskId: string,
			opts: { name: string; capability: string; model?: string; parent?: string; depth?: string; maxDepth?: string; maxAgents?: string },
		) => {
			const task = getTask(taskId);
			if (!task) {
				console.error(`Task "${taskId}" not found. Create it first: grove task add ${taskId} "title"`);
				process.exit(1);
			}

			if (task.status === "blocked") {
				const deps = getTaskDependencies(taskId);
				console.error(`Task "${taskId}" is blocked — waiting on dependencies: ${deps.join(", ")}`);
				console.error("Cannot spawn agents for blocked tasks.");
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
				depth: opts.depth ? Number(opts.depth) : undefined,
				maxDepth: opts.maxDepth ? Number(opts.maxDepth) : undefined,
				maxAgents: opts.maxAgents ? Number(opts.maxAgents) : undefined,
			});

			// Start watchdog on first spawn if not already running
			if (!isWatchdogRunning()) {
				startWatchdog();
			}

			console.log(`Spawned agent: ${result.agent.name} (PID ${result.pid})`);
			console.log(`  Capability: ${result.agent.capability}`);
			console.log(`  Branch: ${result.agent.branch}`);
			console.log(`  Depth: ${result.agent.depth}`);
			console.log(`  Worktree: ${result.agent.worktree}`);

			// Forward SIGTERM/SIGINT to the child process so 'grove stop' propagates
			const forwardSignal = (signal: NodeJS.Signals) => {
				try { process.kill(result.pid, signal); } catch { /* child already gone */ }
			};
			process.on("SIGTERM", () => forwardSignal("SIGTERM"));
			process.on("SIGINT", () => forwardSignal("SIGINT"));

			// Wait for the child agent process to exit, then exit with its code
			const exitCode = await result.exitPromise;
			process.exit(exitCode ?? 1);
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
		// Reconcile zombie agents before displaying status
		const zombies = reconcileZombies();
		if (zombies.length > 0) {
			console.log(`Reconciled ${zombies.length} zombie agent(s): ${zombies.join(", ")}`);
		}

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

		const fmtLastActive = (a: (typeof agents)[0]): string => {
			if (a.status !== "running" && a.status !== "spawning") return "";
			const ts = a.lastActivityAt ?? a.createdAt;
			const ageMs = Date.now() - new Date(ts + (ts.endsWith("Z") ? "" : "Z")).getTime();
			const ageMin = Math.floor(ageMs / 60_000);
			if (ageMin < 1) return " [active <1m ago]";
			const stale = ageMin >= 5 ? " ⚠" : "";
			return ` [active ${ageMin}m ago${stale}]`;
		};

		const fmt = (a: (typeof agents)[0], prefix: string) => {
			const pid = a.pid ? ` (PID ${a.pid})` : "";
			console.log(`${prefix}[${a.status}] ${a.name} — ${a.capability} on ${a.branch}${pid}${fmtLastActive(a)}`);
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

		// Reconcile zombie agents so dead PIDs don't keep us polling
		reconcileZombies();

		// Skip polling if no agents are actively running or spawning
		const activeAgents = [
			...listAgents("running"),
			...listAgents("spawning"),
		];
		if (activeAgents.length === 0) {
			process.exit(0);
		}

		const MAX_POLLS = 10;
		const POLL_INTERVAL_MS = 30_000;

		for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
			const messages = checkMail("orchestrator");
			if (messages.length > 0) {
				// Format messages and mark each as read
				const lines: string[] = [`${messages.length} unread message(s) for orchestrator:\n`];
				for (const m of messages) {
					lines.push(`  #${m.id} [${m.type}] from ${m.from}: ${m.subject}`);
					lines.push(`    ${m.body}`);
					markRead(m.id);
				}
				const reason = lines.join("\n");
				process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
				process.exit(0);
			}

			if (attempt < MAX_POLLS - 1) {
				await Bun.sleep(POLL_INTERVAL_MS);
			}
		}

		// Timeout reached — exit silently
		process.exit(0);
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

/** Auto-commit .grove/ and .claude/ state files, then check for remaining dirty tracked files */
async function ensureCleanTree(repoRoot: string): Promise<void> {
	// Stage any modified .grove/ and .claude/ files
	const stateProc = Bun.spawn(
		["git", "diff", "--name-only", "--", ".grove/", ".claude/"],
		{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
	);
	await stateProc.exited;
	const stateFiles = (await new Response(stateProc.stdout).text())
		.split("\n").map((l) => l.trim()).filter(Boolean);

	// Also check for untracked .grove/ and .claude/ files
	const untrackedProc = Bun.spawn(
		["git", "ls-files", "--others", "--exclude-standard", "--", ".grove/", ".claude/"],
		{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
	);
	await untrackedProc.exited;
	const untrackedState = (await new Response(untrackedProc.stdout).text())
		.split("\n").map((l) => l.trim()).filter(Boolean);

	const allStateFiles = [...stateFiles, ...untrackedState];
	if (allStateFiles.length > 0) {
		// Auto-commit grove/claude state files
		await Bun.spawn(["git", "add", "--", ".grove/", ".claude/"], {
			cwd: repoRoot, stdout: "pipe", stderr: "pipe",
		}).exited;
		const commitProc = Bun.spawn(
			["git", "commit", "-m", "chore: auto-commit grove state files before merge", "--no-verify"],
			{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
		);
		await commitProc.exited;
		// Commit may fail if nothing staged (e.g. .gitignore excludes them) — that's fine
	}

	// Check for remaining uncommitted changes to tracked files
	const diffProc = Bun.spawn(
		["git", "diff", "--quiet"],
		{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
	);
	const diffCode = await diffProc.exited;

	const stagedProc = Bun.spawn(
		["git", "diff", "--quiet", "--cached"],
		{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
	);
	const stagedCode = await stagedProc.exited;

	if (diffCode !== 0 || stagedCode !== 0) {
		// List the dirty files for a helpful error message
		const dirtyProc = Bun.spawn(
			["git", "diff", "--name-only"],
			{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
		);
		await dirtyProc.exited;
		const dirtyFiles = (await new Response(dirtyProc.stdout).text()).trim();
		throw new Error(
			`Working tree has uncommitted changes. Commit or stash them before merging.\nDirty files:\n${dirtyFiles}`,
		);
	}
}

program
	.command("merge")
	.description("Merge agent branches into the canonical branch")
	.option("-b, --branch <name>", "Merge a specific branch")
	.option("--all", "Merge all completed agent branches")
	.option("--into <branch>", "Target branch (default: read from .grove/base-branch.txt)")
	.option("--dry-run", "Check conflicts only, don't merge")
	.option("--force", "Merge completed agents even without merge_ready signal")
	.option("--review", "After merge --all, spawn a reviewer agent for integration review")
	.action(
		async (opts: { branch?: string; all?: boolean; into?: string; dryRun?: boolean; force?: boolean; review?: boolean }) => {
			if (!opts.branch && !opts.all) {
				console.error("Specify --branch <name> or --all");
				process.exit(1);
			}

			const canonicalBranch =
				opts.into ?? (await Bun.file(`${groveDir()}/base-branch.txt`).text()).trim();
			const repoRoot = process.cwd();

			// Guard: auto-commit state files and ensure clean working tree before merge
			if (!opts.dryRun) {
				try {
					await ensureCleanTree(repoRoot);
				} catch (err) {
					console.error(err instanceof Error ? err.message : String(err));
					process.exit(1);
				}
			}

			if (opts.dryRun) {
				console.log(`[dry-run] Target branch: ${canonicalBranch}`);
			}

			/** Get files modified in branch relative to canonical (excludes .grove/* runtime files) */
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
					.filter((l) => l && !l.startsWith(".grove/"));
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
				parentName?: string | null,
			): Promise<void> {
				const filesModified = await getModifiedFiles(branchName);
				const entry = enqueue({ branchName, taskId, agentName, filesModified });
				const parentTag = parentName ? ` (parent: ${parentName})` : "";
				console.log(`\n  Enqueued: ${branchName}${parentTag} (queue #${entry.id})`);

				const result = await resolve({ branchName, canonicalBranch, repoRoot });

				if (result.success) {
					updateStatus(entry.id, "merged", result.tier as MergeTier);
					console.log(`  Merged via ${result.tier}`);
					if (result.conflictFiles.length > 0) {
						console.log(`  Auto-resolved: ${result.conflictFiles.join(", ")}`);
					}

					// Auto-complete task if all agents for it are done
					if (taskId !== "manual") {
						const db = getDb();
						const remaining = db
							.prepare(
								"SELECT COUNT(*) as count FROM agents WHERE task_id = ? AND status IN ('running', 'spawning')",
							)
							.get(taskId) as { count: number };
						if (remaining.count === 0) {
							updateTask(taskId, { status: "completed" });
							console.log(`  Task "${taskId}" auto-completed (all agents done)`);
						}
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

			/** Run tsc --noEmit and return pass/fail with output */
			async function runTypecheck(): Promise<{ passed: boolean; output: string }> {
				const proc = Bun.spawn(["bun", "run", "typecheck"], {
					cwd: repoRoot,
					stdout: "pipe",
					stderr: "pipe",
				});
				const code = await proc.exited;
				const stdout = await new Response(proc.stdout).text();
				const stderr = await new Response(proc.stderr).text();
				return { passed: code === 0, output: (stdout + stderr).trim() };
			}

			// Reconcile zombie agents before processing merges
			reconcileZombies();

			if (opts.branch) {
				const agents = listAgents();
				const agent = agents.find((a) => a.branch === opts.branch);
				const agentName = agent?.name ?? opts.branch;
				const taskId = agent?.taskId ?? "manual";
				const parentName = agent?.parentName ?? null;

				if (opts.dryRun) {
					await dryRunMerge(opts.branch);
				} else {
					console.log(`Merging ${opts.branch} into ${canonicalBranch}...`);
					await doMerge(opts.branch, agentName, taskId, parentName);
				}
			} else {
				// --all
				const agents = listAgents("completed");
				if (agents.length === 0) {
					console.log("No completed agents to merge.");
					return;
				}

				// Skip branches already successfully merged
				const alreadyMerged = new Set(listMergeQueue("merged").map((e) => e.branchName));

				// Sort by completion time (oldest first = chronological order)
				const eligible = agents
					.filter((a) => !alreadyMerged.has(a.branch))
					.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

				if (eligible.length === 0) {
					console.log("No completed agents to merge (all already merged).");
					return;
				}

				// Filter by merge_ready signal unless --force is set
				let toMerge = eligible;
				if (!opts.force) {
					const ready = eligible.filter((a) => hasMergeReadyMail(a.name));
					const skipped = eligible.length - ready.length;
					if (skipped > 0) {
						const skippedNames = eligible
							.filter((a) => !hasMergeReadyMail(a.name))
							.map((a) => a.name);
						console.log(
							`Skipping ${skipped} agent(s) without merge_ready signal: ${skippedNames.join(", ")}`,
						);
						console.log("Use --force to merge without merge_ready signal.");
					}
					toMerge = ready;
				}

				if (toMerge.length === 0) {
					console.log("No merge-ready agents to merge. Use --force to override.");
					return;
				}

				console.log(
					`Processing ${toMerge.length} completed agent(s) into ${canonicalBranch}...`,
				);
				for (const agent of toMerge) {
					if (opts.dryRun) {
						await dryRunMerge(agent.branch);
					} else {
						await doMerge(agent.branch, agent.name, agent.taskId, agent.parentName);
					}
				}

				if (!opts.dryRun) {
					// Post-merge typecheck
					console.log("\n--- Post-merge validation ---");
					console.log("Running typecheck (tsc --noEmit)...");
					const { passed, output } = await runTypecheck();
					if (passed) {
						console.log("  Typecheck: PASSED");
					} else {
						console.log("  Typecheck: FAILED");
						if (output) {
							const lines = output.split("\n");
							for (const line of lines.slice(0, 20)) {
								console.log(`    ${line}`);
							}
							if (lines.length > 20) {
								console.log(`    ... (${lines.length - 20} more lines)`);
							}
						}
					}

					// CLAUDE.md sync guard: warn if core behavior files changed without CLAUDE.md update
					const coreFiles = [
						"src/agent.ts", "src/index.ts", "src/merge-resolver.ts",
						"src/merge-queue.ts", "src/watchdog.ts", "src/tasks.ts",
						"src/hooks.ts",
					];
					const coreFilePrefixes = ["src/mail/"];
					for (const agent of toMerge) {
						const branchFiles = await getModifiedFiles(agent.branch);
						const touchedCore = branchFiles.some(
							(f) => coreFiles.includes(f) || coreFilePrefixes.some((p) => f.startsWith(p)),
						);
						const touchedClaudeMd = branchFiles.some((f) => f === "CLAUDE.md");
						if (touchedCore && !touchedClaudeMd) {
							console.log(
								`\n  WARNING: Core behavior files changed in branch "${agent.branch}" but CLAUDE.md was not updated.` +
								"\n  Consider updating CLAUDE.md to reflect the new behavior.",
							);
						}
					}

					// Spawn reviewer if requested
					if (opts.review) {
						if (!passed) {
							console.log("\n  Skipping integration review: typecheck failed. Fix errors first.");
						} else {
							console.log("\n  Spawning integration reviewer...");
							const reviewTaskId = `integration-review-${Date.now()}`;
							const mergedSummary = toMerge
								.map((a) => `- ${a.branch} (${a.name})`)
								.join("\n");
							const taskDescription =
								`Integration review for branches merged into ${canonicalBranch}.\n\nMerged branches:\n${mergedSummary}\n\nRun: git log --oneline ${canonicalBranch}~${toMerge.length}..${canonicalBranch} to see what was merged.\n\nCheck for: 1) Duplicate implementations, 2) Conflicting patterns, 3) Missing cross-feature wiring, 4) Logical regressions. Report PASS or FAIL with specific findings.`;
							createTask({ taskId: reviewTaskId, title: "Integration review after merge --all", description: taskDescription });
							const reviewerName = `integration-reviewer-${Date.now()}`;
							try {
								const result = await spawnAgent({
									name: reviewerName,
									capability: "reviewer",
									taskId: reviewTaskId,
									taskDescription,
									baseBranch: canonicalBranch,
								});
								console.log(`  Reviewer spawned: ${result.agent.name} (PID ${result.pid})`);
								console.log("  Check results with: grove mail check orchestrator");
							} catch (err) {
							  console.error(`  Failed to spawn reviewer: ${err}`);
							}
						}
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
		// Reconcile zombie agents before cleaning
		reconcileZombies();

		if (name) {
			await cleanAgent(name);
			console.log(`Cleaned up agent: ${name}`);
		} else {
			const agents = listAgents();
			const mergedBranches = new Set(listMergeQueue("merged").map((e) => e.branchName));

			// Partition agents into cleanable vs skipped
			const toClean: typeof agents = [];
			for (const a of agents) {
				if (a.status === "completed" || a.status === "stopped" || a.status === "failed") {
					if (a.status === "completed" && !mergedBranches.has(a.branch)) {
						console.log(
							`  Skipping ${a.name}: branch ${a.branch} has not been merged. Run 'grove merge --all' first.`,
						);
						continue;
					}
					toClean.push(a);
				}
			}

			// Clean all eligible agents in parallel
			const cleanResults = await Promise.allSettled(
				toClean.map((a) => cleanAgent(a.name)),
			);
			let cleaned = cleanResults.filter((r) => r.status === "fulfilled").length;

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
			// Stop orphans sequentially (cascade), then clean in parallel
			for (const orphan of orphans) {
				console.log(`Stopping orphaned agent ${orphan.name} (parent ${orphan.parentName} is ${agents.find((a) => a.name === orphan.parentName)?.status})`);
				try {
					await stopAgent(orphan.name);
				} catch {
					// Skip if already gone
				}
			}
			if (orphans.length > 0) {
				const orphanResults = await Promise.allSettled(
					orphans.map((o) => cleanAgent(o.name)),
				);
				cleaned += orphanResults.filter((r) => r.status === "fulfilled").length;
			}

			console.log(`Cleaned ${cleaned} agent worktree(s).`);

			// Archive completed/failed tasks with no active agents
			const archivedTasks = archiveCompletedTasks();
			if (archivedTasks.length > 0) {
				console.log(`Archived ${archivedTasks.length} task(s): ${archivedTasks.join(", ")}`);
			}

			// Stop watchdog if no running agents remain
			const remaining = listAgents("running");
			if (remaining.length === 0 && isWatchdogRunning()) {
				stopWatchdog();
				console.log("Watchdog stopped — no running agents remain.");
			}
		}
	});

// ── grove cron ──────────────────────────────────────────────────────────
const cronCmd = program.command("cron").description("Manage scheduled maintenance via Claude Code CronCreate");

cronCmd
	.command("setup")
	.description("Print CronCreate commands for the orchestrator to schedule maintenance crons")
	.option("--clean-interval <minutes>", "Minutes between clean sweeps (default: 10)", "10")
	.option("--zombie-interval <minutes>", "Minutes between zombie reconciliation (default: 5)", "5")
	.action((opts: { cleanInterval: string; zombieInterval: string }) => {
		const cleanMin = Math.max(1, Number(opts.cleanInterval) || 10);
		const zombieMin = Math.max(1, Number(opts.zombieInterval) || 5);

		console.log("To enable grove maintenance crons, the orchestrator should call these Claude Code tools:\n");
		console.log("1. CronCreate — zombie reconciliation:");
		console.log(JSON.stringify({
			schedule: `every ${zombieMin} minutes`,
			command: "grove status > /dev/null",
			description: "Grove: reconcile zombie agents",
		}, null, 2));
		console.log("\n2. CronCreate — auto-clean worktrees:");
		console.log(JSON.stringify({
			schedule: `every ${cleanMin} minutes`,
			command: "grove clean",
			description: "Grove: auto-clean finished worktrees",
		}, null, 2));
		console.log("\n3. CronCreate — reactive mail check:");
		console.log(JSON.stringify({
			schedule: "every 2 minutes",
			command: "grove mail check orchestrator",
			description: "Grove: reactive mail check",
		}, null, 2));
		console.log("\n4. CronCreate — workflow health check:");
		console.log(JSON.stringify({
			schedule: "every 5 minutes",
			command: "grove health --notify",
			description: "Grove: workflow health check with auto-fix",
		}, null, 2));
		console.log("\nThe orchestrator's SessionStart hook should call these automatically.");
	});

cronCmd
	.command("list")
	.description("List active crons (wraps CronList)")
	.action(async () => {
		const proc = Bun.spawn(["claude", "-p", "Use the CronList tool to list all active crons, then output ONLY the raw result as JSON. No commentary."], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		if (code !== 0) {
			console.error(`Failed to list crons: ${stderr}`);
			process.exit(1);
		}
		console.log(stdout.trim() || "No active crons.");
	});

cronCmd
	.command("clear")
	.description("Delete all grove-related crons (wraps CronDelete)")
	.action(async () => {
		const proc = Bun.spawn(["claude", "-p", "Use CronList to find all crons with 'Grove' or 'grove' in the description, then use CronDelete to delete each one. Output the IDs you deleted. No commentary."], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		if (code !== 0) {
			console.error(`Failed to clear crons: ${stderr}`);
			process.exit(1);
		}
		console.log(stdout.trim() || "No grove crons found.");
	});

// ── grove benchmark ─────────────────────────────────────────────────────
const benchCmd = program.command("benchmark").description("Benchmark grove operations");

benchCmd
	.command("run")
	.description("Collect metrics and store a benchmark run")
	.option("--quiet", "Skip report output, just store")
	.action((opts: { quiet?: boolean }) => {
		const metrics = collectBenchmarks();
		const previousRun = getPreviousRun();
		const runId = storeBenchmarkRun(metrics);

		if (!opts.quiet) {
			displayReport(metrics, previousRun);
		}
		console.log(`Benchmark run stored: ${runId} (${metrics.length} metrics)`);
	});

benchCmd
	.command("report")
	.description("Display the latest benchmark report without storing a new run")
	.action(() => {
		const metrics = collectBenchmarks();
		const previousRun = getPreviousRun();
		displayReport(metrics, previousRun);
	});

benchCmd
	.command("history")
	.description("List all benchmark runs")
	.action(() => {
		const runs = listRuns();
		if (runs.length === 0) {
			console.log("No benchmark runs recorded yet. Run: grove benchmark run");
			return;
		}
		console.log("Benchmark runs:");
		for (const r of runs) {
			console.log(`  ${r.runId}  ${r.createdAt}  (${r.metricCount} metrics)`);
		}
	});

// ── grove tool-metric (PostToolUse hook target) ─────────────────────────
program
	.command("tool-metric")
	.description("PostToolUse hook: log tool usage metrics to SQLite")
	.action(async () => {
		try {
			const input = await new Response(Bun.stdin.stream()).text();
			let data: { tool_name?: string; tool_response?: unknown } = {};
			try {
				data = JSON.parse(input) as { tool_name?: string; tool_response?: unknown };
			} catch {
				process.exit(0);
			}

			const toolName = data.tool_name ?? "unknown";

			// Determine agent name from current git branch
			let agentName = "orchestrator";
			try {
				const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
				if (branch.startsWith("grove/")) {
					agentName = branch.slice("grove/".length);
				}
			} catch {
				// Default to orchestrator
			}

			// Determine success: check for error indicators in tool_response
			let success = 1;
			const response = data.tool_response;
			if (typeof response === "string" && response.trimStart().toLowerCase().startsWith("error")) {
				success = 0;
			} else if (response && typeof response === "object" && (response as Record<string, unknown>).is_error === true) {
				success = 0;
			}

			getDb().prepare("INSERT INTO tool_metrics (agent_name, tool_name, success) VALUES (?, ?, ?)").run(agentName, toolName, success);

			// Write last-tool context for heartbeat enrichment
			if (agentName !== "orchestrator") {
				const inputRaw = (data as Record<string, unknown>).tool_input;
				let inputSummary = "";
				if (typeof inputRaw === "string") {
					inputSummary = inputRaw.slice(0, 120);
				} else if (inputRaw && typeof inputRaw === "object") {
					const obj = inputRaw as Record<string, unknown>;
					const firstKey = Object.keys(obj)[0];
					if (firstKey) {
						inputSummary = `${firstKey}: ${String(obj[firstKey]).slice(0, 100)}`;
					}
				}
				const lastToolPath = `${groveDir}/logs/${agentName}/last-tool.json`;
				try {
					await Bun.write(lastToolPath, JSON.stringify({ tool: toolName, inputSummary, timestamp: new Date().toISOString() }));
				} catch {
					// Log dir may not exist yet — ignore
				}

				// Auto-update checkpoint with file tracking
				const toolInput = (typeof inputRaw === "object" && inputRaw !== null)
					? inputRaw as Record<string, unknown>
					: {};
				try {
					await autoCheckpointFromTool(agentName, toolName, toolInput);
				} catch {
					// Checkpoint write failure should not block the hook
				}
			}

			process.exit(0);
		} catch {
			process.exit(0);
		}
	});

// ── grove metrics ───────────────────────────────────────────────────────
program
	.command("metrics")
	.description("Display tool usage metrics per agent and per tool")
	.option("--agent <name>", "Filter by specific agent")
	.action((opts: { agent?: string }) => {
		const db = getDb();

		// Per-agent summary
		if (!opts.agent) {
			const agentRows = db.prepare(
				"SELECT agent_name, COUNT(*) as total, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) as failures FROM tool_metrics GROUP BY agent_name ORDER BY total DESC"
			).all() as { agent_name: string; total: number; failures: number }[];

			if (agentRows.length === 0) {
				console.log("No tool metrics recorded yet.");
				return;
			}

			console.log("Per-agent tool usage:");
			console.log(`  ${"Agent".padEnd(30)} ${"Total".padStart(6)} ${"Fail".padStart(6)} ${"Success%".padStart(9)}`);
			console.log(`  ${"─".repeat(30)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(9)}`);
			for (const row of agentRows) {
				const pct = (((row.total - row.failures) / row.total) * 100).toFixed(1);
				console.log(`  ${row.agent_name.padEnd(30)} ${String(row.total).padStart(6)} ${String(row.failures).padStart(6)} ${(pct + "%").padStart(9)}`);
			}
			console.log();
		}

		// Per-tool summary
		const toolQuery = opts.agent
			? "SELECT tool_name, COUNT(*) as total, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) as failures FROM tool_metrics WHERE agent_name=? GROUP BY tool_name ORDER BY total DESC"
			: "SELECT tool_name, COUNT(*) as total, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) as failures FROM tool_metrics GROUP BY tool_name ORDER BY total DESC";

		const toolRows = opts.agent
			? (db.prepare(toolQuery).all(opts.agent) as { tool_name: string; total: number; failures: number }[])
			: (db.prepare(toolQuery).all() as { tool_name: string; total: number; failures: number }[]);

		if (toolRows.length === 0) {
			if (opts.agent) {
				console.log(`No tool metrics for agent "${opts.agent}".`);
			}
			return;
		}

		const header = opts.agent ? `Per-tool usage (agent: ${opts.agent}):` : "Per-tool usage (all agents):";
		console.log(header);
		console.log(`  ${"Tool".padEnd(30)} ${"Total".padStart(6)} ${"Fail".padStart(6)} ${"Success%".padStart(9)}`);
		console.log(`  ${"─".repeat(30)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(9)}`);
		for (const row of toolRows) {
			const pct = (((row.total - row.failures) / row.total) * 100).toFixed(1);
			console.log(`  ${row.tool_name.padEnd(30)} ${String(row.total).padStart(6)} ${String(row.failures).padStart(6)} ${(pct + "%").padStart(9)}`);
		}
	});

// ── grove health ────────────────────────────────────────────────────────
program
	.command("health")
	.description("Run workflow health checks and auto-create tasks for detected problems")
	.option("--no-auto-fix", "Report problems without creating remediation tasks")
	.option("--notify", "Send summary mail to orchestrator")
	.option("--json", "Output results as JSON")
	.action((opts: { autoFix?: boolean; notify?: boolean; json?: boolean }) => {
		// Reconcile zombies first so status is accurate
		reconcileZombies();

		const autoFix = opts.autoFix !== false;
		const problems = runHealthChecks({ autoFix });

		if (opts.json) {
			console.log(JSON.stringify({ problems, count: problems.length }, null, 2));
		} else {
			console.log(formatHealthReport(problems));
		}

		if (opts.notify && problems.length > 0) {
			sendMail({
				from: "health-check",
				to: "orchestrator",
				subject: `Health: ${problems.length} problem(s) detected`,
				body: formatHealthReport(problems),
				type: "status",
			});
		}
	});

// ── grove check-complete ─────────────────────────────────────────────────
program
	.command("check-complete")
	.description("Check if all orchestrator work is done (agents, tasks, merges)")
	.action(() => {
		// Reconcile zombies first so status is accurate
		reconcileZombies();

		const activeAgents = [
			...listAgents("running"),
			...listAgents("spawning"),
		];
		const allAgentsDone = activeAgents.length === 0;

		const pendingTasks = listTasks("pending");
		const inProgressTasks = listTasks("in_progress");
		const tasksEmpty = pendingTasks.length === 0 && inProgressTasks.length === 0;

		const pendingMerges = listMergeQueue("pending");
		const mergingEntries = listMergeQueue("merging");
		const mergeQueueEmpty = pendingMerges.length === 0 && mergingEntries.length === 0;

		const complete = allAgentsDone && tasksEmpty && mergeQueueEmpty;

		const result = {
			complete,
			triggers: {
				allAgentsDone,
				tasksEmpty,
				mergeQueueEmpty,
			},
			details: {
				activeAgents: activeAgents.map((a) => ({ name: a.name, status: a.status, capability: a.capability })),
				pendingTasks: pendingTasks.map((t) => ({ taskId: t.taskId, status: t.status })),
				inProgressTasks: inProgressTasks.map((t) => ({ taskId: t.taskId, status: t.status, assignedTo: t.assignedTo })),
				pendingMerges: pendingMerges.map((e) => ({ branch: e.branchName, agent: e.agentName })),
				mergingEntries: mergingEntries.map((e) => ({ branch: e.branchName, agent: e.agentName })),
			},
		};

		console.log(JSON.stringify(result, null, 2));
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

// ── grove checkpoint ────────────────────────────────────────────────────
program
	.command("checkpoint")
	.description("Save or read an agent checkpoint for recovery")
	.option("--agent <name>", "Agent name (auto-detected from branch if omitted)")
	.option("--phase <phase>", "Current phase: scout, build, review, plan, complete")
	.option("--step <step>", "Description of current step")
	.option("--finding <finding>", "Add a key finding (can be repeated)", (val: string, prev: string[]) => [...prev, val], [] as string[])
	.option("--file-explored <path>", "Add an explored file (can be repeated)", (val: string, prev: string[]) => [...prev, val], [] as string[])
	.option("--file-modified <path>", "Add a modified file (can be repeated)", (val: string, prev: string[]) => [...prev, val], [] as string[])
	.option("--read", "Read the current checkpoint instead of writing")
	.action(async (opts: {
		agent?: string;
		phase?: string;
		step?: string;
		finding?: string[];
		fileExplored?: string[];
		fileModified?: string[];
		read?: boolean;
	}) => {
		// Auto-detect agent name from git branch
		let agentName = opts.agent;
		if (!agentName) {
			try {
				const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
				if (branch.startsWith("grove/")) {
					agentName = branch.slice("grove/".length);
				}
			} catch {
				// Fall through
			}
		}

		if (!agentName) {
			console.error("Could not detect agent name. Use --agent <name>.");
			process.exit(1);
		}

		if (opts.read) {
			const checkpoint = readCheckpoint(agentName);
			if (!checkpoint) {
				console.log("No checkpoint found.");
			} else {
				console.log(JSON.stringify(checkpoint, null, 2));
			}
			return;
		}

		// Build partial checkpoint from CLI options
		const data: Partial<Checkpoint> = {};
		if (opts.phase) {
			data.phase = opts.phase as Checkpoint["phase"];
		}
		if (opts.step) {
			data.currentStep = opts.step;
		}
		if (opts.finding && opts.finding.length > 0) {
			data.keyFindings = opts.finding;
		}
		if (opts.fileExplored && opts.fileExplored.length > 0) {
			data.filesExplored = opts.fileExplored;
		}
		if (opts.fileModified && opts.fileModified.length > 0) {
			data.filesModified = opts.fileModified;
		}

		await writeCheckpoint(agentName, data);
		console.log(`Checkpoint saved for ${agentName}.`);
	});

// ── grove session-end (SessionEnd hook target) ─────────────────────────
program
	.command("session-end")
	.description("SessionEnd hook: update agent status when a Claude session exits")
	.action(async () => {
		// Read stdin JSON from the SessionEnd hook
		const input = await new Response(Bun.stdin.stream()).text();
		let data: { session_id?: string; cwd?: string; transcript_path?: string } = {};
		try {
			data = JSON.parse(input) as typeof data;
		} catch {
			// Malformed input — exit silently
			process.exit(0);
		}

		const cwd = data.cwd;
		if (!cwd) {
			process.exit(0);
		}

		// Map cwd (worktree path) to an agent
		const agent = getAgentByWorktree(cwd);
		if (!agent) {
			// Not a grove agent session — ignore
			process.exit(0);
		}

		// Only act on agents still marked as running/spawning
		if (agent.status !== "running" && agent.status !== "spawning") {
			process.exit(0);
		}

		// Give a brief moment for the process to fully exit
		await Bun.sleep(500);

		const db = getDb();
		const pid = agent.pid;

		// Determine status: if PID is still alive, the session may have restarted — don't interfere
		if (pid != null && isPidAlive(pid)) {
			process.exit(0);
		}

		// PID is dead and session ended → mark based on whether the agent sent completion mail
		// Check if the agent already sent a "done" mail (meaning it completed normally)
		const doneMail = db
			.prepare(
				"SELECT id FROM mail WHERE from_agent = ? AND type = 'done' LIMIT 1",
			)
			.get(agent.name) as { id: number } | null;

		const status = doneMail ? "completed" : "failed";

		// Mark the completion mail as read so it doesn't stay unread forever
		if (doneMail) {
			markRead(doneMail.id);
		}

		db.prepare(
			"UPDATE agents SET status = ?, updated_at = datetime('now') WHERE name = ? AND status IN ('running', 'spawning')",
		).run(status, agent.name);

		emit(
			status === "completed" ? "agent.completed" : "agent.failed",
			`Agent "${agent.name}" session ended (${status})`,
			{ agent: agent.name },
		);

		// Only send mail if the agent didn't already report completion
		if (!doneMail) {
			const recipient = agent.parentName ?? "orchestrator";
			sendMail({
				from: agent.name,
				to: recipient,
				subject: `Agent ${agent.name} session ended (${status})`,
				body: `Session ended for agent "${agent.name}" (PID ${pid ?? "none"}). ` +
					`Detected via SessionEnd hook. Status set to ${status}. ` +
					`Capability: ${agent.capability}, task: ${agent.taskId}.`,
				type: status === "completed" ? "done" : "error",
			});

			updateTask(agent.taskId, { status });
		}

		process.exit(0);
	});

// ── grove update ────────────────────────────────────────────────────────
program
	.command("update")
	.description("Update Grove to the latest version from GitHub")
	.action(async () => {
		await runUpdate();
	});

// Auto-update check (non-blocking, cached once per hour)
program.hook("preAction", (_, actionCommand) => {
	const name = actionCommand.name();
	if (["update", "prime", "guard", "session-end", "hooks"].includes(name)) return;
	maybeNotifyUpdate();
});

// ── Run ─────────────────────────────────────────────────────────────────
program.hook("postAction", (_, actionCommand) => {
	// Don't close DB for long-running commands that poll, or for commands that don't use DB
	const name = actionCommand.name();
	if (name === "dashboard" || name === "feed" || name === "prime" || name === "hooks" || name === "guard" || name === "tool-metric" || name === "spawn" || name === "checkpoint" || name === "update") return;
	closeDb();
});

program.parse();
