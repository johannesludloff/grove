/** Model configuration for Grove agents */
import type { AgentCapability } from "./types";

/** Default Claude model for builder and lead agents */
export const DEFAULT_POWER_MODEL = "claude-opus-4-6";

/** Default Claude model for scout and reviewer agents */
export const DEFAULT_FAST_MODEL = "claude-sonnet-4-6";

/** Default Claude model per capability */
export const CAPABILITY_MODELS: Record<AgentCapability, string> = {
	builder: DEFAULT_POWER_MODEL,
	scout: DEFAULT_FAST_MODEL,
	reviewer: DEFAULT_FAST_MODEL,
	lead: DEFAULT_POWER_MODEL,
};

/** Effort level per capability — scouts and reviewers use lower effort since they only read */
export type EffortLevel = "low" | "medium" | "high";

export const CAPABILITY_EFFORT: Record<AgentCapability, EffortLevel> = {
	builder: "high",
	scout: "medium",
	reviewer: "medium",
	lead: "high",
};

/** Resolve the model for a given capability, with optional override */
export function resolveModel(capability: AgentCapability, override?: string): string {
	return override ?? CAPABILITY_MODELS[capability];
}

/** Resolve the effort level for a given capability */
export function resolveEffort(capability: AgentCapability): EffortLevel {
	return CAPABILITY_EFFORT[capability];
}
