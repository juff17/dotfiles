# Phase 9 — Dashboard, notifications & audit
> Let the operator passively oversee many concurrent tasks and get pulled in only when needed — the "manage many at once" UX, built last.

## Value & rationale (manage many; passive oversight; avoid rubber-stamping)
By P8 the system can run many tasks reliably and safely, but the human still has to *poll* the SQLite
state store by hand and read raw `stream-json` to know what is happening. That defeats the AFK model: a
passive system the operator must actively check is not passive. This phase closes the genuine UX gap the
architecture calls out — Claude Code's TUI is per-session and has no view of *many* concurrent agents — by
giving the operator one place to glance at all tasks and a push channel that interrupts them only on the
small set of events that actually need a human.

Three jobs, in priority order:
1. **Manage many** — a single dashboard over the SQLite state store + each worker's `stream-json` stream:
   per-task status, current stage, token spend, diffs, and links out to the MR, decision-log and transcript.
2. **Passive oversight** — notifications (D6) fire on the P8-defined events (`needs-human`, `failed`,
   rebase-ready, auth-failure) so the human can stay away until pulled in. A passive system the human must
   poll defeats the AFK model (architecture *Observability & audit*).
3. **Avoid rubber-stamping** — the persistent per-task structured log + side-effect audit trail make every
   merged MR debuggable post-mortem *even after its worktree is GC'd*, and the oversight aids (D9) surface
   the `needs-human` rate-limit in the UI and prompt random-sample audits of merged MRs so trust is
   calibrated rather than assumed.

This is explicitly the **last** phase: it only *reads* state and *consumes* the events P8 defined. It adds
no new scheduling, reliability, or safety behaviour — it makes the existing behaviour observable.

## Dependencies (Depends on / Enables)
- **Depends on:**
  - **P7** (scheduler/concurrency) — produces the many concurrent tasks worth a dashboard; the SQLite
    state store + per-task `stream-json` are the dashboard's data sources.
  - **P8** (reliability & safety) — **defines the events** this phase routes (`needs-human`, `failed`,
    rebase-ready, auth-failure), the kill-switch state, GC/`stale` transitions, and the budget/circuit-breaker
    state surfaced in the UI. P9 builds the *channels and views*; P8 already decided *when* events fire.
  - Earlier phases for the artifacts the dashboard links to: P2/P3 (`GOAL.md`, `decision-log.jsonl`, MR,
    transcript), P4 (`rebase-transcript.md`), P6 (Jira key / DAG edges).
- **Enables:** **scaled operation** — the operator can run the concurrency cap "full" and trust that they
  will be pulled in when, and only when, a human is required. This is the end of the roadmap; nothing
  depends on it.

## In scope
- **Local monitoring dashboard** (web *or* TUI — see Design 9.1 for the decision) reading:
  - the **SQLite state store** (task rows, stages, audit log, budgets, `needs-human` queue);
  - each worker's **`stream-json` event stream** for live per-task detail (current stage, token spend,
    last activity, tool calls).
  - Views: a **fleet board** (all tasks, status, stage, spend), a **task detail** view (live event tail,
    diff, links to MR + decision-log + transcript), and the **needs-human queue** with the D9 rate-limit
    surfaced.
- **Notification mechanism (D6)** — a channel abstraction (Slack / desktop / email, operator-chosen) that
  fires on the P8 events: `needs-human`, `failed`, rebase-ready, auth-failure. Includes dedupe, severity,
  and a deep-link back into the dashboard / MR.
- **Persistent per-task structured log + side-effect audit trail** — the orchestrator-action log + each
  worker's `stream-json`, persisted independent of the live dashboard and **retained past worktree GC**;
  the audit trail of every side-effect (commit SHAs, pushes, MR/comment IDs) so a GC'd task is debuggable
  post-mortem. Defines the **audit-log schema + retention** (Design 9.4).
- **Oversight aids (D9)** — the `needs-human` per-period rate-limit shown in the UI (and as a notification
  when tripped), and **random-sample audit prompts** on merged MRs to calibrate trust.

