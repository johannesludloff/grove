/** SQLite-backed FIFO merge queue */

import { getDb } from "./db.ts";
import { emit } from "./events.ts";
import type { MergeEntry, MergeStatus, MergeTier } from "./types.ts";

function rowToEntry(row: Record<string, unknown>): MergeEntry {
	return {
		id: row.id as number,
		branchName: row.branchName as string,
		taskId: row.taskId as string,
		agentName: row.agentName as string,
		filesModified: JSON.parse(row.filesModified as string),
		enqueuedAt: row.enqueuedAt as string,
		status: row.status as MergeStatus,
		resolvedTier: (row.resolvedTier as MergeTier | null) ?? null,
	};
}

/** Add a branch to the merge queue */
export function enqueue(opts: {
	branchName: string;
	taskId: string;
	agentName: string;
	filesModified?: string[];
}): MergeEntry {
	const db = getDb();
	const filesModified = JSON.stringify(opts.filesModified ?? []);

	const result = db
		.prepare(
			`INSERT INTO merge_queue (branch_name, task_id, agent_name, files_modified)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(opts.branchName, opts.taskId, opts.agentName, filesModified);

	const entry = db
		.prepare(
			`SELECT id, branch_name as branchName, task_id as taskId, agent_name as agentName,
			        files_modified as filesModified, enqueued_at as enqueuedAt, status, resolved_tier as resolvedTier
			 FROM merge_queue WHERE id = ?`,
		)
		.get(Number(result.lastInsertRowid)) as Record<string, unknown>;

	const mergeEntry = rowToEntry(entry);
	emit("merge.enqueued", `Branch "${opts.branchName}" enqueued for merge`, { agent: opts.agentName });

	return mergeEntry;
}

/** Dequeue the next pending entry (oldest first) and mark it as merging */
export function dequeue(): MergeEntry | null {
	const db = getDb();

	const row = db
		.prepare(
			`SELECT id, branch_name as branchName, task_id as taskId, agent_name as agentName,
			        files_modified as filesModified, enqueued_at as enqueuedAt, status, resolved_tier as resolvedTier
			 FROM merge_queue WHERE status = 'pending' ORDER BY id ASC LIMIT 1`,
		)
		.get() as Record<string, unknown> | null;

	if (!row) return null;

	db.prepare("UPDATE merge_queue SET status = 'merging' WHERE id = ?").run(row.id as number);
	row.status = "merging";

	const entry = rowToEntry(row);
	emit("merge.started", `Merging branch "${entry.branchName}"`, { agent: entry.agentName });

	return entry;
}

/** Peek at the next pending entry without dequeuing */
export function peek(): MergeEntry | null {
	const db = getDb();

	const row = db
		.prepare(
			`SELECT id, branch_name as branchName, task_id as taskId, agent_name as agentName,
			        files_modified as filesModified, enqueued_at as enqueuedAt, status, resolved_tier as resolvedTier
			 FROM merge_queue WHERE status = 'pending' ORDER BY id ASC LIMIT 1`,
		)
		.get() as Record<string, unknown> | null;

	return row ? rowToEntry(row) : null;
}

/** List merge queue entries, optionally filtered by status */
export function list(status?: MergeStatus): MergeEntry[] {
	const db = getDb();
	const where = status ? "WHERE status = ?" : "";
	const params = status ? [status] : [];

	const rows = db
		.prepare(
			`SELECT id, branch_name as branchName, task_id as taskId, agent_name as agentName,
			        files_modified as filesModified, enqueued_at as enqueuedAt, status, resolved_tier as resolvedTier
			 FROM merge_queue ${where} ORDER BY id ASC`,
		)
		.all(...params) as Record<string, unknown>[];

	return rows.map(rowToEntry);
}

/** Update the status of a merge queue entry */
export function updateStatus(
	id: number,
	status: MergeStatus,
	resolvedTier?: MergeTier,
): void {
	const db = getDb();

	if (resolvedTier !== undefined) {
		db.prepare("UPDATE merge_queue SET status = ?, resolved_tier = ? WHERE id = ?").run(
			status,
			resolvedTier,
			id,
		);
	} else {
		db.prepare("UPDATE merge_queue SET status = ? WHERE id = ?").run(status, id);
	}

	const row = db
		.prepare(
			`SELECT branch_name as branchName, agent_name as agentName FROM merge_queue WHERE id = ?`,
		)
		.get(id) as { branchName: string; agentName: string } | null;

	if (row) {
		if (status === "merged") {
			emit("merge.completed", `Branch "${row.branchName}" merged successfully`, { agent: row.agentName });
		} else if (status === "conflict") {
			emit("merge.conflict", `Branch "${row.branchName}" has merge conflicts`, { agent: row.agentName });
		} else if (status === "failed") {
			emit("merge.failed", `Branch "${row.branchName}" merge failed`, { agent: row.agentName });
		}
	}
}
