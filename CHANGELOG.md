# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
