/** Task queue for managing work items */

import { getDb } from "./db.ts";
import { emit } from "./events.ts";
import type { Task, TaskStatus } from "./types.ts";

/** Create a new task */
export function createTask(opts: {
	taskId: string;
	title: string;
	description?: string;
}): Task {
	const db = getDb();
	const stmt = db.prepare(`
		INSERT INTO tasks (task_id, title, description)
		VALUES (?, ?, ?)
	`);
	const result = stmt.run(opts.taskId, opts.title, opts.description ?? "");

	const task: Task = {
		id: Number(result.lastInsertRowid),
		taskId: opts.taskId,
		title: opts.title,
		description: opts.description ?? "",
		status: "pending",
		assignedTo: null,
		retryCount: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	emit("task.created", `Task "${opts.taskId}" created: ${opts.title}`);

	return task;
}

/** Get a task by its task ID */
export function getTask(taskId: string): Task | null {
	const db = getDb();
	const row = db
		.prepare(
			`SELECT id, task_id as taskId, title, description, status, assigned_to as assignedTo,
			        retry_count as retryCount, created_at as createdAt, updated_at as updatedAt
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
			        retry_count as retryCount, created_at as createdAt, updated_at as updatedAt
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
