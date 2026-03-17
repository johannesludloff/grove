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
			        retry_count as retryCount, locked_by as lockedBy, locked_at as lockedAt,
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
			        retry_count as retryCount, locked_by as lockedBy, locked_at as lockedAt,
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
