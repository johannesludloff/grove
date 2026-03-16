/** Orchestrator context output — for Claude Code SessionStart hook injection */

import { existsSync } from "node:fs";
import { listAgents, reconcileZombies } from "./agent.ts";
import { groveDir } from "./db.ts";
import { checkMail } from "./mail.ts";
import { listTasks } from "./tasks.ts";

/** Write orchestrator context markdown to stdout */
export function prime(): void {
	const out = process.stdout;

	out.write("# Grove Agent Orchestration\n\n");

	out.write("**You are an orchestrator. Delegate ALL work to agents. Stay available for new user input.**\n\n");
	out.write("Do NOT use Read, Glob, Grep, or Bash to explore the codebase yourself.\n\n");
	out.write("Even read-only research MUST be delegated to a scout agent.\n\n");
	out.write("NEVER read files to understand code before delegating — spawn a scout instead.\n\n");
	out.write("**BAD:** Reading files yourself to understand the codebase\n\n");
	out.write("**GOOD:** `grove spawn explore-task -n my-scout -c scout`\n\n");

	// Dispatch pattern
	out.write("## On Every User Request\n\n");
	out.write("1. `grove task add <id> \"<title>\" --description \"<spec>\"`\n");
	out.write("2. `grove spawn <task-id> -n <name> -c <capability>`\n");
	out.write("3. Confirm what you dispatched, then **stop and wait** for the next user message\n\n");
	out.write("Do NOT poll or loop. Agent mail is auto-injected before each turn.\n\n");

	// Capability guide
	out.write("## Agent Capabilities\n\n");
	out.write("| Flag | When to Use |\n");
	out.write("|------|-------------|\n");
	out.write("| `-c lead` | **Default.** Any non-trivial task. Leads decompose, spawn sub-agents, and verify. |\n");
	out.write("| `-c builder` | Simple, single-file changes you can fully spec in one sentence. |\n");
	out.write("| `-c scout` | Read-only exploration before deciding what to build. |\n");
	out.write("| `-c reviewer` | Read-only code review of completed work. |\n");
	out.write("\n");

	// On receiving mail
	out.write("## When Agent Mail Arrives\n\n");
	out.write("Agent completion/failure messages appear automatically at the start of your turn.\n\n");
	out.write("1. `grove merge --all` — integrate completed branches\n");
	out.write("2. `grove clean` — remove finished worktrees\n");
	out.write("3. Report results to user\n");
	out.write("4. If failed: check `.grove/logs/<name>/stderr.log`, then retry or escalate\n\n");

	// Maintenance crons
	out.write("## Maintenance Crons (set up once per session)\n\n");
	out.write("On session start, set up these recurring maintenance tasks using CronCreate:\n\n");
	out.write("1. **Zombie reconciliation** — every 5 minutes:\n");
	out.write("   CronCreate with schedule `every 5 minutes`, command `grove status > /dev/null`\n\n");
	out.write("2. **Auto-clean worktrees** — every 10 minutes:\n");
	out.write("   CronCreate with schedule `every 10 minutes`, command `grove clean`\n\n");
	out.write("3. **Reactive mail check** — every 2 minutes:\n");
	out.write("   CronCreate with schedule `every 2 minutes`, command `grove mail check orchestrator`\n\n");
	out.write("Use `grove cron list` to check active crons, `grove cron clear` to remove them.\n\n");

	// Active state
	if (!existsSync(groveDir())) {
		out.write("## Active State\n\n");
		out.write("_Grove not initialized in this directory._\n\n");
		return;
	}

	// --- Reconcile stale state from previous sessions ---

	// 1. Reconcile zombie agents (running/spawning but PID dead)
	const zombies = reconcileZombies();
	if (zombies.length > 0) {
		out.write(`⚠ Reconciled ${zombies.length} zombie agent(s) from previous session: ${zombies.join(", ")}\n\n`);
	}

	// 2. Detect orphaned in_progress tasks with no active agents
	const inProgressTasks = listTasks("in_progress");
	const activeAgents = listAgents("running").concat(listAgents("spawning"));
	const activeTaskIds = new Set(activeAgents.map((a) => a.taskId));
	const orphanedTasks = inProgressTasks.filter((t) => !activeTaskIds.has(t.taskId));
	if (orphanedTasks.length > 0) {
		const ids = orphanedTasks.map((t) => t.taskId).join(", ");
		out.write(`⚠ ${orphanedTasks.length} task(s) stuck in_progress with no active agents: ${ids}\n`);
		out.write("Consider: `grove task update <id> -s failed` or re-spawn agents.\n\n");
	}

	// 3. Surface unread orchestrator mail
	const unread = checkMail("orchestrator");
	if (unread.length > 0) {
		out.write(`📬 ${unread.length} unread message(s) — run \`grove mail check orchestrator\` to read\n\n`);
	}

	out.write("## Active State\n\n");

	const runningAgents = listAgents("running").concat(listAgents("spawning"));
	const completedAgents = listAgents("completed");

	if (completedAgents.length > 0) {
		out.write(`**⚠ ${completedAgents.length} completed agent(s) ready to merge:**\n\n`);
		for (const agent of completedAgents) {
			out.write(`- \`${agent.name}\` (${agent.capability}) — branch \`${agent.branch}\`\n`);
		}
		out.write("\nRun `grove merge --all && grove clean` now.\n\n");
	}

	if (runningAgents.length === 0) {
		out.write("**Running agents:** none\n\n");
	} else {
		out.write(`**Running agents (${runningAgents.length}):**\n\n`);
		for (const agent of runningAgents) {
			out.write(`- \`${agent.name}\` (${agent.capability}) — task \`${agent.taskId}\` on \`${agent.branch}\`\n`);
		}
		out.write("\n");
	}

	const pendingTasks = listTasks("pending");
	if (pendingTasks.length > 0) {
		out.write(`**Pending tasks (${pendingTasks.length}):**\n\n`);
		for (const task of pendingTasks) {
			out.write(`- \`${task.taskId}\` — ${task.title}\n`);
		}
		out.write("\n");
	}
}
