# Phase 7 — Scheduler, concurrency & branch-stacking
> A dispatch loop that runs many tasks concurrently within the Jira DAG, stacking dependent branches and releasing them only on the **human merge event** — never by merging itself.

> Assumes the architecture doc and README context (Task model, hard rules, D1–D9). This doc does not restate them.

## Value & rationale (why only after one pipeline is battle-tested)
This is the **first** time we run many tasks at once. The hard principle (architecture doc → *Phased roadmap*) is: **one pipeline must be fully working and battle-tested before any concurrency, scheduling, or UI exists.** P2→P3→P4 prove a single task can go implement → review → ready → rebase-to-mergeable by hand. P6 turns Jira links into a DAG. P7 is the thin layer that *drives many of those single pipelines at once* without violating any invariant.

Doing it now (not earlier) means the per-task pipeline is a trusted black box: the scheduler only has to decide **when** to start a task, **how many** to run, and **what branch** each stacks on. It never reaches inside the pipeline. Every risky behaviour (merging, conflict resolution) already routes to humans, so concurrency cannot create a new class of unsafe side-effect — it can only create more of the same, faster. The reason this is valuable is that the orchestrator's whole point is **passive, overnight, multi-agent throughput**; until P7 the operator runs tasks one at a time.

Crucially: concurrency multiplies the cost of any latent bug in the pipeline, so battle-testing P3/P4 first is what makes turning the dial to N safe.

