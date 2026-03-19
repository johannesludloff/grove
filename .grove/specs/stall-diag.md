# stall-diag

## Objective
Enhance agent stall diagnostics so that stall warning mails contain actionable info: last stdout/stderr lines, process state, last tool used, and time since last output.

## Acceptance Criteria
- [ ] New `gatherStallDiagnostics(agentName: string)` function exists (in watchdog.ts or agent.ts) that collects:
  - Last 20 lines of stdout.txt
  - Last 10 lines of stderr.log
  - PID alive/dead status
  - Last tool info from `.grove/logs/<name>/last-tool.json` (tool name, input summary, timestamp)
  - Last tool from `tool_metrics` table (fallback if last-tool.json missing)
  - Time since last activity (from agent's `last_activity_at` column)
- [ ] `watchdog.ts` stall warning mail (line ~134-141) uses diagnostics in the mail body
- [ ] `agent.ts` graduated nudge mails (stages 1-3 at lines ~671-741) include diagnostics
- [ ] `agent.ts` timeout kill mail (line ~753-758) includes diagnostics
- [ ] All diagnostic gathering is wrapped in try/catch (must never crash watchdog or poller)
- [ ] TypeScript compiles cleanly (`bunx tsc --noEmit`)

## File Scope (owned files)
- src/watchdog.ts
- src/agent.ts

## Context

### watchdog.ts stall detection (lines 82-141)
- Tracks stdout size per agent in `stdoutSizes` Map
- After `STALL_THRESHOLD` (4) consecutive checks with no growth, adds to `stalled` array
- Sends mail to orchestrator: `Stalled agents: <names>` with generic body
- Current body: `"Watchdog detected N agent(s) with no output growth for ... These agents may be stuck."`
- **Enhance**: Include per-agent diagnostics in the stall mail body

### agent.ts graduated nudge system (lines 661-776)
- Stage 1 (gentle, 2min): sends nudge to agent with output size
- Stage 2 (firm, 4min): checks PID liveness, sends warning
- Stage 3 (escalate, 6min): sends error to orchestrator with PID info
- Final (timeout): kills agent, sends timeout mail
- Already reads `last-tool.json` for heartbeat enrichment (lines 638-651)
- Already checks `isPidAlive()` at stages 2-3
- **Enhance**: Add stdout tail, stderr tail, last tool info, and time-since-last-output to all nudge/escalation mails

### Diagnostic info sources
- stdout: `.grove/logs/<name>/stdout.txt` — read last 20 lines via Bun.file().text() then split/slice
- stderr: `.grove/logs/<name>/stderr.log` — read last 10 lines
- PID: `isPidAlive(pid)` from agent.ts (already exported)
- Last tool (file): `.grove/logs/<name>/last-tool.json` — JSON with {tool, inputSummary, timestamp}
- Last tool (DB): `SELECT tool_name, created_at FROM tool_metrics WHERE agent_name=? ORDER BY id DESC LIMIT 1`
- Last activity: agent's `last_activity_at` from DB (already available in nudge code via `getAgent()`)

### Helper function design
```typescript
interface StallDiagnostics {
  stdoutTail: string;    // Last 20 lines of stdout
  stderrTail: string;    // Last 10 lines of stderr
  pidAlive: boolean;
  lastTool: string | null;  // "Read on file_path: src/foo.ts at 2026-03-19T..."
  timeSinceLastOutput: string;  // "4m 32s"
}

function gatherStallDiagnostics(agentName: string, pid: number | null): StallDiagnostics
```

Put this function in `watchdog.ts` and import `getDb` and `isPidAlive` as needed. The function should be synchronous-safe (use try/catch everywhere).

### Format for mail body
```
Agent "<name>" diagnostics:
  Process: alive (PID 12345)
  Silent for: 4m 32s
  Last tool: Read on file_path: src/agent.ts (2m ago)
  Last stdout (20 lines):
    ...lines...
  Last stderr (10 lines):
    ...lines...
```

## Dependencies
none
