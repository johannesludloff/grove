# Paperclip Analysis — Lessons for Grove

## Executive Summary

Paperclip is a **control plane for autonomous AI companies** — not an agent framework. It orchestrates diverse AI agents (Claude Code, Codex, Cursor, etc.) into functioning organizations with hierarchy, budgets, governance, and audit trails. Its core innovation: the **heartbeat protocol** — agents wake in bounded execution windows, do discrete work, then sleep. This is fundamentally different from our always-on subprocess model.

---

## Key Architectural Differences

| Aspect | Grove | Paperclip |
|--------|-------|-----------|
| **Execution model** | Continuous subprocess (agent runs until done) | Discrete heartbeat (agent wakes, works, sleeps) |
| **Agent runtime** | Claude Code only | Framework-agnostic (7 adapters) |
| **State persistence** | Checkpoints in files | Session IDs in database, resume on next heartbeat |
| **Task ownership** | Implicit (agent assigned to task) | Atomic checkout with 409 conflict semantics |
| **Cost control** | None | Per-agent monthly budgets with auto-pause |
| **Governance** | None | Approval gates, immutable audit logs |
| **Memory** | Grove memory system (domain/type) | Session persistence + issue comment threads |
| **Routing** | Manual (orchestrator decides) | Organizational hierarchy (manager delegates) |
| **Observability** | Watchdog + mail + dashboard | Real-time WebSocket + immutable audit log |

---

## What We Should Adopt (Priority Order)

### 1. Atomic Task Checkout (HIGH — prevents double-work)

**The problem we have:** Multiple agents can be accidentally assigned the same task. When we retry a failed agent, the old one might still be running.

**Paperclip's solution:** `POST /api/issues/{id}/checkout` returns 200 (acquired) or 409 (already owned). Only one agent can own a task at a time.

**For Grove:** Add a `grove task checkout <id> --agent <name>` command that atomically locks a task. If already locked by another agent, reject with a clear error. The spawn logic should auto-checkout the task. When an agent is stopped, release the lock.

### 2. Idempotent Status Updates (HIGH — prevents duplicate work)

**The problem we have:** When agents retry or the watchdog reconciles, we sometimes get duplicate task status changes or duplicate mail.

**Paperclip's solution:** Every mutation includes `X-Paperclip-Run-Id` header. Same run ID submitted twice returns same result. No duplicates.

**For Grove:** Add a `runId` field to agent status updates, mail sends, and task mutations. The DB layer deduplicates by run ID.

### 3. Budget/Cost Tracking (MEDIUM — prevents runaway spending)

**The problem we have:** No visibility into how much each agent costs. A stalled agent burning tokens for 8 minutes wastes money silently.

**Paperclip's solution:** Per-agent monthly budgets. At 80% utilization → warning. At 100% → auto-pause. Token costs tracked per run.

**For Grove:** Track token usage from agent stdout (Claude Code reports tokens). Add `grove metrics cost` command. Set per-agent budget limits. Auto-stop agents that exceed budget.

### 4. Heartbeat Coalescing (MEDIUM — prevents wasted work)

**The problem we have:** Multiple watchdog checks, mail deliveries, and status polls can trigger redundant operations.

**Paperclip's solution:** Wake requests arriving within 250ms coalesce into a single execution. If already running, queue the request.

**For Grove:** Apply this to our watchdog checks and mail delivery. If a check is already in-flight, skip the next one.

### 5. Session Resume Instead of Restart (HIGH — preserves context)

**The problem we have:** When an agent stalls and we restart it, it starts from scratch. Even with checkpoints, the new agent doesn't have the original's full conversation context.

**Paperclip's solution:** Session IDs stored in database. Next heartbeat runs `claude --resume <session-id>`. Full conversation preserved.

**For Grove:** Store the Claude Code session ID when spawning agents. When restarting a stalled agent, use `--resume` to continue from where it left off instead of starting fresh.

### 6. Immutable Audit Log (LOW — improves observability)

**The problem we have:** Agent logs are in files that can be overwritten. No centralized record of what happened.

**Paperclip's solution:** Append-only `activity_logs` table. Every tool call, API request, decision, cost logged. No edits, no deletes.

**For Grove:** Our events.db could become this. Ensure events are never deleted, only appended.

---

## What We Should NOT Adopt

