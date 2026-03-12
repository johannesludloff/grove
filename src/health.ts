/** Workflow health checks — detect problems and auto-create remediation tasks */

import { getDb } from "./db.ts";
import { listAgents, isPidAlive } from "./agent.ts";
import { createTask, getTask } from "./tasks.ts";
import { list as listMergeQueue } from "./merge-queue.ts";

/** Stale agent threshold — 10 minutes with no activity */
const STALE_AGENT_THRESHOLD_MS = 10 * 60_000;

/** A detected health problem */
export interface HealthProblem {
	type: "stale-agent" | "merge-conflict" | "merge-failed" | "orphaned-task";
	severity: "warning" | "error";
	summary: string;
	detail: string;
	taskId: string | null; // auto-created task ID, or null if task already exists
}

/** Run all health checks and return problems found */
export function runHealthChecks(opts?: { autoFix?: boolean }): HealthProblem[] {
	const autoFix = opts?.autoFix ?? true;
	const problems: HealthProblem[] = [];

	problems.push(...checkStaleAgents(autoFix));
	problems.push(...checkMergeProblems(autoFix));
	problems.push(...checkOrphanedTasks(autoFix));

	return problems;
}

/** Detect agents stuck in 'running' with stale last_activity_at */
function checkStaleAgents(autoFix: boolean): HealthProblem[] {
	const problems: HealthProblem[] = [];
	const running = listAgents("running");
	const now = Date.now();

	for (const agent of running) {
		// Skip agents without activity tracking
		if (!agent.lastActivityAt) continue;

		const lastActivity = new Date(agent.lastActivityAt).getTime();
		const staleDuration = now - lastActivity;

		if (staleDuration < STALE_AGENT_THRESHOLD_MS) continue;

		// Verify PID is still alive — if dead, reconcileZombies handles it
		if (agent.pid && !isPidAlive(agent.pid)) continue;

		const minutesStale = Math.round(staleDuration / 60_000);
		const taskId = `fix-stale-${agent.name}`;

		let createdTaskId: string | null = null;
		if (autoFix && !getTask(taskId)) {
			createTask({
				taskId,
				title: `Investigate stale agent: ${agent.name}`,
				description: `Agent "${agent.name}" (${agent.capability}) has been running with no activity for ${minutesStale} minutes. Last activity: ${agent.lastActivityAt}. Task: ${agent.taskId}. Consider stopping and re-spawning.`,
			});
			createdTaskId = taskId;
		}

		problems.push({
			type: "stale-agent",
			severity: "warning",
			summary: `Agent "${agent.name}" stale for ${minutesStale}m`,
			detail: `Capability: ${agent.capability}, task: ${agent.taskId}, last activity: ${agent.lastActivityAt}`,
			taskId: createdTaskId,
		});
	}

	return problems;
}

/** Detect merge conflicts and failures in the merge queue */
function checkMergeProblems(autoFix: boolean): HealthProblem[] {
	const problems: HealthProblem[] = [];

	const conflicts = listMergeQueue("conflict");
	const failures = listMergeQueue("failed");

	for (const entry of conflicts) {
		const taskId = `fix-merge-conflict-${entry.agentName}`;

		let createdTaskId: string | null = null;
		if (autoFix && !getTask(taskId)) {
			createTask({
				taskId,
				title: `Resolve merge conflict: ${entry.branchName}`,
				description: `Branch "${entry.branchName}" (agent: ${entry.agentName}, task: ${entry.taskId}) has merge conflicts. Files: ${entry.filesModified.join(", ") || "unknown"}. Resolve conflicts and retry merge.`,
			});
			createdTaskId = taskId;
		}

		problems.push({
			type: "merge-conflict",
			severity: "error",
			summary: `Merge conflict on ${entry.branchName}`,
			detail: `Agent: ${entry.agentName}, task: ${entry.taskId}`,
			taskId: createdTaskId,
		});
	}

	for (const entry of failures) {
		const taskId = `fix-merge-failed-${entry.agentName}`;

		let createdTaskId: string | null = null;
		if (autoFix && !getTask(taskId)) {
			createTask({
				taskId,
				title: `Fix failed merge: ${entry.branchName}`,
				description: `Branch "${entry.branchName}" (agent: ${entry.agentName}, task: ${entry.taskId}) failed to merge. Investigate the error and retry.`,
			});
			createdTaskId = taskId;
		}

		problems.push({
			type: "merge-failed",
			severity: "error",
			summary: `Merge failed for ${entry.branchName}`,
			detail: `Agent: ${entry.agentName}, task: ${entry.taskId}`,
			taskId: createdTaskId,
		});
	}

	return problems;
}

/** Detect in_progress tasks assigned to agents that are no longer running */
function checkOrphanedTasks(autoFix: boolean): HealthProblem[] {
	const problems: HealthProblem[] = [];
	const db = getDb();

	// Find in_progress tasks whose assigned agent is not running/spawning
	const orphaned = db
		.prepare(
			`SELECT t.task_id as taskId, t.title, t.assigned_to as assignedTo
			 FROM tasks t
			 WHERE t.status = 'in_progress'
			   AND t.assigned_to IS NOT NULL
			   AND NOT EXISTS (
			     SELECT 1 FROM agents a
			     WHERE a.name = t.assigned_to
			       AND a.status IN ('running', 'spawning')
			   )`,
		)
		.all() as { taskId: string; title: string; assignedTo: string }[];

	for (const task of orphaned) {
		const fixTaskId = `fix-orphaned-${task.taskId}`;

		let createdTaskId: string | null = null;
		if (autoFix && !getTask(fixTaskId)) {
			createTask({
				taskId: fixTaskId,
				title: `Re-queue orphaned task: ${task.title}`,
				description: `Task "${task.taskId}" is in_progress but its assigned agent "${task.assignedTo}" is no longer running. The task should be re-assigned or re-spawned.`,
			});
			createdTaskId = fixTaskId;
		}

		problems.push({
			type: "orphaned-task",
			severity: "error",
			summary: `Orphaned task "${task.taskId}" (agent ${task.assignedTo} dead)`,
			detail: `Title: ${task.title}, assigned to: ${task.assignedTo}`,
			taskId: createdTaskId,
		});
	}

	return problems;
}

/** Format health check results for CLI output */
export function formatHealthReport(problems: HealthProblem[]): string {
	if (problems.length === 0) {
		return "Health check: all clear — no problems detected.";
	}

	const lines: string[] = [];
	const errors = problems.filter((p) => p.severity === "error");
	const warnings = problems.filter((p) => p.severity === "warning");

	lines.push(`Health check: ${problems.length} problem(s) found`);
	if (errors.length > 0) lines.push(`  Errors: ${errors.length}`);
	if (warnings.length > 0) lines.push(`  Warnings: ${warnings.length}`);
	lines.push("");

	for (const p of problems) {
		const icon = p.severity === "error" ? "[ERROR]" : "[WARN]";
		lines.push(`${icon} ${p.summary}`);
		lines.push(`       ${p.detail}`);
		if (p.taskId) {
			lines.push(`       Auto-created task: ${p.taskId}`);
		}
	}

	return lines.join("\n");
}
