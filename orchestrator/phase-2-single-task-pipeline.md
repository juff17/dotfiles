# Phase 2 — Single-task pipeline: implement → MR

> Prove the thinnest end-to-end slice: hand the orchestrator one ticket → it spins a worktree, runs a
> headless Claude worker to implement, then **deterministically** commits, pushes, and opens an MR that
> lands "ready for human". No review stages.

## Value & rationale
This is the first phase that produces a real, mergeable artifact. It is the smallest slice that exercises
the **core architectural principle end-to-end**: *the agent decides; the orchestrator acts*. The worker
only edits files (and writes `GOAL.md`); every state-mutating git/glab call (`commit`, `push`,
`glab mr create`) is performed by the orchestrator at a deterministic 🔒 gate, never by the LLM. Getting
this boundary right once — with one task, manually triggered — means every later phase (reviews, rebase,
templates, scheduling) just adds stages on top of a proven side-effect spine. Per the hard principle, ONE
pipeline must be fully working and battle-tested before any concurrency/scheduling/UI is added.

## Dependencies (Depends on / Enables)
- **Depends on P0** — environment & auth (`claude` logged in to enterprise/Opus, `glab` authed as
  operator, Node), the global `SessionStart` ignore hook (so `GOAL.md` and `.claude/worktrees/` never land
  in a diff), `cleanupPeriodDays` ≥ 90, and the worker `.claude/settings.json` deny-list.
- **Depends on P1** — the GitLab side-effect module (`glab` wrapper). This phase calls P1 for
  `mr create` (and its idempotent "reuse existing MR for branch" check). It does **not** reimplement glab.
- **Enables P3** — the review pipeline inserts stages 2–6 between stage 1 and the final push/MR gate using
  the same worktree, worker-invocation, and gate machinery this phase establishes.

## In scope
- **Worktree creation per task** — one git worktree + branch per task under the default
  `.claude/worktrees/` (git-ignored via the P0 hook). Disk-space precondition before creating it.
- **Worker invocation** — a single headless Claude run (`claude -p … --output-format stream-json`), Opus,
  with the worker deny-list applied, cwd = the worktree. Capture and persist the `sessionId`.
- **GOAL.md artifact** — the worker writes `GOAL.md` (goal + acceptance criteria) to the worktree root as
  stage 0; it is git-ignored and never committed to the MR.
- **stream-json capture** — every worker event streamed to a per-task log file on disk.
- **Deterministic 🔒 gates** — `git add -A && git commit` (idempotent / no-op on a clean tree), `git push`
  (set upstream), then `glab mr create` (via P1, reusing an existing MR for the branch if present).
- **Task record in SQLite** — the Phase-2 subset of the `Task` model (fields below), persisted across the
  run so the slice is inspectable/recoverable.
- **`run` CLI** — a manually-invoked script that executes the whole slice for one ticket and leaves an MR
  "ready for human".

## Out of scope (deferred)
- **All review stages** — pr-review-toolkit, ponytail, GOAL-conformance, Greptile triage, decision-log →
  **P3** (stages 2–6 of the architecture pipeline table).
- **Rebase babysitting / conflict resolution / `--resume` flow** → **P4**.
- **Workflow templates** (ticket / TRD / doc selection) → **P5**. Phase 2 hard-codes the ticket flow.
- **Jira-driven intake & dependency graph** (`issuelinks` → DAG, `baseBranch` from links) → **P6**. Phase 2
  takes the ticket/brief from the operator on the command line; `baseBranch` is `main`.
- **Scheduler, concurrency cap, branch-stacking, file-overlap detection** → **P7**. Phase 2 runs exactly
  one task synchronously.
- **Reliability hardening** — crash-recovery reconciliation, retry/backoff, runaway/timeout detection,
  circuit breakers, worktree GC, kill-switch, Tier-1 sandbox → **P8**. (Gates are written idempotently here
  because that is intrinsic to the gate, but the recovery *machinery* is P8.)
- **Dashboard / notifications / audit UI** → **P9**. Phase 2 logs to disk and prints to the console.
- **Merging** — never. Hard rule: the pipeline stops at "ready for human"; a human merges in GitLab.

## Design
The pipeline runs only the first two rows of the architecture's ticket stage machine plus the final
push/MR gate (the review gates in between are P3):

