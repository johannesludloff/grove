/** Core types for Grove multi-agent orchestrator */

/** Agent capability/role */
export type AgentCapability = "builder" | "scout" | "reviewer" | "lead";

/** Agent lifecycle state */
export type AgentStatus = "spawning" | "running" | "completed" | "failed" | "stopped" | "cleaned";

/** Registered agent in the database */
export interface Agent {
	id: number;
	name: string;
	capability: AgentCapability;
	status: AgentStatus;
	pid: number | null;
	worktree: string;
	branch: string;
	taskId: string;
	parentName: string | null;
	depth: number;
	createdAt: string;
	updatedAt: string;
	lastActivityAt: string | null;
}

/** Message between agents */
export interface Mail {
	id: number;
	from: string;
	to: string;
	subject: string;
	body: string;
	type: MailType;
	read: boolean;
	createdAt: string;
}

export type MailType = "status" | "question" | "result" | "error" | "done";

/** Task in the task queue */
export interface Task {
	id: number;
	taskId: string;
	title: string;
	description: string;
	status: TaskStatus;
	assignedTo: string | null;
	retryCount: number;
	lockedBy: string | null;
	lockedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "archived";

/** Entry in the merge queue */
export interface MergeEntry {
	id: number;
	branchName: string;
	taskId: string;
	agentName: string;
	filesModified: string[];
	enqueuedAt: string;
	status: MergeStatus;
	resolvedTier: MergeTier | null;
}

export type MergeStatus = "pending" | "merging" | "merged" | "conflict" | "failed";
export type MergeTier = "clean-merge" | "auto-resolve";

/** Grove project config */
export interface GroveConfig {
	projectName: string;
	baseBranch: string;
	maxAgents: number;
	claudeModel: string;
}

/** Result of spawning an agent */
export interface SpawnResult {
	agent: Agent;
	pid: number;
	/** Resolves with the child process exit code when the agent process exits */
	exitPromise: Promise<number>;
}

/** A single benchmark metric */
export interface BenchmarkMetric {
	metric: string;
	value: number;
	unit: string;
	detail: string | null;
}

/** A stored benchmark run */
export interface BenchmarkRun {
	id: number;
	runId: string;
	metric: string;
	value: number;
	unit: string;
	detail: string | null;
	createdAt: string;
}

/** Tool usage metric from PostToolUse hook */
export interface ToolMetric {
	id: number;
	agentName: string;
	toolName: string;
	success: boolean;
	createdAt: string;
}
