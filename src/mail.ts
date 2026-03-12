/** SQLite-based messaging between agents */

import { getDb } from "./db.ts";
import { emit } from "./events.ts";
import type { Mail, MailType } from "./types.ts";

/** Send a message to an agent */
export function sendMail(opts: {
	from: string;
	to: string;
	subject: string;
	body: string;
	type?: MailType;
}): Mail {
	const db = getDb();
	const type = opts.type ?? "status";

	const stmt = db.prepare(`
		INSERT INTO mail (from_agent, to_agent, subject, body, type)
		VALUES (?, ?, ?, ?, ?)
	`);
	const result = stmt.run(opts.from, opts.to, opts.subject, opts.body, type);

	const mail: Mail = {
		id: Number(result.lastInsertRowid),
		from: opts.from,
		to: opts.to,
		subject: opts.subject,
		body: opts.body,
		type,
		read: false,
		createdAt: new Date().toISOString(),
	};

	emit("mail.sent", `${opts.from} → ${opts.to}: ${opts.subject}`, { agent: opts.from });

	return mail;
}

/** Check unread messages for an agent */
export function checkMail(agentName: string): Mail[] {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT id, from_agent as 'from', to_agent as 'to', subject, body, type, read, created_at as createdAt
		 FROM mail WHERE to_agent = ? AND read = 0 ORDER BY created_at ASC`,
		)
		.all(agentName) as Mail[];

	return rows;
}

/** Mark a message as read */
export function markRead(messageId: number): void {
	const db = getDb();
	db.prepare("UPDATE mail SET read = 1 WHERE id = ?").run(messageId);
}

/** Check if an agent has sent a merge_ready mail */
export function hasMergeReadyMail(agentName: string): boolean {
	const db = getDb();
	const row = db
		.prepare("SELECT id FROM mail WHERE from_agent = ? AND type = 'merge_ready' LIMIT 1")
		.get(agentName) as { id: number } | null;
	return row !== null;
}

/** List all messages, optionally filtered */
export function listMail(opts?: { from?: string; to?: string; unread?: boolean }): Mail[] {
	const db = getDb();
	const conditions: string[] = [];
	const params: string[] = [];

	if (opts?.from) {
		conditions.push("from_agent = ?");
		params.push(opts.from);
	}
	if (opts?.to) {
		conditions.push("to_agent = ?");
		params.push(opts.to);
	}
	if (opts?.unread) {
		conditions.push("read = 0");
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	return db
		.prepare(
			`SELECT id, from_agent as 'from', to_agent as 'to', subject, body, type, read, created_at as createdAt
		 FROM mail ${where} ORDER BY created_at DESC LIMIT 50`,
		)
		.all(...params) as Mail[];
}
