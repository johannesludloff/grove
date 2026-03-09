import { describe, test, expect } from "bun:test";
import { createTestDb } from "./helpers/test-db";

describe("db schema", () => {
	test("creates all expected tables", () => {
		const db = createTestDb();
		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all() as { name: string }[];
		const tableNames = tables.map((t) => t.name).sort();

		expect(tableNames).toEqual([
			"agents",
			"benchmarks",
			"events",
			"mail",
			"memories",
			"merge_queue",
			"tasks",
			"tool_metrics",
		]);
		db.close();
	});

	test("agents table has expected columns", () => {
		const db = createTestDb();
		const columns = db.prepare("PRAGMA table_info(agents)").all() as {
			name: string;
		}[];
		const colNames = columns.map((c) => c.name);

		expect(colNames).toContain("id");
		expect(colNames).toContain("name");
		expect(colNames).toContain("capability");
		expect(colNames).toContain("status");
		expect(colNames).toContain("pid");
		expect(colNames).toContain("worktree");
		expect(colNames).toContain("branch");
		expect(colNames).toContain("task_id");
		expect(colNames).toContain("parent_name");
		expect(colNames).toContain("depth");
		expect(colNames).toContain("last_activity_at");
		db.close();
	});

	test("tasks table has expected columns", () => {
		const db = createTestDb();
		const columns = db.prepare("PRAGMA table_info(tasks)").all() as {
			name: string;
		}[];
		const colNames = columns.map((c) => c.name);

		expect(colNames).toContain("task_id");
		expect(colNames).toContain("title");
		expect(colNames).toContain("description");
		expect(colNames).toContain("status");
		expect(colNames).toContain("assigned_to");
		expect(colNames).toContain("retry_count");
		db.close();
	});

	test("agents name has UNIQUE constraint", () => {
		const db = createTestDb();
		db.prepare(
			"INSERT INTO agents (name, capability, worktree, branch, task_id) VALUES (?, ?, ?, ?, ?)",
		).run("test-agent", "builder", "/tmp/wt", "grove/test", "task-1");

		expect(() => {
			db.prepare(
				"INSERT INTO agents (name, capability, worktree, branch, task_id) VALUES (?, ?, ?, ?, ?)",
			).run("test-agent", "scout", "/tmp/wt2", "grove/test2", "task-2");
		}).toThrow();
		db.close();
	});

	test("tasks task_id has UNIQUE constraint", () => {
		const db = createTestDb();
		db.prepare("INSERT INTO tasks (task_id, title) VALUES (?, ?)").run(
			"task-1",
			"Task 1",
		);

		expect(() => {
			db.prepare("INSERT INTO tasks (task_id, title) VALUES (?, ?)").run(
				"task-1",
				"Duplicate",
			);
		}).toThrow();
		db.close();
	});

	test("merge_queue status CHECK constraint rejects invalid values", () => {
		const db = createTestDb();

		// Valid status works
		db.prepare(
			"INSERT INTO merge_queue (branch_name, task_id, agent_name, status) VALUES (?, ?, ?, ?)",
		).run("grove/test", "task-1", "agent-1", "pending");

		// Invalid status throws
		expect(() => {
			db.prepare(
				"INSERT INTO merge_queue (branch_name, task_id, agent_name, status) VALUES (?, ?, ?, ?)",
			).run("grove/test2", "task-2", "agent-2", "invalid_status");
		}).toThrow();
		db.close();
	});

	test("schema creation is idempotent (IF NOT EXISTS)", () => {
		const db = createTestDb();
		// Running the same CREATE TABLE IF NOT EXISTS should not throw
		expect(() => {
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
				)
			`);
		}).not.toThrow();
		db.close();
	});

	test("indices are created", () => {
		const db = createTestDb();
		const indices = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all() as { name: string }[];
		const indexNames = indices.map((i) => i.name);

		expect(indexNames).toContain("idx_merge_queue_status");
		expect(indexNames).toContain("idx_merge_queue_branch_name");
		expect(indexNames).toContain("idx_tool_metrics_agent");
		expect(indexNames).toContain("idx_benchmarks_run_id");
		expect(indexNames).toContain("idx_benchmarks_metric");
		db.close();
	});

	test("default values are applied correctly", () => {
		const db = createTestDb();

		db.prepare(
			"INSERT INTO agents (name, capability, worktree, branch, task_id) VALUES (?, ?, ?, ?, ?)",
		).run("test-agent", "builder", "/tmp/wt", "grove/test", "task-1");

		const agent = db
			.prepare("SELECT status, depth FROM agents WHERE name = ?")
			.get("test-agent") as { status: string; depth: number };
		expect(agent.status).toBe("spawning");
		expect(agent.depth).toBe(0);

		db.prepare("INSERT INTO tasks (task_id, title) VALUES (?, ?)").run(
			"task-1",
			"Test",
		);
		const task = db
			.prepare(
				"SELECT status, retry_count, description FROM tasks WHERE task_id = ?",
			)
			.get("task-1") as {
			status: string;
			retry_count: number;
			description: string;
		};
		expect(task.status).toBe("pending");
		expect(task.retry_count).toBe(0);
		expect(task.description).toBe("");
		db.close();
	});
});