## Out of scope (deferred to …)
Nothing is deferred to a later phase — **this is the last phase**. What it deliberately does *not* do
(because earlier phases own it; P9 only displays/consumes):
- **Scheduler / dispatch / concurrency internals** — P7. The dashboard reads and displays them; it never
  decides what to run. (It MAY expose the P8 global kill-switch as a button, but the switch itself is P8.)
- **Reliability internals** (crash-recovery, retry/timeout, circuit breakers, GC, budgets) — P8. The
  dashboard *surfaces* their state (e.g. "circuit breaker tripped", "budget 80% spent") but does not
  implement them.
- **Defining when events fire** — P8 already specifies the event triggers; P9 only maps event → channel.
- **Acting on tasks from the UI** (merge, push, approve) — forbidden by the **human-only-merge** hard rule
  and the **agent-decides/orchestrator-acts** boundary. The dashboard is **read-only** over task state
  except for the operator-initiated kill-switch and acknowledging/sampling for audit. Merging stays in the
  GitLab UI (D5); the dashboard only *links* there.

## Design (dashboard sources/views, notification channels + event mapping, audit log schema + retention)

### 9.1 Dashboard technology decision
Per the architecture (build item 6: "Local web UI (or TUI)"), either is sanctioned. **Default: a local
web UI** served by the orchestrator process (it is already a long-running local Node process), because:
- it renders **diffs** and **clickable links** to MR / decision-log / transcript far better than a TUI;
- it survives the operator closing their terminal (the AFK model runs overnight);
- multiple glances from different windows without attaching to a TTY.

A TUI is an acceptable substitute if no browser is wanted; the data sources and views below are identical.
The server is **local-only** (bind `127.0.0.1`), no auth beyond loopback, no write endpoints except the
kill-switch and audit-ack (it acts as the operator on the same machine, consistent with D2).

### 9.2 Data sources
| Source | What it provides | Access pattern |
|---|---|---|
| **SQLite state store** | Task rows (status, stage, repo, jiraKey, mrUrl, branch, worktree, budgets), the audit log, the `needs-human` queue, GC/`stale` flags, circuit-breaker/budget state | Read-only queries; a short poll (e.g. 1–2 s) or `WAL`-mode change feed. The dashboard takes **no locks** that block the orchestrator (read-only, `PRAGMA query_only`). |
| **Worker `stream-json`** (per task) | Live per-task detail: current stage, tool calls, token spend, last-event timestamp (drives the no-progress display) | Tail the worker's `--output-format stream-json` event file/pipe that P2+ already persists; parsed into per-task live state. |
| **Worktree artifacts** | `GOAL.md`, `decision-log.jsonl`, `rebase-transcript.md`, diff (`git diff` in the worktree) | Read on demand for the task-detail view; **fall back to the persisted audit log** when the worktree is GC'd (9.4). |
| **GitLab (via P1 module)** | MR URL, `detailed_merge_status`, CI status for the rebase-ready/CI display | Read-only through the existing `glab` wrapper; cached, never per-render (respect rate limits). |

