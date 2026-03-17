/** Task queue for managing work items */

import { getDb } from "./db.ts";
import { emit } from "./events.ts";
import type { Task, TaskStatus } from "./types.ts";

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
		retryCount: 0,
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
			        parent_task_id as parentTaskId, retry_count as retryCount,
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

/** List tasks, optionally filtered by status */
export function listTasks(status?: TaskStatus): Task[] {
	const db = getDb();
	const where = status ? "WHERE status = ?" : "";
	const params = status ? [status] : [];

	return db
		.prepare(
			`SELECT id, task_id as taskId, title, description, status, assigned_to as assignedTo,
			        parent_task_id as parentTaskId, retry_count as retryCount,
			        created_at as createdAt, updated_at as updatedAt
		   FROM tasks ${where} ORDER BY created_at DESC`,
		)
		.all(...params) as Task[];
}

/** Archive completed/failed tasks that have no active agents */
export function archiveCompletedTasks(): string[] {
	const db = getDb();
	// Find tasks that are completed or failed and have no running/spawning agents
	const archivable = db
		.prepare(
			`SELECT t.task_id as taskId FROM tasks t
			 WHERE t.status IN ('completed', 'failed')
			   AND NOT EXISTS (
			     SELECT 1 FROM agents a
			     WHERE a.task_id = t.task_id
			       AND a.status IN ('running', 'spawning', 'completed')
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

/** Check if any of the given dependency task IDs are not yet completed */
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

	// Find all blocked tasks that depend on the completed task
	const dependents = db
		.prepare(
			`SELECT DISTINCT td.task_id FROM task_dependencies td
			 JOIN tasks t ON t.task_id = td.task_id
			 WHERE td.depends_on = ? AND t.status = 'blocked'`,
		)
		.all(completedTaskId) as { task_id: string }[];

	for (const { task_id: depTaskId } of dependents) {
		// Check if ALL dependencies of this task are now completed
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

/** Get tasks that depend on a given task */
export function getTaskDependents(taskId: string): string[] {
	const db = getDb();
	const rows = db
		.prepare("SELECT task_id FROM task_dependencies WHERE depends_on = ?")
		.all(taskId) as { task_id: string }[];
	return rows.map((r) => r.task_id);
}
