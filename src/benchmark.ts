/** Benchmark harness — collects, stores, and reports grove operation metrics */

import { getDb } from "./db.ts";
import type { BenchmarkMetric, BenchmarkRun } from "./types.ts";

/** Generate a unique run ID */
function generateRunId(): string {
	return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Collect all benchmark metrics from the current database state */
export function collectBenchmarks(): BenchmarkMetric[] {
	const db = getDb();
	const metrics: BenchmarkMetric[] = [];

	// ── 1. Spawn Latency ────────────────────────────────────────────────
	// Time from agent INSERT (created_at) to agent.spawn event (when PID assigned)
	const spawnLatencies = db
		.prepare(
			`SELECT a.name, a.capability,
			        (julianday(e.created_at) - julianday(a.created_at)) * 86400 AS latency_s
			 FROM agents a
			 JOIN events e ON e.agent = a.name AND e.type = 'agent.spawn'
			 WHERE a.status IN ('completed', 'failed', 'stopped', 'cleaned', 'running')
			 ORDER BY a.created_at DESC`,
		)
		.all() as Array<{ name: string; capability: string; latency_s: number }>;

	if (spawnLatencies.length > 0) {
		const values = spawnLatencies.map((r) => r.latency_s).sort((a, b) => a - b);
		metrics.push({
			metric: "spawn_latency_avg",
			value: round(avg(values)),
			unit: "seconds",
			detail: `n=${values.length}`,
		});
		metrics.push({
			metric: "spawn_latency_p50",
			value: round(percentile(values, 50)),
			unit: "seconds",
			detail: null,
		});
		metrics.push({
			metric: "spawn_latency_p90",
			value: round(percentile(values, 90)),
			unit: "seconds",
			detail: null,
		});

		// Per-capability spawn latency
		for (const cap of ["builder", "scout", "reviewer", "lead"] as const) {
			const capValues = spawnLatencies
				.filter((r) => r.capability === cap)
				.map((r) => r.latency_s);
			if (capValues.length > 0) {
				metrics.push({
					metric: `spawn_latency_avg_${cap}`,
					value: round(avg(capValues)),
					unit: "seconds",
					detail: `n=${capValues.length}`,
				});
			}
		}
	}

	// ── 2. Time to Completion ───────────────────────────────────────────
	// Time from agent creation to completion (only completed agents)
	const completionTimes = db
		.prepare(
			`SELECT name, capability,
			        (julianday(updated_at) - julianday(created_at)) * 86400 AS duration_s
			 FROM agents
			 WHERE status IN ('completed', 'cleaned')
			 ORDER BY created_at DESC`,
		)
		.all() as Array<{ name: string; capability: string; duration_s: number }>;

	if (completionTimes.length > 0) {
		const values = completionTimes.map((r) => r.duration_s).sort((a, b) => a - b);
		metrics.push({
			metric: "completion_time_avg",
			value: round(avg(values)),
			unit: "seconds",
			detail: `n=${values.length}`,
		});
		metrics.push({
			metric: "completion_time_p50",
			value: round(percentile(values, 50)),
			unit: "seconds",
			detail: null,
		});
		metrics.push({
			metric: "completion_time_p90",
			value: round(percentile(values, 90)),
			unit: "seconds",
			detail: null,
		});

		// Per-capability completion time
		for (const cap of ["builder", "scout", "reviewer", "lead"] as const) {
			const capValues = completionTimes
				.filter((r) => r.capability === cap)
				.map((r) => r.duration_s);
			if (capValues.length > 0) {
				metrics.push({
					metric: `completion_time_avg_${cap}`,
					value: round(avg(capValues)),
					unit: "seconds",
					detail: `n=${capValues.length}`,
				});
			}
		}
	}

	// ── 3. Agent Success Rate ───────────────────────────────────────────
	const agentCounts = db
		.prepare(
			`SELECT
			   COUNT(*) as total,
			   SUM(CASE WHEN status IN ('completed', 'cleaned') THEN 1 ELSE 0 END) as completed,
			   SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
			 FROM agents`,
		)
		.get() as { total: number; completed: number; failed: number };

	metrics.push({
		metric: "agent_count_total",
		value: agentCounts.total,
		unit: "count",
		detail: null,
	});
	metrics.push({
		metric: "agent_count_completed",
		value: agentCounts.completed,
		unit: "count",
		detail: null,
	});
	metrics.push({
		metric: "agent_count_failed",
		value: agentCounts.failed,
		unit: "count",
		detail: null,
	});

	const finishedTotal = agentCounts.completed + agentCounts.failed;
	if (finishedTotal > 0) {
		metrics.push({
			metric: "agent_success_rate",
			value: round(agentCounts.completed / finishedTotal),
			unit: "ratio",
			detail: `${agentCounts.completed}/${finishedTotal}`,
		});
	}

	// Per-capability counts
	const capCounts = db
		.prepare(
			`SELECT capability,
			   COUNT(*) as total,
			   SUM(CASE WHEN status IN ('completed', 'cleaned') THEN 1 ELSE 0 END) as completed,
			   SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
			 FROM agents GROUP BY capability`,
		)
		.all() as Array<{ capability: string; total: number; completed: number; failed: number }>;

	for (const cc of capCounts) {
		metrics.push({
			metric: `agent_count_${cc.capability}`,
			value: cc.total,
			unit: "count",
			detail: `completed=${cc.completed} failed=${cc.failed}`,
		});
	}

	// ── 4. Task Decomposition Quality ───────────────────────────────────
	// For each lead agent, count sub-agents and their success rate
	const leads = db
		.prepare(
			`SELECT name FROM agents WHERE capability = 'lead'`,
		)
		.all() as Array<{ name: string }>;

	if (leads.length > 0) {
		const decomps: number[] = [];
		const leadSuccessRates: number[] = [];

		for (const lead of leads) {
			const children = db
				.prepare(
					`SELECT
					   COUNT(*) as total,
					   SUM(CASE WHEN status IN ('completed', 'cleaned') THEN 1 ELSE 0 END) as completed
					 FROM agents WHERE parent_name = ?`,
				)
				.get(lead.name) as { total: number; completed: number };

			decomps.push(children.total);
			if (children.total > 0) {
				leadSuccessRates.push(children.completed / children.total);
			}
		}

		metrics.push({
			metric: "lead_sub_agents_avg",
			value: round(avg(decomps)),
			unit: "count",
			detail: `n=${leads.length} leads`,
		});
		metrics.push({
			metric: "lead_sub_agents_max",
			value: Math.max(...decomps),
			unit: "count",
			detail: null,
		});
		if (leadSuccessRates.length > 0) {
			metrics.push({
				metric: "lead_child_success_rate",
				value: round(avg(leadSuccessRates)),
				unit: "ratio",
				detail: `n=${leadSuccessRates.length} leads with children`,
			});
		}
	}

	// ── 5. Merge Metrics ────────────────────────────────────────────────
	const mergeCounts = db
		.prepare(
			`SELECT
			   COUNT(*) as total,
			   SUM(CASE WHEN status = 'merged' THEN 1 ELSE 0 END) as merged,
			   SUM(CASE WHEN status = 'conflict' THEN 1 ELSE 0 END) as conflict,
			   SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
			 FROM merge_queue`,
		)
		.get() as { total: number; merged: number; conflict: number; failed: number };

	metrics.push({
		metric: "merge_count_total",
		value: mergeCounts.total,
		unit: "count",
		detail: null,
	});
	if (mergeCounts.total > 0) {
		metrics.push({
			metric: "merge_success_rate",
			value: round(mergeCounts.merged / mergeCounts.total),
			unit: "ratio",
			detail: `merged=${mergeCounts.merged} conflict=${mergeCounts.conflict} failed=${mergeCounts.failed}`,
		});
	}

	// Merge tier breakdown
	const tierCounts = db
		.prepare(
			`SELECT resolved_tier, COUNT(*) as cnt
			 FROM merge_queue WHERE resolved_tier IS NOT NULL
			 GROUP BY resolved_tier`,
		)
		.all() as Array<{ resolved_tier: string; cnt: number }>;

	for (const tc of tierCounts) {
		metrics.push({
			metric: `merge_tier_${tc.resolved_tier.replace("-", "_")}`,
			value: tc.cnt,
			unit: "count",
			detail: null,
		});
	}

	// ── 6. Task Throughput ──────────────────────────────────────────────
	const taskCounts = db
		.prepare(
			`SELECT
			   COUNT(*) as total,
			   SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
			   SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
			   SUM(retry_count) as total_retries
			 FROM tasks`,
		)
		.get() as { total: number; completed: number; failed: number; total_retries: number };

	metrics.push({
		metric: "task_count_total",
		value: taskCounts.total,
		unit: "count",
		detail: `completed=${taskCounts.completed} failed=${taskCounts.failed}`,
	});
	if (taskCounts.total_retries > 0) {
		metrics.push({
			metric: "task_retries_total",
			value: taskCounts.total_retries,
			unit: "count",
			detail: null,
		});
	}

	// Task completion time (created → completed)
	const taskTimes = db
		.prepare(
			`SELECT task_id,
			        (julianday(updated_at) - julianday(created_at)) * 86400 AS duration_s
			 FROM tasks WHERE status = 'completed'`,
		)
		.all() as Array<{ task_id: string; duration_s: number }>;

	if (taskTimes.length > 0) {
		const values = taskTimes.map((r) => r.duration_s).sort((a, b) => a - b);
		metrics.push({
			metric: "task_completion_time_avg",
			value: round(avg(values)),
			unit: "seconds",
			detail: `n=${values.length}`,
		});
	}

	return metrics;
}

/** Store a benchmark run in the database */
export function storeBenchmarkRun(metrics: BenchmarkMetric[]): string {
	const db = getDb();
	const runId = generateRunId();
	const stmt = db.prepare(
		"INSERT INTO benchmarks (run_id, metric, value, unit, detail) VALUES (?, ?, ?, ?, ?)",
	);

	for (const m of metrics) {
		stmt.run(runId, m.metric, m.value, m.unit, m.detail);
	}

	return runId;
}

/** Get the previous benchmark run for comparison */
export function getPreviousRun(): BenchmarkRun[] | null {
	const db = getDb();
	const prevRunId = db
		.prepare(
			`SELECT DISTINCT run_id FROM benchmarks ORDER BY created_at DESC LIMIT 1 OFFSET 1`,
		)
		.get() as { run_id: string } | null;

	if (!prevRunId) return null;

	return db
		.prepare(
			`SELECT id, run_id as runId, metric, value, unit, detail, created_at as createdAt
			 FROM benchmarks WHERE run_id = ?`,
		)
		.all(prevRunId.run_id) as BenchmarkRun[];
}

/** Get the latest benchmark run */
export function getLatestRun(): BenchmarkRun[] | null {
	const db = getDb();
	const latestRunId = db
		.prepare(
			`SELECT DISTINCT run_id FROM benchmarks ORDER BY created_at DESC LIMIT 1`,
		)
		.get() as { run_id: string } | null;

	if (!latestRunId) return null;

	return db
		.prepare(
			`SELECT id, run_id as runId, metric, value, unit, detail, created_at as createdAt
			 FROM benchmarks WHERE run_id = ?`,
		)
		.all(latestRunId.run_id) as BenchmarkRun[];
}

/** List all benchmark run IDs with timestamps */
export function listRuns(): Array<{ runId: string; createdAt: string; metricCount: number }> {
	const db = getDb();
	return db
		.prepare(
			`SELECT run_id as runId, MIN(created_at) as createdAt, COUNT(*) as metricCount
			 FROM benchmarks GROUP BY run_id ORDER BY createdAt DESC`,
		)
		.all() as Array<{ runId: string; createdAt: string; metricCount: number }>;
}

/** Format seconds into a human-readable duration */
function fmtDuration(seconds: number): string {
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${mins}m ${secs.toFixed(0)}s`;
}

/** Format a metric value based on its unit */
function fmtValue(value: number, unit: string): string {
	switch (unit) {
		case "seconds":
			return fmtDuration(value);
		case "ratio":
			return `${(value * 100).toFixed(1)}%`;
		case "count":
			return String(value);
		default:
			return String(value);
	}
}

/** Format a comparison delta */
function fmtDelta(current: number, previous: number, unit: string): string {
	const diff = current - previous;
	if (Math.abs(diff) < 0.001) return "  (=)";
	const sign = diff > 0 ? "+" : "";

	// For ratios (success rates), higher is better
	// For seconds (latencies), lower is better
	const isBetter = unit === "ratio" ? diff > 0 : diff < 0;
	const arrow = isBetter ? " [better]" : " [worse]";

	if (unit === "seconds") return `  (${sign}${fmtDuration(diff)}${arrow})`;
	if (unit === "ratio") return `  (${sign}${(diff * 100).toFixed(1)}%${arrow})`;
	return `  (${sign}${diff}${arrow})`;
}

/** Display the benchmark report to stdout */
export function displayReport(
	metrics: BenchmarkMetric[],
	previousRun: BenchmarkRun[] | null,
): void {
	const prevMap = new Map<string, number>();
	if (previousRun) {
		for (const r of previousRun) {
			prevMap.set(r.metric, r.value);
		}
	}

	const get = (name: string): BenchmarkMetric | undefined =>
		metrics.find((m) => m.metric === name);
	const show = (label: string, m: BenchmarkMetric | undefined): void => {
		if (!m) return;
		const delta = prevMap.has(m.metric)
			? fmtDelta(m.value, prevMap.get(m.metric)!, m.unit)
			: "";
		const detail = m.detail ? `  (${m.detail})` : "";
		console.log(`  ${label.padEnd(30)} ${fmtValue(m.value, m.unit).padStart(10)}${delta}${detail}`);
	};

	console.log("\n=== Grove Benchmark Report ===\n");

	// Spawn Latency
	console.log("--- Spawn Latency ---");
	show("Average", get("spawn_latency_avg"));
	show("P50 (median)", get("spawn_latency_p50"));
	show("P90", get("spawn_latency_p90"));
	for (const cap of ["builder", "scout", "reviewer", "lead"]) {
		show(`  ${cap}`, get(`spawn_latency_avg_${cap}`));
	}

	// Time to Completion
	console.log("\n--- Time to Completion ---");
	show("Average", get("completion_time_avg"));
	show("P50 (median)", get("completion_time_p50"));
	show("P90", get("completion_time_p90"));
	for (const cap of ["builder", "scout", "reviewer", "lead"]) {
		show(`  ${cap}`, get(`completion_time_avg_${cap}`));
	}

	// Agent Success
	console.log("\n--- Agent Success ---");
	show("Total agents", get("agent_count_total"));
	show("Completed", get("agent_count_completed"));
	show("Failed", get("agent_count_failed"));
	show("Success rate", get("agent_success_rate"));
	for (const cap of ["builder", "scout", "reviewer", "lead"]) {
		show(`  ${cap} count`, get(`agent_count_${cap}`));
	}

	// Task Decomposition
	console.log("\n--- Task Decomposition ---");
	show("Avg sub-agents per lead", get("lead_sub_agents_avg"));
	show("Max sub-agents per lead", get("lead_sub_agents_max"));
	show("Child success rate", get("lead_child_success_rate"));

	// Merge
	console.log("\n--- Merge ---");
	show("Total merges", get("merge_count_total"));
	show("Merge success rate", get("merge_success_rate"));
	show("Clean merges", get("merge_tier_clean_merge"));
	show("Auto-resolved", get("merge_tier_auto_resolve"));

	// Task Throughput
	console.log("\n--- Task Throughput ---");
	show("Total tasks", get("task_count_total"));
	show("Total retries", get("task_retries_total"));
	show("Avg task completion time", get("task_completion_time_avg"));

	if (previousRun) {
		console.log(`\n(compared against previous run from ${previousRun[0]?.createdAt ?? "unknown"})`);
	} else {
		console.log("\n(no previous run for comparison)");
	}
	console.log("");
}

// ── Utility functions ───────────────────────────────────────────────────

function avg(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((s, v) => s + v, 0) / values.length;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = (p / 100) * (sorted.length - 1);
	const lower = Math.floor(idx);
	const upper = Math.ceil(idx);
	if (lower === upper) return sorted[lower]!;
	return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (idx - lower);
}

function round(v: number, decimals = 2): number {
	const f = 10 ** decimals;
	return Math.round(v * f) / f;
}