> The dashboard reads the **same** SQLite the orchestrator writes (architecture diagram: "state store +
> audit log (SQLite) ◀── dashboard reads this"). It is strictly a reader; the orchestrator remains the
> sole writer of task/audit state.

### 9.3 Views
1. **Fleet board** (default) — one row per task: `jiraKey`, repo, `status` (queued/blocked/running/review/
   needs-human/merged/failed/stale), current `stage`, token spend (per-task + cumulative), last-activity
   age (from `stream-json`), and a link to MR. Filter/sort by status; `needs-human` and `failed` pinned to
   top. Shows global state from P8: kill-switch state, global budget gauge, concurrency (running/cap).
2. **Task detail** — for one task: the **live `stream-json` event tail** (stage transitions, tool calls,
   token spend), the **diff** (worktree or, post-GC, the MR diff), the **decision-log** rendered (every
   `skip`/`pushback` flagged as a required read; each GOAL.md criterion met/unmet — mirrors the
   architecture's human-facing summary), and **links** to MR + decision-log + transcript. Read-only.
3. **Needs-human queue** — the work the human owes attention to, ordered, with the **D9 rate-limit gauge**
   ("X of N this period") visible so the operator sees when the queue is being throttled. Each item links
   to its task detail. Also lists **rebase-ready** MRs (P4) awaiting a human merge.
4. **Audit / post-mortem** — query any task (including GC'd / `stale`) and replay its structured log +
   side-effect trail (9.4). Surfaces the **D9 random-sample audit prompts**: a periodic pick of recently
   merged MRs flagged "please deep-audit" with a one-click ack recording that the operator looked.

### 9.4 Audit log schema + retention
Two persisted streams, both **independent of the live dashboard and retained past worktree GC**
(architecture *Observability & audit*). Stored in SQLite (queryable for post-mortem) with the bulky
`stream-json` optionally spilled to per-task files referenced by row.

**(a) Per-task structured event log** — orchestrator actions + worker `stream-json`, append-only:
```ts
type TaskEvent = {
  id: number            // autoincrement
  taskId: string
  jiraKey: string
  ts: string            // ISO8601
  source: "orchestrator" | "worker"
  stage: string         // stage at time of event
  kind: string          // stage-start | stage-end | tool-call | token-usage | status-change | error | review-finding
  tokens?: number       // cumulative or delta token spend (for the spend view)
  payload: object       // raw stream-json event or orchestrator detail (JSON)
}
```

**(b) Side-effect audit trail** — every state-mutating git/GitLab action the orchestrator performed
(the architecture's "commit SHAs, pushes, MR/comment IDs"); never merges (hard rule), so no merge rows:
```ts
type SideEffect = {
  id: number
  taskId: string
  jiraKey: string
  ts: string
  action: "commit" | "push" | "rebase" | "mr-create" | "comment-post" | "comment-reply" | "force-push"
  gitSha?: string       // for commit / rebase / push
  branch?: string
  mrId?: string         // MR iid/url
  commentId?: string    // for comment-post / comment-reply (also used for de-dup, ties to P8 idempotency)
  detail: object        // e.g. force-with-lease pinned SHA, target branch, decision-log ref
  result: "ok" | "retried" | "failed"
}
```

**Retention:** both tables are kept **independently of the worktree**. When P8 GC's a `stale`/`merged`
worktree, the rows survive, so the audit/post-mortem view still works (the diff falls back to the MR).
Default retention: **at least as long as the transcript backup** (architecture: `cleanupPeriodDays` ≥ 90
and transcript backed up at MR creation) — set audit retention ≥ that, so a days-later post-mortem of a
rebased/merged task has both the audit trail and a transcript to reference. Rotate/prune older rows by age
(configurable), never tied to worktree lifecycle.

### 9.5 Notification channels + event mapping (D6)
A small **channel abstraction** — one interface, pluggable backends (operator picks one or more):

| Channel | Mechanism | Notes |
|---|---|---|
| **Slack** | incoming webhook / bot token (default per D6) | richest: deep-link button to dashboard + MR. |
| **Desktop** | OS notification (e.g. `notify-send` / equivalent) | good for a single-operator local machine. |
| **Email** | SMTP | fallback / digest. |

Channels are **orchestrator-side** (it holds any tokens, consistent with D2; workers never notify). Each
notification carries: severity, taskId/jiraKey, the event, a one-line reason, and **deep-links** to the
task-detail view and the MR.

**Event → channel mapping** (events are **defined by P8**; P9 only routes them):

| Event (from P8) | Trigger (P8-defined) | Severity | Default channel(s) | Payload deep-links |
|---|---|---|---|---|
| **`needs-human`** | task routed to `needs-human` (review ready, agent-resolved conflict, errored reviewer, circuit-breaker trip) | high | Slack + desktop | task detail, MR, decision-log |
| **`failed`** | non-recoverable failure (non-idempotent side-effect failed, retries exhausted, runaway killed) | high | Slack + desktop | task detail, last error in audit log |
| **rebase-ready** | rebase babysitting finished → ready for human merge (P4), or `detailed_merge_status = mergeable` | medium | Slack | MR (human merges in GitLab UI — D5) |
| **auth-failure** | `glab`/Jira/Anthropic auth/token failure detected | high | Slack + desktop | which credential; the operator must re-auth |
| **(D9) needs-human rate-limit tripped** | `needs-human` count for the period exceeded the D9 cap | medium | Slack | needs-human queue view |
| **(D9) random-sample audit prompt** | periodic sample of merged MRs selected | low | Slack (or digest) | audit/post-mortem view for that MR |

Behaviour: **dedupe** (one notification per event per task; status oscillation does not re-notify — ties
into P8's oscillation/cooldown logic which already suppresses churn); **rate-limit** the notifier itself so
a storm of `failed` events cannot flood the channel (collapse into a digest above a threshold); record each
sent notification in the structured log so the audit view shows what the operator was told and when.

### 9.6 Oversight aids (D9)
- **`needs-human` rate-limit surfaced in UI** — the queue view shows "X of N this period"; when the cap is
  hit, new `needs-human` tasks still enter the queue (never dropped) but are visually de-emphasised and a
  single "rate-limit tripped" notification fires (above), so the operator isn't drowned and can see the
  system is producing review work faster than they can absorb it.
- **Random-sample audit prompts** — a periodic deterministic random pick from recently *merged* MRs,
  flagged in the audit view with a notification; the operator opens the post-mortem (audit trail + decision
  log + diff) and **acks** it. Acks are recorded (in the structured log) so the sample rate / coverage is
  itself auditable. This calibrates trust over time rather than assuming the pipeline is correct.

## Implementation steps (ordered)
1. **Read-only SQLite access layer** — open the state store `query_only`, in WAL mode, taking no blocking
   locks; expose typed queries for the views (fleet, task detail, needs-human queue, audit).
2. **`stream-json` tail/parser** — read each running worker's persisted `stream-json`, derive per-task live
   state (stage, token spend, last-activity age). Reuse the persisted event files P2+ already write.
3. **Audit persistence** — add the `TaskEvent` and `SideEffect` tables (9.4) to the SQLite schema; have the
   orchestrator write a `SideEffect` row at **every** P1 side-effect call site (commit/push/rebase/MR/
   comment) and a `TaskEvent` row at each stage/status transition. (Hook into existing call sites; do not
   change their behaviour.)
4. **Dashboard server + fleet board** — local web server (`127.0.0.1`), poll/feed the SQLite layer, render
   the fleet board with the P8 global state (kill-switch, budget, concurrency).
5. **Task-detail view** — live event tail, diff (worktree → MR fallback), rendered decision-log + GOAL.md
   criteria, links to MR/decision-log/transcript.
6. **Needs-human queue view** + the D9 rate-limit gauge; rebase-ready list.
7. **Notification channel abstraction** — interface + Slack (default), desktop, email backends; config to
   select channel(s) and per-event routing (the 9.5 table as the default).
8. **Wire events → notifications** — subscribe to the P8-emitted events and route per 9.5; add dedupe +
   notifier rate-limit; log every sent notification.
9. **Oversight aids (D9)** — surface the `needs-human` rate-limit in the queue view + tripped-notification;
   implement the random-sample audit prompt + ack recording.
10. **Audit / post-mortem view** — query any task (incl. GC'd/`stale`), replay structured log + side-effect
    trail; verify it works with the worktree deleted.
11. **Launch script** — a single command to start the dashboard (Design 9.1 / How to run).

## How to run it (manual / script) — launch the dashboard
- **Launch:** a single script starts the local dashboard server alongside the running orchestrator, e.g.
  `./scripts/dashboard.sh` (or `npm run dashboard`), which binds `127.0.0.1:<port>` and opens the fleet
  board. The orchestrator must already be running (P2+) so the SQLite state store and `stream-json` files
  exist; the dashboard is a **separate read-only process** and can be started/stopped/restarted at any time
  without affecting tasks.
- **Notifications:** configured once (channel + token/webhook in orchestrator config, never in workers).
  A `--test-notify` flag sends a sample event through the configured channel(s) to confirm wiring.
- **Stop:** closing the dashboard process leaves the orchestrator and all workers untouched (read-only).
- The **kill-switch** (P8) is exposed as a button but is the only write action — it calls the P8 mechanism,
  it does not reimplement it.

## Testing & battle-testing (observe a live multi-task run; verify notifications fire; audit a GC'd task post-mortem)
- **Observe a live multi-task run** — with P7's concurrency cap full (e.g. 3–4 tasks), open the dashboard
  and confirm the fleet board shows each task's correct status/stage/token-spend and updates live from
  `stream-json`; confirm task-detail shows the live tail, diff, and working links to MR/decision-log/
  transcript. Confirm the dashboard takes no lock that stalls the orchestrator (run under load).
- **Verify notifications fire** — drive each P8 event and confirm exactly one notification per event on the
  mapped channel(s) with correct severity + working deep-links:
  - force a task to `needs-human` (e.g. agent-resolved conflict from P4) → high, Slack+desktop;
  - force a `failed` (exhaust retries / kill a runaway) → high;
  - finish a rebase to ready (P4) → rebase-ready, medium, links to MR;
  - revoke/expire a `glab` token → auth-failure, high.
  Confirm dedupe (status oscillation does not re-notify) and the notifier rate-limit (a burst of `failed`
  collapses to a digest).
- **Audit a GC'd task post-mortem** — let P8 GC a `merged`/`stale` task's worktree, then open the
  audit/post-mortem view for it and confirm the structured log + side-effect trail (commit SHAs, pushes,
  MR/comment IDs) fully reconstruct what happened, with the diff falling back to the MR and the transcript
  backup still present.
- **D9 oversight** — exceed the `needs-human` cap and confirm the queue gauge shows it + the tripped
  notification fires (tasks not dropped); confirm a random-sample audit prompt appears for a merged MR and
  that acking it is recorded.

## Exit criteria (done when)
- A local dashboard shows **all** concurrent tasks with live status/stage/token-spend and links to MR +
  decision-log + transcript, reading the SQLite store + `stream-json` **read-only** (no orchestrator stall).
- Notifications fire on **all four** P8 events (`needs-human`, `failed`, rebase-ready, auth-failure) on the
  operator-chosen channel(s) per the 9.5 mapping, with dedupe and notifier rate-limit, and deep-links work.
- The per-task structured log + side-effect audit trail (9.4 schema) are persisted, and a **GC'd task is
  fully debuggable post-mortem** from them.
- The **D9** `needs-human` rate-limit is visible in the UI (and notifies when tripped) and random-sample
  audit prompts appear + record acks.
- The dashboard performs **no** task-mutating action except the P8 kill-switch and audit-ack; merging stays
  human-only in the GitLab UI.

## Risks & mitigations
- **Dashboard contends with the orchestrator on SQLite** → open `query_only` in WAL mode, short polling /
  change-feed, never hold a write lock; load-test under a full concurrency cap (battle-test above).
- **`stream-json` parse drift** (format changes / partial lines) → tolerate unparseable lines (log + skip,
  never crash the view); the SQLite state store remains the source of truth for status, with `stream-json`
  as live-detail enrichment only.
- **Notification storm** (many `failed` at once) → notifier-side rate-limit + digest collapse; dedupe per
  event/task; lean on P8's existing oscillation/cooldown suppression rather than re-implementing it.
- **Post-mortem gap after GC** → audit retention ≥ transcript backup window; diff falls back to MR; verify
  explicitly with the GC'd-task test. Never tie audit retention to worktree lifecycle.
- **Dashboard becomes a control panel** (scope creep into actions that violate the hard rules) → keep it
  read-only by design; the only writes are the P8 kill-switch and audit-ack; merging links out to GitLab.
- **Operator rubber-stamps anyway** (oversight aids ignored) → D9 surfaces the rate-limit and forces
  explicit acks on sampled merged MRs so coverage is measurable; this mitigates but cannot fully prevent
  inattentive review — the random sample exists precisely to catch drift over time.
- **Local-only server exposed** → bind `127.0.0.1` only; no remote/auth surface (single-operator, same
  machine as the orchestrator, consistent with D2).