## Dependencies (Depends on / Enables)
- **Depends on:**
  - **P6** — the Jira-derived DAG: `dependsOn` edges, cycle detection, `baseBranch` resolution, re-poll/reconcile per tick.
  - **P4** — rebase babysitting: dependents are rebased through P4's flow on blocker merge.
  - **P3** — the full review pipeline a dispatched task runs end-to-end (incl. P1's `glab` MR ops and `detailed_merge_status` reads).
- **Enables:**
  - **P8** — crash-recovery/idempotency hardening, runaway detection, global budgets, Tier-1 sandbox (the scheduler is the thing those harden).
  - **P9** — dashboard + notifications read the scheduler's SQLite state; here we **log only**.

## In scope
- A **dispatch loop** (scheduler tick) that selects runnable tasks from the DAG and launches workers.
- A **concurrency cap** (`maxConcurrent`, start small e.g. 3–4) on simultaneously-running workers.
- **Dispatch-on-merged:** a blocked task is dispatched only when every `dependsOn` blocker's MR is **merged**, detected via P1's `glab` read, **released by the human merge event** — the scheduler never merges.
- **Branch-stacking:** a dependent's worktree branches off the blocker's branch (P6 `baseBranch`) while the blocker is open; on blocker merge, **rebase dependents via P4** onto the new base (main) and **re-run their verification**.
- **File-overlap detection** between concurrently *open* MRs in the same repo → serialize the second or flag it `needs-human` (isolation defers, not avoids, conflicts).
- The **SQLite state store as the only thing needing a lock** (single-writer scheduler; workers don't write it).
- **Backoff** on 429 / rate-limit signals from the `claude` CLI and `glab`.
- Sandcastle is **optional** here: branch strategy only — **no sandbox, no auto-merge** (D3/D4).

## Out of scope (deferred to …)
- **Crash-recovery / idempotency hardening, runaway-worker detection, per-task & global budgets, Tier-1 sandbox → P8.** P7 assumes a clean start and a trusted machine; if the scheduler crashes mid-tick, you restart it manually (P8 makes restart reconcile correctly).
- **Dashboard, notifications, audit UI → P9.** P7 emits structured log lines only; no Slack/desktop alerts.
- **CI-failure auto-enqueue (D7), oversight rate-limits (D9), circuit breakers → P8.**
- **Cross-repo conflict resolution** — cross-repo blocks are ordering-only (branch off `main`); never stacked.
- **Auto-resolving same-file conflicts** — always defers to P4/human; the scheduler never silently merges hunks.

## Design

### Scheduler loop (single long-running process)
One process, one event loop, **one writer to SQLite**. Each **tick** (interval-driven, e.g. every 30–60s, plus an immediate tick on any worker exit):

```
tick():
  1. acquireStateLock()                      # the ONLY lock in the system
  2. graph = P6.reconcile()                  # re-poll Jira, rebuild DAG, cycle-detect → flag, never deadlock
  3. for t in tasks where status == 'blocked':
        if allBlockersMerged(t):             # P1 read of each blocker MR; released by human merge EVENT
            t.baseBranch = mainBranch(t.repo) # blocker now merged → base is main
            markForRebaseIfStacked(t)         # if it was stacked on blocker branch → queue P4 rebase
            t.status = 'queued'
  4. for t in tasks where status == 'running' and workerExited(t):
        ingestWorkerResult(t)                 # advance per P3 result: review / needs-human / failed
  5. detectFileOverlap(openMRsByRepo)         # serialize-or-flag second overlapping MR
  6. while runningCount() < maxConcurrent and (t = nextQueued(graph)):
        if rateLimited(): break              # backoff window still open → skip dispatch this tick
        dispatch(t)
  7. releaseStateLock()
```

`nextQueued` is a **topological** pick over the reconciled DAG (P6 supplies the ordering and cycle flags); within a topo-eligible set, prefer tasks whose blockers just merged (unblock downstream sooner), then FIFO by enqueue time. Cycles are flagged `needs-human`, never dispatched.

### Concurrency cap
- `maxConcurrent` (config, default small — 3–4 "passive" workers; architecture doc: *start small*).
- The cap counts tasks in `status='running'` (a live worker PID). The loop dispatches only up to the remaining headroom each tick.
- Real limits are **API/TPM rate limits + local hardware**, not a model-hours bucket (D1: unlimited Opus). So the cap is tuned to hardware/TPM, and the rate-limit backoff (below) is the dynamic safety valve on top of the static cap.
- Each dispatch = one `claude --worktree -p …` worker running the P3 pipeline. The scheduler tracks `workerPid` per task (for P8 recovery/runaway later; here just to detect exit).

### Dispatch-on-merged (release by the human merge event)
- A `blocked` task lists `dependsOn` jiraKeys (P6). For each blocker the orchestrator finds its MR (P1 `glab mr list --source-branch`) and reads merge state.
- **Released only when the blocker MR is `merged`** — confirmed by `glab mr view <id> -F json` (state `merged` / `merged_at` set). This is the **human's merge event** (D5): a human merged in the GitLab UI; the scheduler *observes* it. The scheduler **never** runs `glab mr merge` (hard rule).
- **Unmanaged/external blockers** (no agent-owned MR — P6 marks these): released on the Jira link clearing or a manual operator override, never auto-merged.
- Gate strictly on **merge**, never on Jira workflow status (architecture: *Correctness guardrail 1*).

### Branch-stacking + downstream rebase
**While blocker X (same repo) is open and Y is `blocked` but eligible to start work early** — architecture allows branching off the blocker once it reaches `review`/`merged`:
- Y's worktree branch is created **off X's branch** (`baseBranch = X.branch`, from P6). Y runs its full P3 pipeline against that base, so Y's diff is reviewable on top of X.
- **Same-repo only.** Cross-repo block ⇒ ordering dependency: Y waits, then branches off `main` (`baseBranch = main`). Never stacked across repos.

**On X merge (the human merge event):**
1. Scheduler observes X `merged` (dispatch-on-merged check).
2. For each dependent Y stacked on X's branch: set `baseBranch = main`, mark Y for rebase.
3. **Rebase Y via P4** (`git fetch` → `git rebase origin/main`; conflicts → P4 session-resume agent resolution → `needs-human` re-review of resolution hunks per D4). The scheduler **delegates** to P4; it does not implement rebase logic.
4. **Re-run Y's per-repo verification** after the rebase (P4 step 5). On pass → Y continues / its MR is updated (force-push-with-lease per P4, re-triggering CI + Greptile). On conflict needing agent resolution → `needs-human` (D4).

```
X (open, branch x)   Y branches off x ──▶ Y reviewed on top of x
        │ human merges x → main
        ▼
X merged (event observed)
        │ scheduler: Y.baseBranch = main; markForRebase(Y)
        ▼
P4.rebase(Y onto origin/main) → re-run verify(Y) → (clean) update MR | (agent-resolved conflict) needs-human
```

### File-overlap detection (between concurrently open MRs in same repo)
Isolation **defers, does not avoid** same-file conflicts: two *undeclared*-dependency MRs editing the same file both pass review in isolation, then the second conflicts at merge. So each tick:
- For each repo, gather the changed-file set of every **open** MR: `glab mr diff <id>` (or `git diff --name-only base...head`) → `{ mrId → files[] }`.
- Compute pairwise file-set intersections among open MRs **not already in a declared `dependsOn` stack** (declared edges are already handled by stacking).
- On overlap:
  - **Serialize:** if neither has merged yet, hold the later-enqueued task / its push so only one overlapping MR is "active" at a time (let the first reach ready/merged, then rebase the second via P4), **or**
  - **Flag `needs-human`:** record `fileOverlapWith` and route the second MR to `needs-human` for a human-decided rebase rather than auto-resolving.
- The scheduler **never auto-resolves** the overlap — consistent with humans-only-merge and D4.

### State store / locking
- **SQLite is the only thing needing a real lock.** The scheduler is the **single writer**; workers never write it (they only edit files in their worktree + emit stream-json). One coarse lock (a process-level mutex around the tick's read-modify-write, plus SQLite's own transaction/WAL) is sufficient — no distributed locking.
- Worktrees are per-task and isolated; the only shared mutable state is the task table, hence the single lock.
- Run SQLite in **WAL mode** so the (future P9) dashboard can read concurrently while the scheduler writes.

### Rate-limit backoff
- Workers invoke the genuine `claude` CLI; `glab` hits the GitLab API. Both can emit **429 / rate-limit** signals.
- On a 429/rate-limit (detected from `claude` exit/stderr or `glab` HTTP 429 / `Retry-After`): set a **backoff window** with exponential growth + jitter (e.g. base 30s, ×2 up to a cap, honour `Retry-After` when present). While the window is open, the loop **skips new dispatch** (step 6 breaks) but lets running workers finish.
- Backoff is **global** (per signal source). Thresholds/budgets are D8 defaults; full budget enforcement is P8.

### SQLite schema additions
Extends the task store (keyed by `jiraKey`) introduced earlier. Only the scheduler writes; WAL on.

```sql
-- Columns added to the existing `task` table (P7 scheduling fields)
ALTER TABLE task ADD COLUMN base_branch        TEXT;     -- blocker branch (same-repo) | main
ALTER TABLE task ADD COLUMN stacked_on         TEXT;     -- jiraKey of blocker this branch stacks on (null if off main)
ALTER TABLE task ADD COLUMN needs_rebase       INTEGER DEFAULT 0;  -- set when blocker merged → rebase via P4
ALTER TABLE task ADD COLUMN file_overlap_with  TEXT;     -- mrId/jiraKey of conflicting open MR (null if none)
ALTER TABLE task ADD COLUMN enqueued_at        TEXT;     -- FIFO tiebreak within topo-eligible set
ALTER TABLE task ADD COLUMN worker_pid         INTEGER;  -- live worker (exit detection now; recovery/runaway = P8)
-- status reuses the architecture enum: queued|blocked|running|review|needs-human|merged|failed|stale

-- Cached changed-file sets of open MRs, for file-overlap detection (refreshed each tick)
CREATE TABLE IF NOT EXISTS mr_files (
  mr_id      TEXT NOT NULL,
  repo       TEXT NOT NULL,
  jira_key   TEXT,
  file_path  TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mr_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_mr_files_repo_file ON mr_files(repo, file_path);

-- Rate-limit backoff windows (global per signal source: 'claude' | 'glab')
CREATE TABLE IF NOT EXISTS backoff (
  source        TEXT PRIMARY KEY,   -- 'claude' | 'glab'
  until         TEXT NOT NULL,      -- ISO ts; dispatch paused while now < until
  attempt       INTEGER NOT NULL,   -- consecutive 429s, for exponential growth
  last_reason   TEXT
);

-- Per-tick audit (log-only in P7; dashboard reads this in P9)
CREATE TABLE IF NOT EXISTS scheduler_run (
  tick_at        TEXT PRIMARY KEY,
  dispatched     INTEGER NOT NULL,
  running        INTEGER NOT NULL,
  blocked        INTEGER NOT NULL,
  needs_human    INTEGER NOT NULL,
  backoff_active INTEGER NOT NULL
);
```

## Implementation steps (ordered)
1. **Schema additions** (above) — extend the `task` table; add `mr_files`, `backoff`, `scheduler_run` tables. Migration on startup; idempotent.
2. **State-store access layer** — single-writer wrapper with the coarse lock + WAL; typed read/update for tasks.
3. **Loop skeleton** — `tick()` on an interval + on worker-exit; structured log line per tick (counts: queued/blocked/running/needs-human).
4. **Integrate P6 reconcile** into the tick (re-poll, rebuild DAG, cycle-flag).
5. **Dispatch-on-merged** — `allBlockersMerged(t)` via P1 reads; handle unmanaged/external blockers + manual override.
6. **Concurrency cap + dispatcher** — `runningCount`, `nextQueued` topo pick, `dispatch(t)` launching the P3 worker with the resolved `baseBranch`; record `workerPid`.
7. **Branch-stacking** — resolve `baseBranch` from P6 (blocker branch if same-repo open, else main); create dependent worktrees off it.
8. **Downstream rebase-on-merge** — on observed blocker merge, set base→main, `markForRebase`, **call P4**, re-run verify, route result.
9. **File-overlap detection** — gather open-MR file sets, intersect, serialize-or-flag.
10. **Rate-limit backoff** — detect 429 from `claude`/`glab`, maintain backoff window, gate dispatch.
11. **Wire result ingestion** — map P3 worker exit → task status transition (`review` / `needs-human` / `failed`).
12. **CLI/script** to start/stop the scheduler over a DAG (see *How to run it*).

## How to run it (manual / script) — start the scheduler over a small DAG
The scheduler is a single long-running Node process. Typical session:

```bash
# 1. Build the DAG from Jira (P6) for a small set of issues → SQLite
orchestrator dag:sync --issues PROJ-101,PROJ-102,PROJ-103

# 2. Inspect what the scheduler sees (no dispatch)
orchestrator dag:show          # prints topo order, edges, cycle flags, baseBranch per task

# 3. Start the scheduler (concurrency cap from config or flag)
orchestrator scheduler:start --max-concurrent 3 --tick 45s
#   → logs each tick: dispatched/running/blocked/needs-human; logs every side-effect (P1)

# 4. Observe (log-only in P7; dashboard is P9)
tail -f ./orchestrator.log

# 5. Stop cleanly (lets running workers finish; does NOT merge anything)
orchestrator scheduler:stop
```

- `--max-concurrent` overrides the configured cap; start at 3.
- The scheduler **never merges** — when a task reaches `review`/ready it logs "ready for human" and waits for the operator to merge in GitLab.
- On operator merge, the next tick observes it and releases/rebases dependents automatically.

## Testing & battle-testing (a 2–3 task DAG with a real blocker)
**Setup:** a 3-task DAG in one repo — `A` (blocker) → `B` (stacked on A) and an independent `C`. Use real Jira issues with a real "is blocked by" link (B blocked by A); A and B touch *different* files; add a variant where B and C touch the *same* file.

Core flow:
1. Start scheduler with `--max-concurrent 2`. Assert A and C dispatch concurrently; **B stays `blocked`** (A unmerged).
2. Assert B's worktree, when started early, branches **off A's branch** (`baseBranch == A.branch`).
3. Let A reach ready; **a human merges A in GitLab.** Assert next tick observes A `merged`, sets `B.baseBranch=main`, **rebases B via P4**, re-runs B's verification, and the scheduler **never** ran `glab mr merge`.

Edge cases:
- **Blocker merged:** kill the scheduler between A's merge and B's release; restart; assert B still releases (state is in SQLite). (Full crash-recovery hardening is P8 — here just confirm the state read is correct.)
- **File overlap:** with B and C editing the same file (no declared dependency), assert overlap is detected and the second open MR is **serialized or flagged `needs-human`**, never auto-resolved.
- **Rate-limit:** inject a 429 from a stubbed `claude`/`glab`; assert the backoff window opens, **no new dispatch** during it, running workers finish, and dispatch resumes after the window (honouring `Retry-After`).
- **Cycle:** add A↔B mutual block; assert the DAG is flagged and **nothing deadlocks / nothing dispatches the cycle**.
- **Concurrency cap honoured:** queue 5 independent tasks, cap 3; assert never more than 3 `running`.

**Battle-test:** run a real overnight batch of ~5–8 tickets at cap 3; in the morning verify zero unintended merges, all conflicts/overlaps landed in `needs-human`, dependents rebased after each human merge, and the log is a complete side-effect trail.

## Exit criteria (done when)
- The scheduler dispatches up to `maxConcurrent` tasks concurrently, picking by topo order over the P6 DAG.
- A `blocked` task is released **only** when all its blockers' MRs are **merged** (observed human merge event); the scheduler never calls `glab mr merge`.
- Dependent (same-repo) tasks branch off the blocker's branch and, on blocker merge, are **rebased via P4** with verification re-run; cross-repo blocks branch off `main`.
- File-overlap between concurrently open same-repo MRs is detected and the second is **serialized or flagged `needs-human`** (never auto-resolved).
- SQLite is the single locked writer (WAL); workers never write it.
- 429/rate-limit signals open a backoff window that pauses dispatch without killing running workers.
- All of the above demonstrated on the 2–3 task DAG incl. the edge cases; every side-effect logged.

## Risks & mitigations
- **Scheduler accidentally merges / treats Jira "Done" as merge** → gate strictly on `glab` MR `merged` state; assert in code + a unit test; no `glab mr merge` code path exists anywhere in the scheduler.
- **`inwardIssue`/`outwardIssue` direction footgun** (P6) flips a dependency → reuse P6's direction unit test; scheduler trusts P6's resolved edges.
- **Undeclared same-file overlap passes review then conflicts at merge** → file-overlap detection each tick; serialize-or-flag; never auto-resolve (defers to P4/human).
- **Rebase storm on a popular blocker merge** (many dependents rebase at once) → rebases run through P4 and count against `maxConcurrent`; queue them, don't fire all simultaneously.
- **Rate-limit thrash** → exponential backoff + jitter + honour `Retry-After`; static cap tuned below TPM headroom.
- **Stale DAG between ticks** (new/removed blocker mid-flight) → P6 `reconcile()` every tick re-polls and re-bases (new blocker → flag/pause; removed → rebase back onto main).
- **Lock contention / double-dispatch** → single-writer scheduler + coarse lock around the tick's read-modify-write means only one process ever mutates the task table.
- **Crash mid-tick loses progress** → acknowledged; full reconciliation is **P8**. P7 keeps gates idempotent-friendly by persisting status before launching workers so a manual restart re-reads correct state.
