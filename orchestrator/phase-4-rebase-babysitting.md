# Phase 4 — Rebase babysitting

> On-demand: bring a long-open MR up to date for merge — server-side rebase when clean, session-resumed agent resolution when conflicted — and leave it **ready for a human to merge** (never merges).

## Value & rationale (days-later lag; why on-demand)

By the end of P3 an MR is *ready for human* with a decision log. But human review and the actual merge
often happen **days or weeks later**. In that lag the target branch (`main`) moves on: the MR goes stale,
falls behind, and frequently develops merge conflicts. A stale MR can't be merged until it's brought
up to date — and the operator is the one who decides *when* it's time to merge.

This phase is therefore **on-demand**, not scheduled: the operator runs `rebase <mr>` exactly when they
intend to merge, so the MR is fast-forward-able right then (minimising the chance it goes stale *again*
between rebase and merge). It is deliberately **not** triggered automatically — auto-triggering on merge
of a blocker is P7 (scheduler), and a notification channel for "rebase-ready" is P9. Here the command is
a manually-invoked script.

The hard rule still holds end to end: this phase **prepares** the MR (rebased, verified, pushed) and routes
it to a human. It **never merges**. And because conflict resolution is a judgement call where an agent can
silently drop one side's logic, **agent-resolved conflicts always route to `needs-human`** (D4) — even when
the local verification passes.

## Dependencies (Depends on / Enables)

**Depends on:**
- **P1 — GitLab module.** Provides `glab mr view <id> -F json` → `detailed_merge_status` (the detection
  input), `glab mr rebase <id>` (server-side rebase), MR comment posting (rebase-transcript), and MR
  metadata (source branch, target branch, project).
- **P2 — Single-task pipeline.** Provides the `Task` record (worktree path, branch, `sessionId`, `mrUrl`),
  the worktree-on-disk + git-ignored artifacts (`GOAL.md`, `decision-log.jsonl`), the per-repo `verify`
  command config, and the deterministic-gate / `claude --resume` invocation patterns.
- **P3 — Review pipeline.** Establishes that the MR exists and reached *ready for human*, plus the decision
  log that primes a resumed/fallback session.

**Enables:**
- Completes the **single-MR lifecycle** (intake → implement → review → ready → *kept mergeable* → human merge).
- **P7 — Scheduler** reuses this command: when a blocker merges, dependents are rebased via the same flow.

## In scope

- **Detection** via P1's `detailed_merge_status`, with the four-way action table (mergeable / need_rebase /
  conflict / everything-else) and the "absence of a known value is **not** mergeable" rule.
- **Server-side rebase** for `need_rebase`: a single `glab mr rebase <id>`, no agent, no worktree.
- **Local conflict flow** (the numbered 🔒-gated flow below): disk-space precondition → ensure worktree →
  fetch → capture remote tip SHA → `git rebase origin/<target>` → list conflicts → resume session to
  resolve content → `git add` + `git rebase --continue` loop → per-repo verification → fresh fetch +
  `git push --force-with-lease=<branch>:<SHA>` → set `conflictsResolvedByAgent=true` → route to
  `needs-human` → post rebase-transcript → notify (print/log).
- **Session continuity:** honour `cleanupPeriodDays`; resume in the original directory; **fallback** to a
  fresh session primed with GOAL.md + decision-log + diff when the session is gone/compacted; re-capture the
  (possibly changed) session ID after resume.

## Out of scope (deferred to …)

- **Workflow templates** (TRD/doc variants of verification) → **P5**.
- **Jira** integration / link-driven targets → **P6**.
- **Scheduler / auto-triggering** the rebase when a blocker merges, and concurrency → **P7**.
- **Full reliability layer** — retry/backoff policy, runaway detection, worktree GC, circuit breakers,
  crash-recovery reconciliation → **P8**. (This phase implements only the *inline* preconditions it needs:
  disk-space check, worktree-present check, fallback session.)
- **Dashboard + a real notification channel** → **P9**. Here "notify" = print/log to the operator's console.
- **CI gating logic** (`ci_still_running` / `ci_must_pass` beyond "wait / report") → P7/P8.
- **Merging.** Always — by hard rule.

## Design

### Detection (the table)

Read once per invocation via P1: `glab mr view <id> -F json` → `detailed_merge_status`. Branch on it:

