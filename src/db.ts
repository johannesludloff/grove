import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

let _db: Database | null = null;

/** Get the .grove directory path for the current project */
export function groveDir(): string {
	try {
		const gitCommonDir = execSync("git rev-parse --git-common-dir", { encoding: "utf8" }).trim();
		const repoRoot = path.dirname(path.resolve(gitCommonDir));
		return path.join(repoRoot, ".grove");
	} catch {
		return path.join(process.cwd(), ".grove");
	}
}

/** Get or create the SQLite database */
export function getDb(): Database {
	if (_db) return _db;

	const dir = groveDir();
	if (!existsSync(dir)) {
		throw new Error("Grove not initialized. Run: grove init");
	}

	const dbPath = path.join(dir, "grove.db");
	_db = new Database(dbPath);
	_db.exec("PRAGMA journal_mode=WAL");
	_db.exec("PRAGMA busy_timeout=5000");

	// Ensure all tables exist (handles DBs created before new tables were added)
	ensureTables(_db);

	return _db;
}

/** Ensure all tables exist (idempotent, uses IF NOT EXISTS) */
function ensureTables(db: Database): void {
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

	// Migrate: add last_activity_at column if it doesn't exist yet
	try {
		db.exec("ALTER TABLE agents ADD COLUMN last_activity_at TEXT");
	} catch {
		// Column already exists — ignore
	}

	// Migrate: add depth column if it doesn't exist yet
	try {
		db.exec("ALTER TABLE agents ADD COLUMN depth INTEGER NOT NULL DEFAULT 0");
	} catch {
		// Column already exists — ignore
	}

	// Migrate: add retry_count column to tasks if it doesn't exist yet
	try {
		db.exec("ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
	} catch {
		// Column already exists — ignore
	}

	// Migrate: add session_id column to agents for --resume support
	try {
		db.exec("ALTER TABLE agents ADD COLUMN session_id TEXT");
	} catch {
		// Column already exists — ignore
	}
}

/** Initialize the database with all tables */
export function initDb(): Database {
	const dir = groveDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const dbPath = path.join(dir, "grove.db");
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA busy_timeout=5000");
	ensureTables(db);

	_db = db;
	return db;
}

/** Close the database connection */
export function closeDb(): void {
	if (_db) {
		_db.close();
		_db = null;
	}
}
