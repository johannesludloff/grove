import { describe, test, expect, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { createTestDb } from "./helpers/test-db";

let testDb: Database;

// Mock the db module — all dependent modules (events, etc.) will use this too
mock.module("../src/db.ts", () => ({
	getDb: () => testDb,
	groveDir: () => "/tmp/grove-test",
	initDb: () => testDb,
	closeDb: () => {},
}));

const { createTask, getTask, updateTask, listTasks, incrementRetryCount } =
	await import("../src/tasks.ts");

describe("tasks", () => {
	beforeEach(() => {
		testDb = createTestDb();
	});

	test("createTask creates a task with pending status", () => {
		const task = createTask({ taskId: "test-1", title: "Test Task" });
		expect(task.taskId).toBe("test-1");
		expect(task.title).toBe("Test Task");
		expect(task.status).toBe("pending");
		expect(task.retryCount).toBe(0);
	});

	test("createTask stores description", () => {
		const task = createTask({
			taskId: "test-1",
			title: "Test",
			description: "A detailed description",
		});
		expect(task.description).toBe("A detailed description");
	});

	test("createTask defaults description to empty string", () => {
		const task = createTask({ taskId: "test-1", title: "Test" });
		expect(task.description).toBe("");
	});

	test("createTask generates auto-increment id", () => {
		const t1 = createTask({ taskId: "t1", title: "First" });
		const t2 = createTask({ taskId: "t2", title: "Second" });
		expect(t2.id).toBeGreaterThan(t1.id);
	});

	test("createTask with duplicate taskId throws", () => {
		createTask({ taskId: "dup-1", title: "First" });
		expect(() => {
			createTask({ taskId: "dup-1", title: "Second" });
		}).toThrow();
	});

	test("getTask returns existing task", () => {
		createTask({ taskId: "find-me", title: "Findable" });
		const task = getTask("find-me");
		expect(task).not.toBeNull();
		expect(task!.taskId).toBe("find-me");
		expect(task!.title).toBe("Findable");
		expect(task!.status).toBe("pending");
	});

	test("getTask returns null for nonexistent", () => {
		const task = getTask("does-not-exist");
		expect(task).toBeNull();
	});

	test("updateTask changes status to in_progress", () => {
		createTask({ taskId: "update-1", title: "Update Test" });
		updateTask("update-1", { status: "in_progress" });

		const task = getTask("update-1");
		expect(task!.status).toBe("in_progress");
	});

	test("updateTask changes status to completed", () => {
		createTask({ taskId: "complete-1", title: "Complete Test" });
		updateTask("complete-1", { status: "completed" });

		const task = getTask("complete-1");
		expect(task!.status).toBe("completed");
	});

	test("updateTask changes assignedTo", () => {
		createTask({ taskId: "assign-1", title: "Assign Test" });
		updateTask("assign-1", { assignedTo: "agent-1" });

		const task = getTask("assign-1");
		expect(task!.assignedTo).toBe("agent-1");
	});

	test("listTasks returns all tasks", () => {
		createTask({ taskId: "list-1", title: "First" });
		createTask({ taskId: "list-2", title: "Second" });
		createTask({ taskId: "list-3", title: "Third" });

		const tasks = listTasks();
		expect(tasks).toHaveLength(3);
	});

	test("listTasks filters by status", () => {
		createTask({ taskId: "filter-1", title: "Pending" });
		createTask({ taskId: "filter-2", title: "In Progress" });
		updateTask("filter-2", { status: "in_progress" });

		const pending = listTasks("pending");
		expect(pending).toHaveLength(1);
		expect(pending[0]!.taskId).toBe("filter-1");

		const inProgress = listTasks("in_progress");
		expect(inProgress).toHaveLength(1);
		expect(inProgress[0]!.taskId).toBe("filter-2");
	});

	test("incrementRetryCount increments and returns new count", () => {
		createTask({ taskId: "retry-1", title: "Retry Test" });

		const count1 = incrementRetryCount("retry-1");
		expect(count1).toBe(1);

		const count2 = incrementRetryCount("retry-1");
		expect(count2).toBe(2);

		const count3 = incrementRetryCount("retry-1");
		expect(count3).toBe(3);
	});

	test("incrementRetryCount returns 0 for nonexistent task", () => {
		const count = incrementRetryCount("no-such-task");
		expect(count).toBe(0);
	});

	test("status transitions are persisted across reads", () => {
		createTask({ taskId: "transition-1", title: "Transition" });

		updateTask("transition-1", { status: "in_progress" });
		expect(getTask("transition-1")!.status).toBe("in_progress");

		updateTask("transition-1", { status: "failed" });
		expect(getTask("transition-1")!.status).toBe("failed");

		updateTask("transition-1", { status: "pending" });
		expect(getTask("transition-1")!.status).toBe("pending");

		updateTask("transition-1", { status: "completed" });
		expect(getTask("transition-1")!.status).toBe("completed");
	});
});
