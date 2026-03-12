/** Background watchdog for proactive agent health monitoring */

import { listAgents, isPidAlive, reconcileZombies } from "./agent.ts";
import { sendMail } from "./mail.ts";
import { emit } from "./events.ts";
import { runHealthChecks, formatHealthReport } from "./health.ts";

/** Watchdog check interval in ms (30 seconds) */
const CHECK_INTERVAL_MS = 30_000;

/** Number of consecutive stall checks before warning (4 checks = ~2 minutes) */
const STALL_THRESHOLD = 4;

/** Minimum agent age in ms before stall warnings apply (3 minutes) */
const MIN_AGE_FOR_STALL_MS = 3 * 60_000;

/** Summary interval in ms (5 minutes) */
const SUMMARY_INTERVAL_MS = 5 * 60_000;

/** Track stdout sizes for stall detection */
const stdoutSizes = new Map<string, { size: number; stallCount: number }>();

/** Active interval handle */
let watchdogInterval: ReturnType<typeof setInterval> | null = null;

/** Timestamp of last summary */
let lastSummaryAt = Date.now();

/** Whether watchdog is running */
export function isWatchdogRunning(): boolean {
	return watchdogInterval !== null;
}

/** Start the background watchdog loop */
export function startWatchdog(): void {
	if (watchdogInterval) return; // Already running

	lastSummaryAt = Date.now();
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

	// 4. Send stall warnings (only for agents running at least 3 minutes)
	const now = Date.now();
	const matureStalled = stalled.filter((name) => {
		const agent = running.find((a) => a.name === name);
		if (!agent?.createdAt) return true; // fallback: include if no timestamp
		return now - new Date(agent.createdAt).getTime() >= MIN_AGE_FOR_STALL_MS;
	});
	if (matureStalled.length > 0) {
		sendMail({
			from: "watchdog",
			to: "orchestrator",
			subject: `Stalled agents: ${matureStalled.join(", ")}`,
			body: `Watchdog detected ${matureStalled.length} agent(s) with no output growth for ${STALL_THRESHOLD} consecutive checks (~${(STALL_THRESHOLD * CHECK_INTERVAL_MS) / 1000}s): ${matureStalled.join(", ")}. These agents may be stuck.`,
			type: "status",
		});
	}

	// 5. Periodic health summary every 5 minutes (skip when no agents running)
	if (running.length > 0 && now - lastSummaryAt >= SUMMARY_INTERVAL_MS) {
		sendHealthSummary(running.length, matureStalled.length);
		lastSummaryAt = now;

		// 6. Run workflow health checks during summary cycle
		try {
			const problems = runHealthChecks({ autoFix: true });
			if (problems.length > 0) {
				sendMail({
					from: "watchdog",
					to: "orchestrator",
					subject: `Health: ${problems.length} workflow problem(s) detected`,
					body: formatHealthReport(problems),
					type: problems.some((p) => p.severity === "error") ? "error" : "status",
				});
			}
		} catch {
			// Health checks must never crash the watchdog
		}
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
