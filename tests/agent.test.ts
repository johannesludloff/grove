import { describe, test, expect, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { createTestDb } from "./helpers/test-db";

let testDb: Database;

// Mock the db module — all dependent modules (events, mail, memory, tasks) will use this
mock.module("../src/db.ts", () => ({
	getDb: () => testDb,
	groveDir: () => "/tmp/grove-test",
	initDb: () => testDb,
	closeDb: () => {},
}));

// Mock worktree to prevent actual git operations
mock.module("../src/worktree.ts", () => ({
	createWorktree: async (name: string, _baseBranch: string) => ({
		worktreePath: `/tmp/worktrees/${name}`,
		branch: `grove/${name}`,
	}),
	removeWorktree: async () => {},
	listWorktrees: async () => [],
	getCurrentBranch: async () => "main",
}));

const {
	getAgent,
	listAgents,
	isPidAlive,
	reconcileZombies,
	spawnAgent,
	stopAgent,
	cleanAgent,
	HierarchyError,
} = await import("../src/agent.ts");

/** Insert an agent directly into the test DB */
function insertAgent(
	overrides: Partial<{
		name: string;
		capability: string;
		status: string;
		pid: number | null;
		worktree: string;
		branch: string;
		taskId: string;
		parentName: string | null;
		depth: number;
	}> = {},
) {
	const defaults = {
		name: "test-agent",
		capability: "builder",
		status: "running",
		pid: 9999999,
		worktree: "/tmp/wt",
		branch: "grove/test",
		taskId: "task-1",
		parentName: null,
		depth: 0,
	};
	const a = { ...defaults, ...overrides };

	testDb
		.prepare(
			`INSERT INTO agents (name, capability, status, pid, worktree, branch, task_id, parent_name, depth)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			a.name,
			a.capability,
			a.status,
			a.pid,
			a.worktree,
			a.branch,
			a.taskId,
			a.parentName,
			a.depth,
		);
}

describe("agent", () => {
	beforeEach(() => {
		testDb = createTestDb();
	});

	describe("getAgent", () => {
		test("returns null for nonexistent name", () => {
			expect(getAgent("no-such-agent")).toBeNull();
		});

		test("returns agent after DB insert", () => {
			insertAgent({ name: "my-builder" });
			const agent = getAgent("my-builder");

			expect(agent).not.toBeNull();
			expect(agent!.name).toBe("my-builder");
			expect(agent!.capability).toBe("builder");
			expect(agent!.status).toBe("running");
		});

		test("returns all agent fields correctly", () => {
			insertAgent({
				name: "full-agent",
				capability: "lead",
				status: "completed",
				pid: 12345,
				worktree: "/tmp/wt/full",
				branch: "grove/full-agent",
				taskId: "task-full",
				parentName: "orchestrator",
				depth: 1,
			});

			const agent = getAgent("full-agent");
			expect(agent!.capability).toBe("lead");
			expect(agent!.status).toBe("completed");
			expect(agent!.pid).toBe(12345);
			expect(agent!.branch).toBe("grove/full-agent");
			expect(agent!.taskId).toBe("task-full");
			expect(agent!.parentName).toBe("orchestrator");
			expect(agent!.depth).toBe(1);
		});
	});

	describe("listAgents", () => {
		test("returns all agents", () => {
			insertAgent({ name: "agent-1", taskId: "t1" });
			insertAgent({ name: "agent-2", taskId: "t2" });
			insertAgent({
				name: "agent-3",
				taskId: "t3",
				status: "completed",
			});

			const agents = listAgents();
			expect(agents).toHaveLength(3);
		});

		test("filters by status", () => {
			insertAgent({
				name: "agent-1",
				taskId: "t1",
				status: "running",
			});
			insertAgent({
				name: "agent-2",
				taskId: "t2",
				status: "completed",
			});
			insertAgent({
				name: "agent-3",
				taskId: "t3",
				status: "running",
			});

			const running = listAgents("running");
			expect(running).toHaveLength(2);

			const completed = listAgents("completed");
			expect(completed).toHaveLength(1);
			expect(completed[0]!.name).toBe("agent-2");
		});

		test("returns empty array when no agents match", () => {
			insertAgent({ name: "agent-1", taskId: "t1", status: "running" });

			const failed = listAgents("failed");
			expect(failed).toHaveLength(0);
		});
	});

	describe("isPidAlive", () => {
		test("returns false for invalid PID", () => {
			expect(isPidAlive(9999999)).toBe(false);
		});

		test("returns true for current process PID", () => {
			expect(isPidAlive(process.pid)).toBe(true);
		});
	});

	describe("spawnAgent — duplicate name check", () => {
		test("rejects duplicate active agent name (running)", async () => {
			insertAgent({ name: "busy-agent", status: "running" });

			await expect(
				spawnAgent({
					name: "busy-agent",
					capability: "builder",
					taskId: "task-new",
					taskDescription: "New task",
					baseBranch: "main",
				}),
			).rejects.toThrow('Agent "busy-agent" is already active');
		});

		test("rejects duplicate active agent name (spawning)", async () => {
			insertAgent({ name: "starting-agent", status: "spawning" });

			await expect(
				spawnAgent({
					name: "starting-agent",
					capability: "scout",
					taskId: "task-new",
					taskDescription: "New task",
					baseBranch: "main",
				}),
			).rejects.toThrow('Agent "starting-agent" is already active');
		});
	});

	describe("spawnAgent — depth ceiling", () => {
		test("rejects spawn depth exceeding default maximum (2)", async () => {
			insertAgent({
				name: "deep-parent",
				capability: "lead",
				depth: 2,
				status: "running",
			});

			await expect(
				spawnAgent({
					name: "too-deep",
					capability: "builder",
					taskId: "task-deep",
					taskDescription: "Deep task",
					baseBranch: "main",
					parentName: "deep-parent",
				}),
			).rejects.toThrow("Spawn depth 3 exceeds maximum 2");
		});

		test("rejects spawn depth exceeding custom maximum", async () => {
			insertAgent({
				name: "shallow-parent",
				capability: "lead",
				depth: 1,
				status: "running",
			});

			await expect(
				spawnAgent({
					name: "too-deep-custom",
					capability: "builder",
					taskId: "task-deep",
					taskDescription: "Deep task",
					baseBranch: "main",
					parentName: "shallow-parent",
					maxDepth: 1,
				}),
			).rejects.toThrow("Spawn depth 2 exceeds maximum 1");
		});
	});

	describe("spawnAgent — hierarchy enforcement", () => {
		test("blocks builder from spawning sub-agents", async () => {
			insertAgent({
				name: "parent-builder",
				capability: "builder",
				status: "running",
				taskId: "t-hier-1",
			});

			await expect(
				spawnAgent({
					name: "child-scout",
					capability: "scout",
					taskId: "t-hier-1b",
					taskDescription: "Scout task",
					baseBranch: "main",
					parentName: "parent-builder",
				}),
			).rejects.toThrow(HierarchyError);
		});

		test("blocks scout from spawning sub-agents", async () => {
			insertAgent({
				name: "parent-scout",
				capability: "scout",
				status: "running",
				taskId: "t-hier-2",
			});

			await expect(
				spawnAgent({
					name: "child-builder",
					capability: "builder",
					taskId: "t-hier-2b",
					taskDescription: "Build task",
					baseBranch: "main",
					parentName: "parent-scout",
				}),
			).rejects.toThrow("cannot spawn sub-agents");
		});

		test("blocks reviewer from spawning sub-agents", async () => {
			insertAgent({
				name: "parent-reviewer",
				capability: "reviewer",
				status: "running",
				taskId: "t-hier-3",
			});

			await expect(
				spawnAgent({
					name: "child-builder",
					capability: "builder",
					taskId: "t-hier-3b",
					taskDescription: "Build task",
					baseBranch: "main",
					parentName: "parent-reviewer",
				}),
			).rejects.toThrow("cannot spawn sub-agents");
		});

		test("blocks lead from spawning another lead", async () => {
			insertAgent({
				name: "parent-lead",
				capability: "lead",
				status: "running",
				taskId: "t-hier-4",
			});

			await expect(
				spawnAgent({
					name: "child-lead",
					capability: "lead",
					taskId: "t-hier-4b",
					taskDescription: "Lead task",
					baseBranch: "main",
					parentName: "parent-lead",
				}),
			).rejects.toThrow("cannot spawn a lead");
		});

		test("allows orchestrator (no parent) to spawn any capability", async () => {
			// This should pass hierarchy check — will fail later at Bun.spawn
			// but the hierarchy check itself should not throw
			await expect(
				spawnAgent({
					name: "top-level-lead",
					capability: "lead",
					taskId: "t-hier-5",
					taskDescription: "Lead task",
					baseBranch: "main",
				}),
			).rejects.not.toThrow(HierarchyError);
		});
	});

	describe("reconcileZombies", () => {
		test("marks dead-PID agents as failed", () => {
			insertAgent({
				name: "zombie-1",
				pid: 9999991,
				status: "running",
				taskId: "zt1",
			});
			insertAgent({
				name: "zombie-2",
				pid: 9999992,
				status: "spawning",
				taskId: "zt2",
			});

			const zombies = reconcileZombies();

			expect(zombies).toContain("zombie-1");
			expect(zombies).toContain("zombie-2");

			expect(getAgent("zombie-1")!.status).toBe("failed");
			expect(getAgent("zombie-2")!.status).toBe("failed");
		});

		test("skips agents that are not running/spawning", () => {
			insertAgent({
				name: "done-agent",
				pid: 9999993,
				status: "completed",
				taskId: "zt3",
			});
			insertAgent({
				name: "stopped-agent",
				pid: null,
				status: "stopped",
				taskId: "zt4",
			});

			const zombies = reconcileZombies();

			expect(zombies).not.toContain("done-agent");
			expect(zombies).not.toContain("stopped-agent");
			expect(getAgent("done-agent")!.status).toBe("completed");
			expect(getAgent("stopped-agent")!.status).toBe("stopped");
		});

		test("sends error mail for detected zombies", () => {
			insertAgent({
				name: "zombie-mailer",
				pid: 9999994,
				status: "running",
				taskId: "zt5",
			});

			reconcileZombies();

			const mails = testDb
				.prepare(
					"SELECT * FROM mail WHERE to_agent = 'orchestrator' AND type = 'error'",
				)
				.all() as { subject: string }[];
			expect(mails.length).toBeGreaterThan(0);
			expect(mails[0]!.subject).toContain("zombie-mailer");
		});

		test("returns empty array when no zombies", () => {
			insertAgent({
				name: "alive-agent",
				pid: process.pid,
				status: "running",
				taskId: "zt6",
			});

			const zombies = reconcileZombies();
			expect(zombies).toHaveLength(0);
		});
	});

	describe("stopAgent", () => {
		test("throws for nonexistent agent", async () => {
			await expect(stopAgent("ghost")).rejects.toThrow(
				'Agent "ghost" not found',
			);
		});

		test("throws for agent that is not running", async () => {
			insertAgent({
				name: "completed-agent",
				status: "completed",
				taskId: "t10",
			});

			await expect(stopAgent("completed-agent")).rejects.toThrow(
				"is not running",
			);
		});
	});

	describe("cleanAgent", () => {
		test("throws for nonexistent agent", async () => {
			await expect(cleanAgent("ghost")).rejects.toThrow(
				'Agent "ghost" not found',
			);
		});

		test("throws for agent that is still running", async () => {
			insertAgent({
				name: "active-agent",
				status: "running",
				taskId: "t11",
			});

			await expect(cleanAgent("active-agent")).rejects.toThrow(
				"still active",
			);
		});
	});
});
