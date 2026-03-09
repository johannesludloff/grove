/**
 * Creates a fresh in-memory SQLite database with the full Grove schema.
 * Mirrors the schema from src/db.ts ensureTables().
 */

import { Database } from "bun:sqlite";

export function createTestDb(): Database {
	const db = new Database(":memory:");
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA busy_timeout=5000");

	db.exec(`
		CREATE TABLE IF NOT EXISTS agents (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT UNIQUE NOT NULL,
			capability TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'spawning',
			pid INTEGER,
			worktree TEXT NOT NULL,
			branch TEXT NOT NULL,
			task_id TEXT NOT NULL,
			parent_name TEXT,
			depth INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_activity_at TEXT
		);

		CREATE TABLE IF NOT EXISTS mail (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			from_agent TEXT NOT NULL,
			to_agent TEXT NOT NULL,
			subject TEXT NOT NULL,
			body TEXT NOT NULL,
			type TEXT NOT NULL DEFAULT 'status',
			read INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS memories (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			domain TEXT NOT NULL,
			type TEXT NOT NULL,
			content TEXT NOT NULL,
			source_agent TEXT NOT NULL DEFAULT 'orchestrator',
			use_count INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			type TEXT NOT NULL,
			agent TEXT,
			summary TEXT NOT NULL,
			detail TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS tasks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id TEXT UNIQUE NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'pending',
			assigned_to TEXT,
			retry_count INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS merge_queue (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			branch_name TEXT NOT NULL,
			task_id TEXT NOT NULL,
			agent_name TEXT NOT NULL,
			files_modified TEXT NOT NULL DEFAULT '[]',
			enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
			status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','merging','merged','conflict','failed')),
			resolved_tier TEXT CHECK(resolved_tier IS NULL OR resolved_tier IN ('clean-merge','auto-resolve'))
		);

		CREATE TABLE IF NOT EXISTS tool_metrics (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			agent_name TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			success INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_merge_queue_status ON merge_queue(status);
		CREATE INDEX IF NOT EXISTS idx_merge_queue_branch_name ON merge_queue(branch_name);
		CREATE INDEX IF NOT EXISTS idx_tool_metrics_agent ON tool_metrics(agent_name);

		CREATE TABLE IF NOT EXISTS benchmarks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id TEXT NOT NULL,
			metric TEXT NOT NULL,
			value REAL NOT NULL,
			unit TEXT NOT NULL,
			detail TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_benchmarks_run_id ON benchmarks(run_id);
		CREATE INDEX IF NOT EXISTS idx_benchmarks_metric ON benchmarks(metric);
	`);

	return db;
}
