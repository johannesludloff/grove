/** Overlay template system for agent prompts */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { AgentCapability } from "./types.ts";

/** Variables available in overlay templates */
export interface TemplateVars {
	agent_name: string;
	capability: AgentCapability;
	task_id: string;
	task_description: string;
	timestamp: string;
	depth: number;
	parent_name: string;
	branch_name: string;
	file_scope: string;
	prior_findings: string;
	checkpoint_block: string;
	memory_block: string;
	sibling_block: string;
	prior_work_block: string;
	goal_ancestry_block: string;
	prior_results_block: string;
	skip_scout: string;
	skip_review: string;
}

/** Cache loaded templates to avoid re-reading files */
const templateCache = new Map<AgentCapability, string>();

/**
 * Resolve the templates/ directory relative to project root.
 * Works both from src/ during development and from the project root.
 */
function getTemplatesDir(): string {
	// Try relative to this file's directory first (src/ -> ../templates/)
	const fromSrc = join(dirname(import.meta.dir), "templates");
	if (existsSync(fromSrc)) return fromSrc;

	// Fallback: relative to cwd
	const fromCwd = join(process.cwd(), "templates");
	if (existsSync(fromCwd)) return fromCwd;

	throw new Error(`Templates directory not found. Checked: ${fromSrc}, ${fromCwd}`);
}

/**
 * Load a template file for a given capability.
 * Templates are cached after first load.
 */
export function loadTemplate(capability: AgentCapability): string {
	const cached = templateCache.get(capability);
	if (cached) return cached;

	const templatesDir = getTemplatesDir();
	const templatePath = join(templatesDir, `${capability}.md.tmpl`);

	if (!existsSync(templatePath)) {
		throw new Error(`Template not found: ${templatePath}`);
	}

	const content = require("node:fs").readFileSync(templatePath, "utf-8");
	templateCache.set(capability, content);
	return content;
}

/**
 * Render a template by replacing mustache-style variables.
 *
 * Supports:
 * - `{{var}}` — simple variable substitution
 * - `{{#var}}...{{/var}}` — section rendered only if var is truthy/non-empty
 * - `{{^var}}...{{/var}}` — inverted section rendered only if var is falsy/empty
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
	let result = template;

	// Process sections: {{#var}}content{{/var}} — render content if var is truthy
	result = result.replace(
		/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
		(_match, key: string, content: string) => {
			const value = vars[key as keyof TemplateVars];
			if (value && String(value).trim().length > 0) {
				// Render the inner content with variable substitution
				return renderSimpleVars(content, vars);
			}
			return "";
		},
	);

	// Process inverted sections: {{^var}}content{{/var}} — render content if var is falsy
	result = result.replace(
		/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
		(_match, key: string, content: string) => {
			const value = vars[key as keyof TemplateVars];
			if (!value || String(value).trim().length === 0) {
				return renderSimpleVars(content, vars);
			}
			return "";
		},
	);

	// Process simple variable substitutions
	result = renderSimpleVars(result, vars);

	// Clean up multiple consecutive blank lines (more than 2)
	result = result.replace(/\n{4,}/g, "\n\n\n");

	return result;
}

/** Replace {{var}} tokens with their values */
function renderSimpleVars(text: string, vars: TemplateVars): string {
	return text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
		const value = vars[key as keyof TemplateVars];
		if (value === undefined || value === null) return "";
		return String(value);
	});
}

/**
 * Build a full agent prompt from an overlay template.
 * This is the main entry point — replaces the old inline buildPrompt().
 */
export function buildPromptFromTemplate(opts: {
	capability: AgentCapability;
	agentName: string;
	taskId: string;
	taskDescription: string;
	parentName?: string;
	depth?: number;
	branchName?: string;
	fileScope?: string;
	priorFindings?: string;
	checkpointBlock?: string;
	memoryBlock?: string;
	siblingBlock?: string;
	priorWorkBlock?: string;
	goalAncestryBlock?: string;
	priorResultsBlock?: string;
	skipScout?: boolean;
	skipReview?: boolean;
}): string {
	const template = loadTemplate(opts.capability);

	const vars: TemplateVars = {
		agent_name: opts.agentName,
		capability: opts.capability,
		task_id: opts.taskId,
		task_description: opts.taskDescription,
		timestamp: new Date().toISOString(),
		depth: opts.depth ?? 0,
		parent_name: opts.parentName ?? "orchestrator (top-level)",
		branch_name: opts.branchName ?? "",
		file_scope: opts.fileScope ?? "",
		prior_findings: opts.priorFindings ?? "",
		checkpoint_block: opts.checkpointBlock ?? "",
		memory_block: opts.memoryBlock ? `\n${opts.memoryBlock}\n` : "",
		sibling_block: opts.siblingBlock ? `\n${opts.siblingBlock}\n` : "",
		prior_work_block: opts.priorWorkBlock ? `\n${opts.priorWorkBlock}\n` : "",
		goal_ancestry_block: opts.goalAncestryBlock ?? "",
		prior_results_block: opts.priorResultsBlock || "",
		skip_scout: opts.skipScout ? "true" : "",
		skip_review: opts.skipReview ? "true" : "",
	};

	return renderTemplate(template, vars);
}

/** Clear the template cache (useful for testing or hot-reloading) */
export function clearTemplateCache(): void {
	templateCache.clear();
}
