/** Persistent memory system — agents learn and share knowledge across sessions */

import { getDb } from "./db.ts";
import { emit } from "./events.ts";

export type MemoryType = "convention" | "pattern" | "failure" | "decision" | "fact";

export interface Memory {
	id: number;
	domain: string;
	type: MemoryType;
	content: string;
	sourceAgent: string;
	useCount: number;
	createdAt: string;
}

/** Maximum memories injected into a single agent prompt */
const MAX_INJECT = 20;

/** Maximum total memories before pruning triggers */
const MAX_TOTAL = 200;

/** Record a new memory (deduplicates by content similarity) */
export function addMemory(opts: {
	domain: string;
	type: MemoryType;
	content: string;
	sourceAgent: string;
}): Memory {
	const db = getDb();

	// Check for near-duplicate (exact match on content)
	const existing = db
		.prepare("SELECT id FROM memories WHERE content = ?")
		.get(opts.content) as { id: number } | null;

	if (existing) {
		// Bump use count instead of duplicating
		db.prepare("UPDATE memories SET use_count = use_count + 1 WHERE id = ?").run(existing.id);
		return getMemory(existing.id)!;
	}

	const stmt = db.prepare(`
		INSERT INTO memories (domain, type, content, source_agent)
		VALUES (?, ?, ?, ?)
	`);
	const result = stmt.run(opts.domain, opts.type, opts.content, opts.sourceAgent);

	// Prune if over limit
	const count = (db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
	if (count > MAX_TOTAL) {
		prune(count - MAX_TOTAL);
	}

	const memory = getMemory(Number(result.lastInsertRowid))!;

	emit("memory.added", `[${opts.domain}/${opts.type}] ${opts.content}`, { agent: opts.sourceAgent });

	return memory;
}

/** Get a single memory by ID */
function getMemory(id: number): Memory | null {
	const db = getDb();
	return db
		.prepare(
			`SELECT id, domain, type, content, source_agent as sourceAgent,
			        use_count as useCount, created_at as createdAt
		   FROM memories WHERE id = ?`,
		)
		.get(id) as Memory | null;
}

/** Query memories relevant to a task — used at agent spawn time */
export function queryMemories(opts?: {
	domain?: string;
	type?: MemoryType;
	capability?: string;
}): Memory[] {
	const db = getDb();
	const conditions: string[] = [];
	const params: string[] = [];

	if (opts?.domain) {
		conditions.push("domain = ?");
		params.push(opts.domain);
	}
	if (opts?.type) {
		conditions.push("type = ?");
		params.push(opts.type);
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	// Order by usefulness: high use_count first, then recent
	return db
		.prepare(
			`SELECT id, domain, type, content, source_agent as sourceAgent,
			        use_count as useCount, created_at as createdAt
		   FROM memories ${where}
		   ORDER BY use_count DESC, created_at DESC
		   LIMIT ?`,
		)
		.all(...params, MAX_INJECT) as Memory[];
}

/** Render memories into a text block for prompt injection */
export function renderMemories(memories: Memory[]): string {
	if (memories.length === 0) return "";

	const lines = ["## Project Knowledge (from previous agents)", ""];

	// Group by domain
	const byDomain = new Map<string, Memory[]>();
	for (const m of memories) {
		const list = byDomain.get(m.domain) ?? [];
		list.push(m);
		byDomain.set(m.domain, list);
	}

	for (const [domain, mems] of byDomain) {
		lines.push(`### ${domain}`);
		for (const m of mems) {
			lines.push(`- [${m.type}] ${m.content}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

/** List all memories */
export function listMemories(opts?: { domain?: string }): Memory[] {
	const db = getDb();
	if (opts?.domain) {
		return db
			.prepare(
				`SELECT id, domain, type, content, source_agent as sourceAgent,
				        use_count as useCount, created_at as createdAt
			   FROM memories WHERE domain = ? ORDER BY use_count DESC, created_at DESC`,
			)
			.all(opts.domain) as Memory[];
	}
	return db
		.prepare(
			`SELECT id, domain, type, content, source_agent as sourceAgent,
			        use_count as useCount, created_at as createdAt
		   FROM memories ORDER BY use_count DESC, created_at DESC`,
		)
		.all() as Memory[];
}

/** Remove a specific memory */
export function removeMemory(id: number): void {
	const db = getDb();
	db.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

/** Prune least-useful memories */
function prune(count: number): void {
	const db = getDb();
	// Delete lowest use_count, oldest first
	db.prepare(
		`DELETE FROM memories WHERE id IN (
			SELECT id FROM memories ORDER BY use_count ASC, created_at ASC LIMIT ?
		)`,
	).run(count);
}

/** Bump use_count for memories that were injected into an agent */
export function markUsed(memoryIds: number[]): void {
	if (memoryIds.length === 0) return;
	const db = getDb();
	const placeholders = memoryIds.map(() => "?").join(",");
	db.prepare(`UPDATE memories SET use_count = use_count + 1 WHERE id IN (${placeholders})`).run(
		...memoryIds,
	);
}