| # | Stage | Who | Output |
|---|---|---|---|
| 0 | Write **GOAL.md** to worktree root (incl. acceptance criteria) | agent | persistent goal artifact |
| 1 | Implement until done | agent (Opus) | edited working tree |
| 🔒 | `git add -A && git commit -m "feat: <goal>"` (no-op if clean) | orchestrator | checkpoint commit |
| 🔒 | `git push -u origin <branch>` | orchestrator | branch on remote |
| 🔒 | `glab mr create` (reuse existing MR for branch if present) → **ready for human** | orchestrator (P1) | MR opened |

Stages 0 and 1 are a **single worker invocation**: the worker is instructed to first write `GOAL.md`,
then implement against it, then stop. (Splitting them into two `claude -p` calls is a P3+ concern; for the
minimal slice one Opus session does both and we capture its `sessionId`.)

### The side-effect boundary in code terms
Two clearly separated layers, mirroring *agent decides / orchestrator acts*:

- **`worker.ts` (deliberative)** — spawns `claude -p` as a child, cwd = worktree, streams its events to the
  log, returns `{ sessionId, exitCode }`. It performs **zero** git/glab calls. The only filesystem mutation
  is whatever the agent does inside the worktree via Edit/Write (incl. writing `GOAL.md`).
- **`gates.ts` (side-effecting, 🔒)** — pure deterministic functions the orchestrator calls *because a stage
  completed*, never because the LLM asked: `commitAll(worktree, message)`, `pushBranch(worktree, branch)`,
  and `openMr(...)` (which delegates to the P1 module). Each is idempotent (see below).

`pipeline.ts` is the conductor: create worktree → run worker → run the three gates in order → update the
SQLite `Task` after each step. No git/glab side-effect exists anywhere in `worker.ts`; no LLM call exists
anywhere in `gates.ts`. This separation is the whole point of the phase.

### Worktree
- Created with `git worktree add` (equivalently `claude --worktree`), default location
  `.claude/worktrees/<branch>` under the repo. Headless `-p` skips the interactive trust prompt.
- Branch name derived deterministically, e.g. `agent/<jiraKey-or-slug>` off `main` (`baseBranch = main` in
  this phase). The worktree path + branch are persisted on the `Task`.
- A disk-space precondition is checked before `git worktree add` (a full disk causes destructive git
  failures). Worktree is **not** GC'd in this phase (cleanup is P8) — left on disk for inspection.
- Already git-ignored via the P0 `SessionStart` hook (`.claude/worktrees/`, `GOAL.md` in `.git/info/exclude`).

### Worker invocation (headless Claude, Opus, deny-list)
Run as a child process from the orchestrator, cwd = the worktree, e.g.:

```bash
claude -p "$PROMPT" \
  --output-format stream-json \
  --model opus \
  --permission-mode acceptEdits
# cwd = .claude/worktrees/<branch>
# .claude/settings.json in the worktree carries the deny-list (git/glab/rm mutations denied)
```

- The deny-list is inherited from the worker `.claude/settings.json` set up in P0 — defense-in-depth, not a
  boundary. The real backstop is that the orchestrator performs every commit/push/MR and humans-only-merge.
- The **prompt** instructs the agent to: (1) write `GOAL.md` (goal restated + explicit acceptance criteria)
  to the worktree root; (2) implement the ticket until the acceptance criteria are met, editing files only;
  (3) **not** run any `git`/`glab` command — those are the orchestrator's job; (4) stop when done.
- stdout (`stream-json` events) is piped line-by-line to the per-task log; the final `sessionId` is parsed
  from the event stream and saved on the `Task` (needed later for `--resume`; captured now to prove it works).

### GOAL.md artifact
- Written by the agent during stage 0 at `<worktree>/GOAL.md`. Git-ignored; **never** appears in the MR diff.
- It is the durable statement of intent (re-read by every later stage in P3+). Phase 2 only requires that it
  is produced and survives on disk; the `commit -m "feat: <goal>"` message uses its goal line.

### Deterministic gates (the git/glab sequence)
All run by the orchestrator, in order, after the worker exits 0. Each is idempotent so a re-run is safe:

```bash
# 🔒 gate 1 — commit (idempotent: no-op on a clean tree)
git -C "$WORKTREE" add -A
git -C "$WORKTREE" diff --cached --quiet || \
  git -C "$WORKTREE" commit -m "feat: <goal-line-from-GOAL.md>"

# 🔒 gate 2 — push (set upstream; safe to re-run)
git -C "$WORKTREE" push -u origin "$BRANCH"

# 🔒 gate 3 — open MR (via P1; reuses an existing MR for the branch if present)
#   P1 internally: glab mr list --source-branch "$BRANCH"  → reuse, else:
#   glab mr create --source-branch "$BRANCH" --target-branch main \
#     --title "<goal-line>" --description "<brief>"  (NEVER --merge / never auto-merge)
```

