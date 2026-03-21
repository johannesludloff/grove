# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.6] - 2026-03-21

### Fixed
- Use pipe mode for agent stdout/stderr to prevent silent output loss (root cause of agent stalling)

## [0.4.5] - 2026-03-21

### Added
- Experiment results logging — agents record what they tried and outcomes
- Prior results injection — future agents see past attempts in their prompt
- Experiment claiming — parallel agents claim approaches to prevent duplicate work
- Iteration budgets — tasks can have max_iterations limit
- Ratcheting guidance — builders auto-revert on failure and try new approaches
- New CLI commands: `task show`, `context`, `result`, `results`, `claim`, `claims`, `budget`
- Experiment tracking section in CLAUDE.md

## [0.4.4] - 2026-03-21

### Fixed
- Resolve 4 bugs causing stale tasks on dashboard (archived task filtering, task auto-complete, archive blocking, stale task reconciliation)
- Clean orphaned agents whose branches were manually deleted
- Mark unread mail as read when agents stop, exit, or get cleaned

## [0.4.1] - 2026-03-19

### Fixed
- `installAgentHooks` now replaces ALL agent hooks instead of spreading orchestrator hooks — agents no longer inherit orchestrator-only hooks (`grove prime`, `mail check orchestrator`, `mail deliver`) that caused leads to stall
- Scouts and reviewers now skip worktree creation and run directly on the main repo, reducing disk overhead and spawn latency

## [0.4.0] - 2026-03-17

### Added

#### Agent Lifecycle & Reliability
- Background watchdog for proactive agent health monitoring (stall detection, nudges, escalation)
- 60-second agent heartbeat with last-tool context for liveness tracking
- Agent hierarchy enforcement — leads can only spawn scouts/builders/reviewers
- Structured startup beacon injected into agent prompts (timestamp, depth, parent, capabilities)
- `GROVE_AGENT` env guard to isolate hooks from user sessions
- Per-capability PreToolUse guards for agent worktree safety
- Agent spawn now waits for child process exit and propagates signals correctly

#### Task Management
- Task status tracking with `grove task update` CLI command
- Auto-complete tasks when agents finish (with multi-agent safety guards)
- Auto-archive completed/failed tasks during `grove clean`
- Reactive mail check cron (every 2 minutes) for faster agent communication

#### Session Resume & Atomic Checkout
- Store Claude Code session IDs and support `--resume` on agent restart
- Atomic task checkout with `locked_by`/`locked_at` columns, `checkoutTask`/`releaseTask` functions
- Auto-checkout on spawn, auto-release on stop/complete/fail/timeout

#### Goal Ancestry
- Include parent task chain (goal ancestry) in agent prompts for better context

#### Agent Checkpoints
- Checkpoint support for long-running agents to save intermediate progress

#### Merge-Ready Protocol
- Agents send explicit `merge_ready` mail signal after commit + typecheck verification
- Orchestrator only merges branches that have received the merge_ready signal

#### AI Merge Resolution Enhancements
- Post-merge typecheck validation (`tsc --noEmit` after all branches merged)
- `--review` flag spawns integration-reviewer agent to check logical coherence
- CLAUDE.md sync guard warns when grove behavior changes without CLAUDE.md update

#### Overlay Templates
- Spec file templates for structured agent task descriptions
- File scope ownership to prevent parallel builder merge conflicts

#### Dashboard & CLI Improvements
- Redesigned CLAUDE.md with comprehensive workflow instructions and command reference

### Fixed
- Resolved agent lifecycle race condition between poller, `proc.exited`, and watchdog
- Made watchdog quieter and more tolerant of normal agent pauses
- Mark doneMail as read in SessionEnd hook to prevent duplicate processing
- Mark completion mail as read in `reconcileZombies`
- Corrected inverted assertion in orchestrator hierarchy test
- Removed unused imports and variables in `watchdog.ts`
- Auto-commit grove state files before merge to prevent dirty tree errors

## [0.3.0] - 2026-03-09

### Added

#### Performance Optimizations
- Parallelized `grove clean` with `Promise.allSettled` for concurrent worktree removal
- Parallelized agent spawn file writes with `Promise.all` to reduce spawn latency

#### Claude Code Native Feature Integration
- `grove cron setup/list/clear` — replaced `grove watch` daemon with CronCreate-based scheduling
- SessionEnd hook for instant agent exit detection
- PostToolUse hook with `grove metrics` command — tool success/failure tracking in `tool_metrics` table
- `grove benchmark run/report/history` — 31 metrics across 6 categories with historical comparison

#### Agent Reliability
- Auto-retry for failed agents (max 2 retries, `retry_count` in tasks table)
- Spawn rollback on failure (auto-cleanup of worktree and branch)
- Dirty tree guard before merge (auto-commit state files, abort on dirty tracked files)
- Per-lead agent budget ceiling (`MAX_AGENTS_PER_LEAD=5`, `--max-agents` override)
- Duplicate lead prevention (`checkDuplicateLead` blocks same-task concurrent leads)
- Pre-commit typecheck in Tier 2 merge (`tsc --noEmit` before committing auto-resolved `.ts` conflicts)

#### Orchestrator Completion Protocol
- `grove check-complete` — evaluates `allAgentsDone`, `tasksEmpty`, `mergeQueueEmpty` triggers

#### Agent Configuration
- `src/models.ts` — centralized model config with `resolveModel()` and `resolveEffort()`
- Per-capability effort levels (scouts/reviewers=medium, builders/leads=high)
- Scout timeout increased from 3min to 8min

#### Dashboard Redesign
- Hero metrics strip with running/completed/failed counts, unread mail, pending merges, refresh heartbeat
- Collapsed cleaned agents into dimmed summary line
- Color by meaning (green=running, dim=completed, red=failed, bold=lead)
- Feed fade by age (recent=bright, old=dim)
- Task status grouping with counts, in_progress first, completed hidden
- Compact mail/memory strips in single bottom row
- Files changed and Sub-agent count columns per agent row
- Stdout size indicator for running agents

#### Test Infrastructure
- 53 tests across 4 files (108 `expect()` calls, 143ms)
- `tests/db.test.ts` (9), `tests/tasks.test.ts` (15), `tests/agent.test.ts` (20), `tests/merge-resolver.test.ts` (9)
- `tests/helpers/test-db.ts` in-memory SQLite factory

### Changed
- `grove watch` removed, replaced by `grove cron setup`
- Model references centralized in `src/models.ts`
- `resolveConflictMarkers` exported for testability
- `CLAUDE.md` updated with cron commands

## [0.2.0] - 2026-03-08

Initial release with multi-agent orchestration, merge resolution, and dashboard.