| `detailed_merge_status` | Action |
|---|---|
| `mergeable` | **Report ready — a human merges.** The orchestrator never merges. Stop. |
| `need_rebase` (behind, no conflicts) | `glab mr rebase <id>` — **server-side**, no agent, no worktree. Re-poll to confirm `mergeable`, then report ready. |
| `conflict` (behind, with conflicts) | **Local conflict flow** (below). `glab mr rebase` *cannot* resolve conflicts (it errors), so we must rebase locally first. |
| `ci_still_running` / `ci_must_pass` | Wait / report (no agent action). |
| **any other value** (`discussions_not_resolved`, `not_approved`, `draft_status`, `checking`, `preparing`, `blocked_status`, …) | **Report blocked / wait.** Never treat an unknown/absent status as mergeable — only the explicit `mergeable` value is. |

### Local conflict flow (deterministic gates 🔒; the agent edits conflict *content* only)

The agent's *only* job is to resolve conflict markers in working files. Every git/glab mutation is an
orchestrator-owned 🔒 gate (workers are denied `git`/`glab` per the deny-list).

1. 🔒 **Precondition + setup.** Check free disk space (a full disk causes destructive git failures);
   abort with a clear error if low. Ensure the original worktree exists on disk (it must not have been
   GC'd — see session continuity). `git fetch origin`. **Capture the remote tip SHA** of `<branch>`
   (`git rev-parse origin/<branch>`) — this pins the later force-push. Then `git rebase origin/<target>`.
2. 🔒 **On rebase stop, list conflicts:** `git diff --name-only --diff-filter=U`. (If empty and rebase
   already finished cleanly, skip to gate 6.)
3. **Agent resolves content (deliberative).** Resume the original session (`claude --resume <id>`) in the
   worktree directory; **inject GOAL.md + decision-log**; instruct the agent to resolve the listed conflict
   files (keep *both* sides' intent — never silently drop logic), and to **append its reasoning to
   `rebase-transcript.md`**. The agent edits files only; it cannot run git. **Re-capture the (possibly new)
   session ID** afterward and update the task→session mapping.
4. 🔒 **Stage + continue loop.** `git add <resolved files>` → `git rebase --continue`. A rebase replays
   commit-by-commit, so this may stop again on a later commit → return to gate 2 and loop until the rebase
   completes (or aborts cleanly on unrecoverable state → `needs-human`).
5. 🔒 **Per-repo verification.** Run the repo's configured `verify` command (P2 config, with its timeout).
   On failure → hand the failure back to the agent (gate 3) to fix; cap retries → `needs-human`.
   *Verification-green is necessary but **not** sufficient* (D4) — it does not authorise a merge.
6. 🔒 **Fresh fetch + pinned force-push.** `git fetch origin` again, then
   `git push --force-with-lease=<branch>:<captured-SHA>`. Pinning to the SHA captured at gate 1 means a
   **concurrent push by someone else** makes the lease fail loudly rather than silently clobbering their
   work (a bare `--force-with-lease` re-reads the ref and degrades into a blind force-push).
   On lease failure → abort, report concurrent-push conflict, re-run from gate 1.
7. 🔒 **Route to human.** Set `conflictsResolvedByAgent = true` → route the task to **`needs-human`**
   (D4 — re-review of just the resolution hunks). **Post the rebase-transcript** to the MR and **notify**
   the operator (print/log). The force-push re-triggers CI + Greptile, which the human sees on re-review.

> **NEVER merges.** Every branch of this phase ends at *report ready (human merges)* or *`needs-human`*.
> No path runs `glab mr merge`.

### Session resume + fallback

`--resume` lets the *same* agent that wrote the code resolve its own conflicts with full context — the ideal
case. But days-later lag makes that fragile, so we design around three failure modes:

- **Transcript expiry.** Claude deletes session transcripts after `cleanupPeriodDays` (default 30, plus
  reported silent-cleanup bugs). We set **`cleanupPeriodDays` to 90+** (per README §3) **and** back up the
  transcript at MR creation (P2/P3). **Never `0`** — a confirmed bug makes `0` *disable transcript writing*
  rather than retain forever.
- **Worktree gone.** `--resume` needs the **original directory + working files**. Do not GC the worktree
  until merged (gate 1 asserts it's present; the stale backstop / GC policy is P8).
- **Compaction / session lost.** A days-old session may be compacted, or the transcript truly gone. Treat
  **GOAL.md + decision-log as the durable source of truth**; the live session is only an optimization. If
  resume is unavailable, **fall back to a fresh `claude -p` session primed with GOAL.md + decision-log + the
  current diff** (and the conflict file list). The fallback resolves conflicts identically; only the
  priming differs.
- **Session ID drift.** A resume can return a **new** session ID. Capture it after every resume/fallback and
  persist it to the `Task` so the next operation resumes the right session.

### Force-with-lease pinning (why `:<SHA>`)

Capturing `origin/<branch>` at gate 1 and pushing `--force-with-lease=<branch>:<captured-SHA>` makes the
push **conditional on the remote not having moved** since we started. A plain `--force-with-lease` re-reads
the remote ref at push time, so if the orchestrator's own gate-6 `git fetch` updated the local remote-tracking
ref, the lease would be satisfied against the *new* tip — i.e. it would happily clobber a concurrent push.
Pinning to the SHA we observed *before* doing any work closes that window.

## Implementation steps (ordered)

1. **`rebase(mr)` entry point.** Resolve `mr` → `Task` (via stored `mrUrl`/MR id). Load source branch,
   target branch, project, worktree path, `sessionId` from state (SQLite).
2. **Detection.** Call P1 to get `detailed_merge_status`; implement the four-way switch with the explicit
   allow-list (only `mergeable` is mergeable; unknown → blocked).
3. **`mergeable` path.** Print/log "ready for human merge — <MR url>"; done.
4. **`need_rebase` path.** `glab mr rebase <id>` via P1; re-poll `detailed_merge_status`; report
   `mergeable` (or surface the new status, e.g. it now shows `conflict` → fall into the conflict path).
5. **Conflict path — gate 1.** Disk-space check; assert worktree on disk; `git fetch`; capture
   `git rev-parse origin/<branch>` as `pinnedSha`; `git rebase origin/<target>`.
6. **Conflict loop — gates 2–4.** List `--diff-filter=U`; resume-or-fallback session with GOAL.md +
   decision-log injected; agent resolves + appends to `rebase-transcript.md`; re-capture session id;
   `git add` resolved; `git rebase --continue`; loop until rebase done.
7. **Verification — gate 5.** Run per-repo `verify`; on failure loop back to the agent (capped) else
   `needs-human`.
8. **Push — gate 6.** `git fetch`; `git push --force-with-lease=<branch>:<pinnedSha>`; handle lease failure
   (concurrent push) by reporting + restarting from gate 1.
9. **Route + report — gate 7.** Set `conflictsResolvedByAgent=true`; status → `needs-human`; post
   `rebase-transcript.md` to the MR (P1); print/log "rebase-ready, needs human re-review".
10. **Persistence.** Every state change (status, sessionId, pinnedSha, conflictsResolvedByAgent) written to
    SQLite as it happens, so a re-run is safe (gates are idempotent: a clean tree no-ops, a finished rebase
    skips, a re-post is de-duplicated).
11. **Logging.** Log each side-effect (rebase, push SHA, MR comment id) to the per-task audit trail.

## How to run it (manual / script) — exact `rebase <mr>` example

```bash
# Operator decides MR !4321 is ready to merge, days after review.
$ orchestrator rebase !4321

[detect] MR !4321 detailed_merge_status = conflict
[gate 1] disk ok (84G free); worktree present: .claude/worktrees/PROJ-128
         fetched origin; pinned origin/feat/PROJ-128 = a1b2c3d
         git rebase origin/main → STOPPED (conflicts)
[gate 2] conflicts: src/payment/charge.ts, src/payment/refund.ts
[gate 3] resuming session 7f3e… (original dir) + GOAL.md + decision-log
         agent resolved 2 files; appended rebase-transcript.md
         re-captured session id → 9a8b…
[gate 4] git add … ; git rebase --continue → rebase complete
[gate 5] verify (npm test) … PASS
[gate 6] fetched origin; push --force-with-lease=feat/PROJ-128:a1b2c3d → OK
[gate 7] conflictsResolvedByAgent=true → status=needs-human
         posted rebase-transcript to MR; force-push re-triggered CI + Greptile
NOTIFY (print): MR !4321 is rebased & verified — NEEDS HUMAN re-review of resolution hunks, then HUMAN merge.
```

Clean case:

```bash
$ orchestrator rebase !4400
[detect] detailed_merge_status = need_rebase
[rebase] glab mr rebase !4400 (server-side) … done; re-poll → mergeable
NOTIFY (print): MR !4400 is mergeable — ready for HUMAN merge (orchestrator never merges).
```

## Testing & battle-testing

- **Force a real conflict days later.** Take a real P3-ready MR, let `main` advance with an overlapping
  change (or fabricate one), wait past a session-active window, run `rebase`. Verify: conflict detected,
  session resumes (or falls back), agent resolves keeping both intents, verify passes, push succeeds,
  status → `needs-human`, transcript posted. Confirm **no merge** happened.
- **Detection edge cases.** Assert each `detailed_merge_status` routes correctly; assert an unknown/new
  status value reports *blocked*, not mergeable.
- **Session gone / compacted.** Delete the transcript (or simulate compaction) and confirm the **fallback**
  fresh session primed with GOAL.md + decision-log + diff resolves the conflict equivalently, and the new
  session id is captured.
- **Session id drift.** Confirm the task→session mapping is updated after resume.
- **Verification fails.** Inject a resolution that breaks tests; confirm it loops back to the agent and,
  past the retry cap, routes to `needs-human` (never pushes a broken rebase as ready).
- **Concurrent remote push.** Between gate 1 and gate 6, push to the branch from elsewhere; confirm
  `--force-with-lease=<branch>:<pinnedSha>` **fails loudly** and nothing is clobbered, then a re-run
  recovers from gate 1.
- **Multi-commit rebase.** A branch with several commits each conflicting → confirm the continue loop
  handles repeated stops.
- **Worktree GC'd.** Remove the worktree; confirm gate 1 aborts clearly (and, with fallback, can recreate
  context) rather than corrupting state.
- **Idempotency / re-run.** Re-run `rebase` after a successful run (now `mergeable`) → reports ready,
  does nothing destructive. Re-run after a mid-flow crash → resumes from the last gate without double-pushing
  or double-posting the transcript.

## Exit criteria (done when)

- `rebase <mr>` correctly detects all `detailed_merge_status` cases per the table (unknown → blocked).
- `mergeable` reports ready; `need_rebase` does a server-side rebase and re-confirms — **neither merges**.
- The conflict flow runs end-to-end: rebase → session-resume/fallback resolution → continue loop →
  per-repo verification → fresh-fetch pinned force-push → `conflictsResolvedByAgent=true` → `needs-human`
  → rebase-transcript posted → operator notified (print/log).
- Session continuity works: `cleanupPeriodDays` ≥ 90, resume in original dir, fallback to a primed fresh
  session, re-captured session id.
- Force-push is **always** pinned to the gate-1 SHA; a concurrent push fails the lease.
- A battle-test conflict (days later) passes; verified by a human reviewing only the resolution hunks.
- **No code path can merge.** Confirmed by inspection and tests.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Agent "resolves" by silently dropping one side's logic | D4: agent-resolved conflicts **always** → `needs-human` with a diff of just the resolution hunks; verify-green is necessary but not sufficient. |
| Session expired/compacted by merge time | `cleanupPeriodDays` ≥ 90 + transcript backup at MR creation; durable GOAL.md + decision-log; fallback fresh primed session. Never set `0`. |
| Worktree GC'd before merge | Don't GC until merged (gate 1 asserts presence; stale backstop in P8); fallback can rebuild context. |
| Concurrent push clobbered by our force-push | Pin `--force-with-lease=<branch>:<captured-SHA>` to the pre-work tip; lease fails loudly on a concurrent push. |
| `glab mr rebase` invoked on a conflicting MR (errors) | Detection routes `conflict` to the *local* flow; server-side rebase is only ever used for `need_rebase`. |
| Unknown/new `detailed_merge_status` treated as mergeable | Explicit allow-list: only `mergeable` is mergeable; everything else reports blocked/wait. |
| Verification passes but resolution is wrong | Still routes to `needs-human` (D4); human re-reviews hunks; CI + Greptile re-run on force-push. |
| Full disk corrupts git mid-rebase | Disk-space precondition at gate 1 aborts before any mutation. |
| Re-run causes double push / double comment | Idempotent gates: clean tree no-ops, finished rebase skips, transcript post de-duplicated. |