- **Commit** is a no-op when the agent made no changes (clean tree) — logged as "clean, nothing to commit",
  still advances to push (the branch may already exist remotely). Commit message draws its summary from
  `GOAL.md`'s goal line.
- **Push** sets the upstream; re-running after a successful push is a harmless no-op.
- **MR create** delegates to the P1 module, which first checks `glab mr list --source-branch` and **reuses**
  an existing MR rather than erroring — so re-running `run` on the same task is idempotent end-to-end.
- **Never** `glab mr merge`. The pipeline ends at "MR ready for human"; the `mrUrl` is printed and stored.

### Task state (SQLite) — Phase-2 subset
Phase 2 persists only the fields the slice needs (a strict subset of the architecture's `Task` model):

```ts
type Phase2Task = {
  id: string                 // orchestrator task id (uuid)
  jiraKey?: string           // optional in P2 (real Jira intake is P6); operator may pass a label
  repo: string               // absolute path / identifier of the target repo
  brief: string              // ticket description + operator-supplied context (the worker prompt input)
  worktree?: string          // .claude/worktrees/<branch>
  branch?: string            // agent/<key-or-slug>, off main
  sessionId?: string         // captured from stream-json (for later --resume; proven here)
  mrUrl?: string             // set by gate 3
  stage: "goal" | "implement" | "commit" | "push" | "mr" | "done"  // current stage, persisted
  status: "queued" | "running" | "review" | "needs-human" | "failed"
}
```

SQLite table mirrors these columns. `stage` is updated as each step completes (a foundation for P8
crash-recovery, even though recovery logic itself is deferred). On success the task ends
`stage: "done"`, `status: "review"` (i.e. ready for human review of the MR). On worker non-zero exit or a
gate failure, `status: "failed"` and the error is logged.

## Implementation steps (ordered)
1. **SQLite schema** — create the `tasks` table with the Phase-2 subset columns above; a tiny data-access
   module (`db.ts`) with `createTask`, `updateTask`, `getTask`. Reuse the P0/P1 SQLite connection if one
   exists.
2. **Worktree module (`worktree.ts`)** — `createWorktree(repo, branch)`: disk-space precondition →
   `git -C <repo> worktree add .claude/worktrees/<branch> -b <branch> main`; return the worktree path.
   Idempotent: if the worktree/branch already exists, reuse it.
3. **Worker module (`worker.ts`)** — `runWorker(worktree, prompt) → { sessionId, exitCode }`: spawn
   `claude -p <prompt> --output-format stream-json --model opus`, cwd = worktree; tee stdout to the per-task
   log file; parse and return `sessionId`. No git/glab calls.
4. **Prompt builder** — compose the stage-0+1 prompt from the `brief`: instruct write-GOAL.md-then-implement,
   editing files only, never running git/glab, stop when acceptance criteria met. Wrap operator/brief text
   as data (carry over the untrusted-input convention even though P2 input is operator-supplied).
5. **Gates module (`gates.ts`)** — implement `commitAll`, `pushBranch` deterministically + idempotently as
   above; `openMr` thin-wraps the **P1** module (reuse-existing-MR check inside P1).
6. **Pipeline conductor (`pipeline.ts`)** — orchestrate: createTask → createWorktree → updateTask(worktree,
   branch, stage=goal/implement) → runWorker → capture sessionId → gate1 commit (stage=commit) → gate2 push
   (stage=push) → gate3 MR (stage=mr, mrUrl) → updateTask(stage=done, status=review). Surface failures.
7. **`run` CLI** — parse args (`run <brief-or-ticket-file> [--repo <path>] [--key <JIRA-KEY>]`), call the
   pipeline, print the resulting `mrUrl` and the per-task log path.
8. **Per-task logging** — log path convention (e.g. `logs/<taskId>.stream-json.log`), retained on disk
   independent of the worktree (foundation for P9 audit; just a file here).

## How to run it (manual / script) — exact `run <ticket>` example
```bash
# from the orchestrator repo, one ticket end-to-end:
run "Add a --version flag to the CLI that prints the package version and exits 0" \
    --repo /home/jonathan/projects/acme-service \
    --key  ACME-1234

# what happens, in order:
#  1. worktree:  /home/jonathan/projects/acme-service/.claude/worktrees/agent-ACME-1234  (branch agent/ACME-1234 off main)
#  2. worker:    claude -p "<write GOAL.md then implement …>" --output-format stream-json --model opus   (cwd = worktree)
#                → writes GOAL.md, edits files, exits 0; sessionId captured
#  3. 🔒 commit: git add -A && (clean? no-op : commit -m "feat: add --version flag")
#  4. 🔒 push:   git push -u origin agent/ACME-1234
#  5. 🔒 MR:     glab mr create --source-branch agent/ACME-1234 --target-branch main …   (via P1; reuse if exists)
#
# output:
#   MR ready for human: https://gitlab.example.com/acme/acme-service/-/merge_requests/42
#   worker log: logs/<taskId>.stream-json.log
```
The brief may also be passed as a file path. No reviews run; the MR is left for a human to review & merge.

## Testing & battle-testing
Run on a **real trivial ticket** end-to-end against a real (test) GitLab repo — e.g. "add a `--version`
flag" — and confirm: worktree created & git-ignored, `GOAL.md` written (and absent from the MR diff),
stream-json captured to the log, `sessionId` recorded, a single commit pushed, an MR opened to `main` in a
non-merged/ready state, and the `Task` row ends `stage=done / status=review`.

Edge cases to exercise:
- **Clean tree (agent made no edits)** — commit gate must **no-op** (not error), log "nothing to commit",
  and either still open an MR for an existing pushed branch or fail gracefully with a clear message
  ("no changes to propose"). Re-running `run` on an already-completed task must be idempotent (reuse
  worktree, no duplicate commit, reuse the existing MR — proves the P1 reuse check).
- **Agent failure** — worker exits non-zero / produces no `GOAL.md`: pipeline stops **before** any
  side-effect gate, sets `status=failed`, preserves the worktree + log for inspection, runs **no** git/glab.
- **Push rejected** — remote rejects the push (e.g. branch protection / non-fast-forward / no permission):
  the gate surfaces the `git push` error, sets `status=failed`, does **not** attempt `glab mr create`, and
  the commit remains locally (recoverable on re-run because gates are idempotent). Full retry/backoff is P8.
- **Deny-list sanity** — confirm the worker cannot run `git commit`/`git push`/`glab` from inside its
  session (denied), proving the side-effect boundary holds for the happy path.

## Exit criteria (done when)
- `run "<ticket>" --repo <path>` takes a single ticket and leaves a **single MR ready for human** on a real
  repo, with **no** git/glab side-effect performed by the agent — all commits/push/MR done by the
  orchestrator at the 🔒 gates.
- `GOAL.md` is produced in the worktree and **never** appears in the MR diff (P0 ignore hook verified).
- The worker's stream-json is captured to a per-task log and the `sessionId` is recorded on the `Task`.
- The Phase-2 `Task` row is persisted in SQLite through every stage and ends `stage=done / status=review`.
- The three edge cases (clean tree, agent failure, push rejected) behave as specified, and re-running the
  same task is idempotent (reuses worktree + MR, no duplicate commit).
- The pipeline **never** merges and stops at "ready for human".

## Risks & mitigations
- **Agent runs git/glab despite the deny-list** (string-prefix matching is bypassable). *Mitigation:* the
  orchestrator owns all side-effects regardless; deny-list is defense-in-depth; a `PreToolUse` hook (P0) logs
  attempts; human-only-merge is the real backstop; Tier-1 sandbox makes it a technical boundary in P8.
- **GOAL.md or worktree leaking into the MR diff.** *Mitigation:* rely on the P0 `SessionStart` ignore hook;
  the battle-test explicitly asserts `GOAL.md` is absent from the diff.
- **`glab mr create` failing on re-run (duplicate MR).** *Mitigation:* delegate to P1, which checks
  `glab mr list --source-branch` and reuses an existing MR — making the whole `run` idempotent.
- **Worker hangs / never stops (no timeout in P2).** *Mitigation:* accept for the manual single-task slice
  (operator watches it); runaway/timeout detection is explicitly deferred to P8. Document the manual abort.
- **Push rejected / branch protection.** *Mitigation:* surface the error, `status=failed`, no MR attempted;
  gates are idempotent so a corrected re-run is safe. Robust retry/backoff is P8.
- **sessionId not parseable from stream-json.** *Mitigation:* the slice still completes the MR; log a warning
  and store null — `--resume` consumers are P4, so a missing id is non-fatal here but flags a parsing bug.
