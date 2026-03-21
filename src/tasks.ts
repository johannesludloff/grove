/** Task queue for managing work items */

import { getDb } from "./db.ts";
import { emit } from "./events.ts";
import type { ExperimentClaim, ExperimentOutcome, ExperimentResult, ResearchStatus, Task, TaskStatus } from "./types.ts";

/** Create a new task */
export function createTask(opts: {
	taskId: string;
	title: string;
	description?: string;
	dependsOn?: string[];
	parentTaskId?: string;
}): Task {
	const db = getDb();

	// Validate dependencies exist
	if (opts.dependsOn?.length) {
		for (const depId of opts.dependsOn) {
			const dep = db
				.prepare("SELECT task_id FROM tasks WHERE task_id = ?")
				.get(depId) as { task_id: string } | null;
			if (!dep) {
				throw new Error(`Dependency task "${depId}" not found`);
			}
		}
	}

	const hasUnmetDeps = opts.dependsOn?.length
		? hasUnresolvedDependencies(opts.dependsOn)
		: false;
	const initialStatus = hasUnmetDeps ? "blocked" : "pending";

	const stmt = db.prepare(`
		INSERT INTO tasks (task_id, title, description, status, parent_task_id)
		VALUES (?, ?, ?, ?, ?)
	`);
	const result = stmt.run(opts.taskId, opts.title, opts.description ?? "", initialStatus, opts.parentTaskId ?? null);

	// Record dependencies
	if (opts.dependsOn?.length) {
		const depStmt = db.prepare(
			"INSERT OR IGNORE INTO task_dependencies (task_id, depends_on) VALUES (?, ?)",
		);
		for (const depId of opts.dependsOn) {
			depStmt.run(opts.taskId, depId);
		}
	}

	const task: Task = {
		id: Number(result.lastInsertRowid),
		taskId: opts.taskId,
		title: opts.title,
		description: opts.description ?? "",
		status: initialStatus,
		assignedTo: null,
		parentTaskId: opts.parentTaskId ?? null,
		context: "",
		researchStatus: "pending",
		retryCount: 0,
		maxIterations: 0,
		iterationCount: 0,
		lockedBy: null,
		lockedAt: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	emit("task.created", `Task "${opts.taskId}" created: ${opts.title}${hasUnmetDeps ? " (blocked)" : ""}`);

	return task;
}

/** Get a task by its task ID */
export function getTask(taskId: string): Task | null {
	const db = getDb();
	const row = db
		.prepare(
			`SELECT id, task_id as taskId, title, description, status, assigned_to as assignedTo,
			        parent_task_id as parentTaskId, context, research_status as researchStatus,
			        retry_count as retryCount, max_iterations as maxIterations,
			        iteration_count as iterationCount, locked_by as lockedBy, locked_at as lockedAt,
			        created_at as createdAt, updated_at as updatedAt
		   FROM tasks WHERE task_id = ?`,
		)
		.get(taskId) as Task | null;

	return row;
}

/** Update task status and/or assignment */
export function updateTask(
	taskId: string,
	updates: { status?: TaskStatus; assignedTo?: string },
): void {
	const db = getDb();
	const sets: string[] = ["updated_at = datetime('now')"];
	const params: string[] = [];

	if (updates.status) {
		sets.push("status = ?");
		params.push(updates.status);
	}
	if (updates.assignedTo !== undefined) {
		sets.push("assigned_to = ?");
		params.push(updates.assignedTo);
	}

	params.push(taskId);
	db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE task_id = ?`).run(...params);

	if (updates.status) {
		const eventType = updates.status === "completed"
			? "task.completed"
			: updates.status === "failed"
			? "task.failed"
			: updates.status === "in_progress"
			? "task.assigned"
			: null;
		if (eventType) {
			emit(eventType, `Task "${taskId}" status → ${updates.status}`);
		}

		// When a task completes, check if it unblocks other tasks
		if (updates.status === "completed") {
			unblockDependents(taskId);
		}
	}
}

/** Set the context (gathered research) for a task */
export function setTaskContext(taskId: string, context: string): void {
	const db = getDb();
	const result = db
		.prepare(
			`UPDATE tasks SET context = ?, updated_at = datetime('now') WHERE task_id = ?`,
		)
		.run(context, taskId);

	if (result.changes === 0) {
		throw new Error(`Task "${taskId}" not found`);
	}

	emit("task.context_updated", `Task "${taskId}" context updated (${context.length} chars)`);
}

/** Update the research status of a task */
export function updateResearchStatus(taskId: string, researchStatus: ResearchStatus): void {
	const db = getDb();
	const result = db
		.prepare(
			`UPDATE tasks SET research_status = ?, updated_at = datetime('now') WHERE task_id = ?`,
		)
		.run(researchStatus, taskId);

	if (result.changes === 0) {
		throw new Error(`Task "${taskId}" not found`);
	}

	emit("task.research_status", `Task "${taskId}" research status → ${researchStatus}`);
}

/** List tasks, optionally filtered by status */
export function listTasks(status?: TaskStatus): Task[] {
	const db = getDb();
	const where = status ? "WHERE status = ?" : "";
	const params = status ? [status] : [];

	return db
		.prepare(
			`SELECT id, task_id as taskId, title, description, status, assigned_to as assignedTo,
			        parent_task_id as parentTaskId, context, research_status as researchStatus,
			        retry_count as retryCount, max_iterations as maxIterations,
			        iteration_count as iterationCount, locked_by as lockedBy, locked_at as lockedAt,
			        created_at as createdAt, updated_at as updatedAt
		   FROM tasks ${where} ORDER BY created_at DESC`,
		)
		.all(...params) as Task[];
}

/** Reconcile stale in_progress tasks whose agents are all in terminal states */
export function reconcileStaleTasks(): string[] {
	const db = getDb();
	// Find in_progress tasks where ALL agents are in terminal states
	const stale = db
		.prepare(
			`SELECT t.task_id as taskId FROM tasks t
			 WHERE t.status = 'in_progress'
			   AND EXISTS (
			     SELECT 1 FROM agents a WHERE a.task_id = t.task_id
			   )
			   AND NOT EXISTS (
			     SELECT 1 FROM agents a
			     WHERE a.task_id = t.task_id
			       AND a.status NOT IN ('completed', 'stopped', 'failed', 'cleaned')
			   )`,
		)
		.all() as { taskId: string }[];

	const reconciled: string[] = [];
	for (const { taskId } of stale) {
		db.prepare(
			"UPDATE tasks SET status = 'completed', updated_at = datetime('now') WHERE task_id = ?",
		).run(taskId);
		reconciled.push(taskId);
		emit("task.completed", `Task "${taskId}" auto-completed (all agents terminal)`);
	}

	return reconciled;
}

/** Archive completed/failed tasks that have no active agents */
export function archiveCompletedTasks(): string[] {
	reconcileStaleTasks();
	const db = getDb();
	// Find tasks that are completed or failed and have no running/spawning agents
	const archivable = db
		.prepare(
			`SELECT t.task_id as taskId FROM tasks t
			 WHERE t.status IN ('completed', 'failed')
			   AND NOT EXISTS (
			     SELECT 1 FROM agents a
			     WHERE a.task_id = t.task_id
			       AND a.status IN ('running', 'spawning')
			   )`,
		)
		.all() as { taskId: string }[];

	const archived: string[] = [];
	for (const { taskId } of archivable) {
		db.prepare(
			"UPDATE tasks SET status = 'archived', updated_at = datetime('now') WHERE task_id = ?",
		).run(taskId);
		archived.push(taskId);
		emit("task.archived", `Task "${taskId}" archived`);
	}

	return archived;
}

/** Traverse the parent task chain and return the goal ancestry (leaf → root order) */
export function getGoalAncestry(taskId: string): Array<{ taskId: string; title: string }> {
	const db = getDb();
	const ancestry: Array<{ taskId: string; title: string }> = [];
	let currentId: string | null = taskId;
	const seen = new Set<string>();
	const MAX_DEPTH = 10;

	while (currentId && ancestry.length < MAX_DEPTH) {
		if (seen.has(currentId)) break; // prevent cycles
		seen.add(currentId);

		const row = db
			.prepare(
				"SELECT task_id as taskId, title, parent_task_id as parentTaskId FROM tasks WHERE task_id = ?",
			)
			.get(currentId) as { taskId: string; title: string; parentTaskId: string | null } | null;

		if (!row) break;
		ancestry.push({ taskId: row.taskId, title: row.title });
		currentId = row.parentTaskId;
	}

	return ancestry;
}

/** Increment a task's retry count and return the new count */
export function incrementRetryCount(taskId: string): number {
	const db = getDb();
	db.prepare(
		`UPDATE tasks SET retry_count = retry_count + 1, updated_at = datetime('now') WHERE task_id = ?`,
	).run(taskId);

	const row = db
		.prepare("SELECT retry_count FROM tasks WHERE task_id = ?")
		.get(taskId) as { retry_count: number } | null;

	return row?.retry_count ?? 0;
}

/** Result of a checkout attempt */
export interface CheckoutResult {
	success: boolean;
	/** Name of the agent that holds the lock (if checkout failed) */
	lockedBy?: string;
}

/**
 * Atomically check out a task for an agent.
 * If the task is unlocked, locks it to the agent and returns success.
 * If already locked by another agent, returns failure with the lock holder.
 */
export function checkoutTask(taskId: string, agentName: string): CheckoutResult {
	const db = getDb();

	// Use a transaction for atomicity
	const result = db.transaction(() => {
		const row = db
			.prepare("SELECT locked_by, locked_at FROM tasks WHERE task_id = ?")
			.get(taskId) as { locked_by: string | null; locked_at: string | null } | null;

		if (!row) {
			throw new Error(`Task "${taskId}" not found`);
		}

		// Already locked by another agent
		if (row.locked_by && row.locked_by !== agentName) {
			return { success: false, lockedBy: row.locked_by };
		}

		// Lock it (or re-lock if same agent)
		db.prepare(
			`UPDATE tasks SET locked_by = ?, locked_at = datetime('now'), updated_at = datetime('now') WHERE task_id = ?`,
		).run(agentName, taskId);

		return { success: true };
	})();

	if (result.success) {
		emit("task.checkout", `Task "${taskId}" checked out by "${agentName}"`);
	}

	return result;
}

/**
 * Release the lock on a task, making it available for other agents.
 * Can be called by any agent or manually — always clears the lock.
 */
export function releaseTask(taskId: string): void {
	const db = getDb();
	const row = db
		.prepare("SELECT locked_by FROM tasks WHERE task_id = ?")
		.get(taskId) as { locked_by: string | null } | null;

	if (!row) {
		throw new Error(`Task "${taskId}" not found`);
	}

	db.prepare(
		`UPDATE tasks SET locked_by = NULL, locked_at = NULL, updated_at = datetime('now') WHERE task_id = ?`,
	).run(taskId);

	if (row.locked_by) {
		emit("task.release", `Task "${taskId}" lock released (was held by "${row.locked_by}")`);
	}
}

/** Check if any dependency tasks are not yet completed */
function hasUnresolvedDependencies(depIds: string[]): boolean {
	const db = getDb();
	for (const depId of depIds) {
		const dep = db
			.prepare("SELECT status FROM tasks WHERE task_id = ?")
			.get(depId) as { status: string } | null;
		if (!dep || dep.status !== "completed") {
			return true;
		}
	}
	return false;
}

/** When a task completes, unblock any tasks that depended on it */
function unblockDependents(completedTaskId: string): void {
	const db = getDb();
	const dependents = db
		.prepare(
			`SELECT DISTINCT td.task_id FROM task_dependencies td
			 JOIN tasks t ON t.task_id = td.task_id
			 WHERE td.depends_on = ? AND t.status = 'blocked'`,
		)
		.all(completedTaskId) as { task_id: string }[];

	for (const { task_id: depTaskId } of dependents) {
		const unmetDeps = db
			.prepare(
				`SELECT td.depends_on FROM task_dependencies td
				 JOIN tasks t ON t.task_id = td.depends_on
				 WHERE td.task_id = ? AND t.status != 'completed'`,
			)
			.all(depTaskId) as { depends_on: string }[];

		if (unmetDeps.length === 0) {
			db.prepare(
				"UPDATE tasks SET status = 'pending', updated_at = datetime('now') WHERE task_id = ?",
			).run(depTaskId);
			emit("task.unblocked", `Task "${depTaskId}" unblocked (all dependencies met)`);
		}
	}
}

/** Get the dependency task IDs for a given task */
export function getTaskDependencies(taskId: string): string[] {
	const db = getDb();
	const rows = db
		.prepare("SELECT depends_on FROM task_dependencies WHERE task_id = ?")
		.all(taskId) as { depends_on: string }[];
	return rows.map((r) => r.depends_on);
}

/** Log the result of an autoresearch experiment */
export function logExperimentResult(opts: {
	taskId: string;
	agentName: string;
	approach: string;
	outcome: ExperimentOutcome;
	metricName?: string;
	metricValue?: number;
	detail?: string;
}): ExperimentResult {
	const db = getDb();

	const stmt = db.prepare(`
		INSERT INTO experiment_results (task_id, agent_name, approach, outcome, metric_name, metric_value, detail)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`);
	const result = stmt.run(
		opts.taskId,
		opts.agentName,
		opts.approach,
		opts.outcome,
		opts.metricName ?? null,
		opts.metricValue ?? null,
		opts.detail ?? "",
	);

	const row = db
		.prepare(
			`SELECT id, task_id as taskId, agent_name as agentName, approach, outcome,
			        metric_name as metricName, metric_value as metricValue, detail,
			        created_at as createdAt
			 FROM experiment_results WHERE id = ?`,
		)
		.get(result.lastInsertRowid) as ExperimentResult;

	emit("task.experiment_logged", `Experiment on "${opts.taskId}" by ${opts.agentName}: ${opts.approach} → ${opts.outcome}`);

	return row;
}

/** Get experiment results for a task */
export function getExperimentResults(taskId: string, limit: number = 20): ExperimentResult[] {
	const db = getDb();

	return db
		.prepare(
			`SELECT id, task_id as taskId, agent_name as agentName, approach, outcome,
			        metric_name as metricName, metric_value as metricValue, detail,
			        created_at as createdAt
			 FROM experiment_results WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`,
		)
		.all(taskId, limit) as ExperimentResult[];
}

/** Claim an experiment approach to prevent duplicate work */
export function claimExperiment(opts: {
	taskId: string;
	agentName: string;
	approach: string;
}): { success: boolean; claimedBy?: string } {
	const db = getDb();

	try {
		db.prepare(
			`INSERT INTO experiment_claims (task_id, agent_name, approach, status)
			 VALUES (?, ?, ?, 'claimed')`,
		).run(opts.taskId, opts.agentName, opts.approach);

		emit("task.experiment_claimed", `Experiment "${opts.approach}" on "${opts.taskId}" claimed by ${opts.agentName}`);
		return { success: true };
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("UNIQUE constraint failed")) {
			const existing = db
				.prepare(
					`SELECT agent_name FROM experiment_claims
					 WHERE task_id = ? AND approach = ? AND status = 'claimed'`,
				)
				.get(opts.taskId, opts.approach) as { agent_name: string } | null;

			return { success: false, claimedBy: existing?.agent_name };
		}
		throw err;
	}
}

/** Release a claim on an experiment approach */
export function releaseClaim(taskId: string, agentName: string): void {
	const db = getDb();
	db.prepare(
		`UPDATE experiment_claims SET status = 'abandoned'
		 WHERE task_id = ? AND agent_name = ? AND status = 'claimed'`,
	).run(taskId, agentName);
}

/** Get active claims for a task */
export function getTaskClaims(taskId: string): ExperimentClaim[] {
	const db = getDb();

	return db
		.prepare(
			`SELECT id, task_id as taskId, agent_name as agentName, approach,
			        status, created_at as createdAt
			 FROM experiment_claims WHERE task_id = ? AND status = 'claimed'
			 ORDER BY created_at DESC`,
		)
		.all(taskId) as ExperimentClaim[];
}

/** Increment the iteration count for a task and check budget */
export function incrementIterationCount(taskId: string): { count: number; max: number; exhausted: boolean } {
	const db = getDb();

	db.prepare(
		`UPDATE tasks SET iteration_count = iteration_count + 1, updated_at = datetime('now') WHERE task_id = ?`,
	).run(taskId);

	const row = db
		.prepare("SELECT iteration_count, max_iterations FROM tasks WHERE task_id = ?")
		.get(taskId) as { iteration_count: number; max_iterations: number } | null;

	const count = row?.iteration_count ?? 0;
	const max = row?.max_iterations ?? 0;
	const exhausted = max > 0 && count >= max;

	if (exhausted) {
		emit("task.budget_exhausted", `Task "${taskId}" exhausted iteration budget (${count}/${max})`);
	}

	return { count, max, exhausted };
}

/** Set the maximum number of iterations for a task */
export function setMaxIterations(taskId: string, maxIterations: number): void {
	const db = getDb();
	db.prepare(
		`UPDATE tasks SET max_iterations = ?, updated_at = datetime('now') WHERE task_id = ?`,
	).run(maxIterations, taskId);
}

/** Build a markdown block summarizing prior experiment results from other agents */
export function buildPriorResultsBlock(taskId: string, selfName: string): string {
	const db = getDb();

	const rows = db
		.prepare(
			`SELECT approach, outcome, detail
			 FROM experiment_results WHERE task_id = ? AND agent_name != ?
			 ORDER BY created_at DESC LIMIT 10`,
		)
		.all(taskId, selfName) as { approach: string; outcome: string; detail: string }[];

	if (rows.length === 0) {
		return "";
	}

	const lines: string[] = [
		"## Prior Experiment Results",
		"| Approach | Outcome | Detail |",
		"|----------|---------|--------|",
	];

	for (const row of rows) {
		lines.push(`| ${row.approach} | ${row.outcome} | ${row.detail} |`);
	}

	return lines.join("\n");
}
