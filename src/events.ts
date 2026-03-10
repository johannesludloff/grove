/** Event log — records everything that happens for the live feed */

import { getDb } from "./db.ts";

export type EventType =
	| "agent.spawn"
	| "agent.running"
	| "agent.completed"
	| "agent.failed"
	| "agent.stopped"
	| "task.created"
	| "task.assigned"
	| "task.completed"
	| "task.failed"
	| "task.archived"
	| "mail.sent"
	| "memory.added"
	| "merge.enqueued"
	| "merge.started"
	| "merge.completed"
	| "merge.conflict"
	| "merge.failed";

export interface GroveEvent {
	id: number;
	type: EventType;
	agent: string | null;
	summary: string;
	detail: string | null;
	createdAt: string;
}

/** Record an event */
export function emit(type: EventType, summary: string, opts?: { agent?: string; detail?: string }): void {
	const db = getDb();
	db.prepare("INSERT INTO events (type, agent, summary, detail) VALUES (?, ?, ?, ?)").run(
		type,
		opts?.agent ?? null,
		summary,
		opts?.detail ?? null,
	);
}

/** Get events newer than a given ID */
export function eventsSince(afterId: number, limit = 50): GroveEvent[] {
	const db = getDb();
	return db
		.prepare(
			`SELECT id, type, agent, summary, detail, created_at as createdAt
			 FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`,
		)
		.all(afterId, limit) as GroveEvent[];
}

/** Get the most recent events */
export function recentEvents(limit = 30): GroveEvent[] {
	const db = getDb();
	return db
		.prepare(
			`SELECT id, type, agent, summary, detail, created_at as createdAt
			 FROM events ORDER BY id DESC LIMIT ?`,
		)
		.all(limit) as GroveEvent[];
}

/** Get the latest event ID (for initializing the cursor) */
export function latestEventId(): number {
	const db = getDb();
	const row = db.prepare("SELECT MAX(id) as maxId FROM events").get() as { maxId: number | null } | null;
	return row?.maxId ?? 0;
}
