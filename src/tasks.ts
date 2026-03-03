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
			        created_at as createdAt, updated_at as updatedAt
		   FROM tasks ${where} ORDER BY created_at ASC`,
		)
		.all(...params) as Task[];
}