### Organizational Metaphor (CEO, Board, Hiring)
Paperclip models AI as a company with employees, bosses, and board oversight. This adds complexity without value for our use case (a single developer coordinating agents on code tasks). Our flat orchestrator → lead → worker hierarchy is simpler and sufficient.

### Approval Gates
Board-level approval before agents can act would slow us down. We want autonomous execution, not governance. Our self-healing approach (fix problems, don't gate them) is better for our workflow.

### Framework Agnosticism (7 Adapters)
Supporting Codex, Cursor, Gemini, etc. adds maintenance burden. We're locked to Claude Code and that's fine — it's the best agent runtime available. If we ever need other runtimes, Overstory's adapter pattern is better designed.

### Multi-Tenancy / Company Isolation
We don't need multi-company support. One project, one orchestrator.

---

## Patterns to Apply to Our Process

### 1. Discrete vs Continuous Execution

Paperclip's heartbeat model is interesting but too different from our architecture to adopt wholesale. However, the **bounded execution window** concept is valuable:

- Set hard timeout per agent type (we already have this)
- When timeout hits, agent should checkpoint and stop (not just get killed)
- Next run picks up from checkpoint with `--resume`

### 2. Goal Ancestry (Why-Chain)

Every Paperclip task carries its full goal ancestry. An agent always knows WHY it's doing something, not just WHAT.

**For Grove:** When spawning agents, include the parent task chain in the prompt:
```
You are working on: "Fix stdin pipe in agent.ts"
  → Part of: "Fix agent stalling"
  → Part of: "Improve grove reliability"
  → Goal: "Build a robust multi-agent orchestrator"
```

This gives agents better judgment about scope and priorities.

### 3. Comment Threads as Context

Paperclip uses issue comments as persistent working memory. Agents read the full comment thread before starting work.

**For Grove:** Our mail system already does this partially. But we could improve by having agents append their findings to the task (not just send mail to orchestrator). When a new agent picks up a task, it reads all previous agent comments on that task.

### 4. Skill Injection at Runtime

Paperclip injects skills/workflows into agents at heartbeat time without retraining.

**For Grove:** Our overlay templates + memory system partially does this. But we could be more systematic: automatically inject relevant grove memories, recent learnings, and project conventions into agent prompts at spawn time. The `improve-spawn-context` builder already started this.

---

## Optimization Ideas (Keep It Lean)

### What Paperclip Does Well (Lean)
1. **Single responsibility**: Paperclip is ONLY a control plane. Agents own their own execution.
2. **Coalescing**: Merge redundant triggers into single execution.
3. **Session reuse**: Don't restart from scratch — resume.
4. **Budget caps**: Hard stops prevent runaway costs.

### What We Should Focus On
1. **Session resume** — Biggest win. Stop restarting agents from scratch.
2. **Task checkout** — Prevents double-work, simplifies our stale-task problem.
3. **Token tracking** — Know what things cost. Cut waste.
4. **Coalescing** — Stop redundant watchdog/mail checks.

### What We Should NOT Do
1. Don't add more agent types (merger, monitor, etc.) — keep it to 4 (builder, scout, reviewer, lead)
2. Don't add governance/approval gates — stay autonomous
3. Don't add multi-tenancy — stay single-project
4. Don't add a web UI — the TUI dashboard is sufficient
5. Don't abstract the runtime — stay with Claude Code

---

## Adaptability Insights

Paperclip achieves adaptability through:
1. **Goal ancestry** — agents understand the WHY, so they can make judgment calls
2. **Runtime skill injection** — agents learn new capabilities without code changes
3. **Unopinionated agent design** — the control plane doesn't constrain what agents can do

**For Grove's adaptability:**
- Keep agent prompts (overlay templates) as the primary customization point
- Inject project-specific context via grove memory at spawn time
- Let the orchestrator (CLAUDE.md) define the workflow, not hardcode it
- The system should work for ANY codebase, not just grove itself

---

## Recommended Next Steps (3 tasks, priority order)

1. **Session resume** — Store Claude Code session IDs, use `--resume` on restart
2. **Atomic task checkout** — Lock tasks when agents claim them, prevent double-work
3. **Goal ancestry in prompts** — Include parent task chain in agent context

These three changes would make Grove significantly more reliable and efficient without adding complexity.
