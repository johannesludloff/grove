/** Background watchdog for proactive agent health monitoring */

import { getDb } from "./db.ts";
import { listAgents, isPidAlive, reconcileZombies } from "./agent.ts";
import { sendMail } from "./mail.ts";
import { emit } from "./events.ts";

/** Watchdog check interval in ms (30 seconds) */
const CHECK_INTERVAL_MS = 30_000;

/** Number of consecutive stall checks before warning (2 checks = ~1 minute) */
const STALL_THRESHOLD = 2;

/** Summary interval in ms (5 minutes) */
const SUMMARY_INTERVAL_MS = 5 * 60_000;

/** Track stdout sizes for stall detection */
const stdoutSizes = new Map<string, { size: number; stallCount: number }>();

/** Active interval handle */
let watchdogInterval: ReturnType<typeof setInterval> | null = null;

/** Timestamp of last summary */
let lastSummaryAt = Date.now();

/** Counts since last summary */
let completedSinceLastSummary = 0;

/** Whether watchdog is running */
export function isWatchdogRunning(): boolean {
	return watchdogInterval !== null;
}

/** Start the background watchdog loop */
export function startWatchdog(): void {
	if (watchdogInterval) return; // Already running

	lastSummaryAt = Date.now();
	completedSinceLastSummary = 0;
	stdoutSizes.clear();

	watchdogInterval = setInterval(() => {
		try {
			runHealthCheck();
		} catch {
			// Watchdog must never crash the host process
		}
	}, CHECK_INTERVAL_MS);

	emit("agent.running", "Watchdog started — monitoring agent health every 30s", {
		agent: "watchdog",
	});
}

/** Stop the background watchdog loop */
export function stopWatchdog(): void {
	if (!watchdogInterval) return;

	clearInterval(watchdogInterval);
	watchdogInterval = null;
	stdoutSizes.clear();
	completedSinceLastSummary = 0;

	emit("agent.stopped", "Watchdog stopped — no agents remain", {
		agent: "watchdog",
	});
}

/** Run a single health check cycle */
function runHealthCheck(): void {
	const running = listAgents("running");
	const stalled: string[] = [];
	const zombieNames: string[] = [];

	for (const agent of running) {
		if (!agent.pid) continue;

		// 1. PID liveness — delegate to reconcileZombies for dead PIDs
		if (!isPidAlive(agent.pid)) {
			zombieNames.push(agent.name);
			continue;
		}

		// 2. Stall detection — check stdout growth
		const logDir = `${process.cwd()}/.grove/logs/${agent.name}`;
		const stdoutPath = `${logDir}/stdout.txt`;

		try {
			const file = Bun.file(stdoutPath);
			const currentSize = file.size;
			const prev = stdoutSizes.get(agent.name);

			if (prev) {
				if (currentSize <= prev.size) {
					// No growth — increment stall count
					prev.stallCount++;
					if (prev.stallCount >= STALL_THRESHOLD) {
						stalled.push(agent.name);
					}
				} else {
					// Growing — reset stall count
					prev.size = currentSize;
					prev.stallCount = 0;
				}
			} else {
				// First observation
				stdoutSizes.set(agent.name, { size: currentSize, stallCount: 0 });
			}
		} catch {
			// stdout.txt may not exist yet
		}
	}

	// 3. Run zombie reconciliation if any dead PIDs found
	if (zombieNames.length > 0) {
		const reconciled = reconcileZombies();
		if (reconciled.length > 0) {
			sendMail({
				from: "watchdog",
				to: "orchestrator",
				subject: `Zombies detected: ${reconciled.join(", ")}`,
				body: `Watchdog found ${reconciled.length} zombie agent(s) with dead PIDs: ${reconciled.join(", ")}. They have been marked as failed and auto-retry attempted.`,
				type: "error",
			});
		}
	}

	// 4. Send stall warnings
	if (stalled.length > 0) {
		sendMail({
			from: "watchdog",
			to: "orchestrator",
			subject: `Stalled agents: ${stalled.join(", ")}`,
			body: `Watchdog detected ${stalled.length} agent(s) with no output growth for ${STALL_THRESHOLD} consecutive checks (~${(STALL_THRESHOLD * CHECK_INTERVAL_MS) / 1000}s): ${stalled.join(", ")}. These agents may be stuck.`,
			type: "status",
		});
	}

	// 5. Track completed agents for summary
	const completed = listAgents("completed");
	completedSinceLastSummary = completed.length;

	// 6. Periodic health summary every 5 minutes
	const now = Date.now();
	if (now - lastSummaryAt >= SUMMARY_INTERVAL_MS) {
		sendHealthSummary(running.length, stalled.length);
		lastSummaryAt = now;
	}

	// 7. Clean up tracking for agents no longer running
	const runningNames = new Set(running.map((a) => a.name));
	for (const name of stdoutSizes.keys()) {
		if (!runningNames.has(name)) {
			stdoutSizes.delete(name);
		}
	}
}

/** Send a periodic health summary to the orchestrator */
function sendHealthSummary(runningCount: number, stalledCount: number): void {
	const completed = listAgents("completed");
	const failed = listAgents("failed");

	const lines = [
		`Running: ${runningCount}`,
		`Stalled: ${stalledCount}`,
		`Completed (total): ${completed.length}`,
		`Failed (total): ${failed.length}`,
	];

	sendMail({
		from: "watchdog",
		to: "orchestrator",
		subject: `Health summary: ${runningCount} running, ${stalledCount} stalled`,
		body: lines.join("\n"),
		type: "status",
	});
}
