# Phase 1 — GitLab module
> A thin, well-tested orchestrator-side wrapper over `glab` (MR ops, read/post comments, CI status, `detailed_merge_status`, server-side-rebase detection) that is useful standalone — before any agent or pipeline exists.

## Value & rationale (why a standalone glab module first)
Every later phase (P2 single-task pipeline, P3 review loop, P4 rebase babysitting, P7 poller) ends in the
same place: **the orchestrator talking to GitLab through `glab`.** That is the one external integration
surface in the whole system, and the architecture's open risk list flags it directly — *"GitLab MR comment
flow is less mature than GitHub's — test the poller early."* Building and battle-testing this wrapper first
de-risks every phase above it.

It also pays off immediately, *standalone, by hand*, before a single agent exists:
- Fetch an MR's Greptile + human comments to read them in one place.
- Post a reply or a new comment to an MR by hand.
- Check CI status and the **detailed** merge status of an MR (the value set that drives P4 routing).
- Open (or idempotently reuse) an MR for a branch.
- Distinguish "GitLab can rebase this server-side" from "this needs a local rebase" — *without* doing the
  local rebase here.

This is the embodiment of the side-effect boundary: **the agent decides; the orchestrator acts.** This
module *is* the "acts" half for GitLab. It runs as the **operator** (operator's own `glab` auth, D2), never
inside a worker. It contains **no merge function at all** (D4/D5 hard rule) — see Design.

## Dependencies (Depends on / Enables)
- **Depends on:** P0 (foundations) — `glab` installed and authenticated as the operator; Node/TS toolchain;
  the per-repo `glab` project mapping. No SQLite schema is strictly required to *use* the module, but the
  comment-dedup store (below) is the first small table this module owns.
- **Enables:** P2 (commit/push → `openMR`), P3 (`listComments` incl. Greptile, `postReply`/`postComment`,
  `getCIStatus`), P4 (`getDetailedMergeStatus`, server-side `rebase`), P7 (poller calls `listComments`).

## In scope
A single TS module (importable) plus a thin CLI front-end exposing exactly these operations:
- `openMR` — `glab mr create`, **idempotent**: reuse an existing open MR for the source branch via
  `glab mr list --source-branch`.
- `getDiff` — the MR diff for review/inspection.
- `listComments` — all discussion notes on an MR, including **Greptile** comments, with author/source
  classification so callers can filter (Greptile vs human).
- `postReply` / `postComment` — reply to a discussion or post a new note, **de-duplicated** by tracked
  comment IDs in the state store (idempotent re-runs never double-post).
- `getCIStatus` — pipeline status for the MR's head.
- `getDetailedMergeStatus` — parse `glab mr view -F json` → `detailed_merge_status` into the **full value
  set** with explicit default/else handling (never infer "mergeable" from absence of a known value).
- `rebase` (server-side only) — run `glab mr rebase` for the `need_rebase` case, and **detect** the
  `conflict` case and surface it as "needs local rebase" *without executing one*.

CLI subcommands map 1:1 to these, all operating on a real GitLab MR.

## Out of scope (deferred to …)
- **Local rebase / conflict-resolution flow** → **P4** (rebase babysitting). This module only *detects*
  `conflict` and *returns* it; it never checks out, fetches, `git rebase`s, resolves, or force-pushes.
- **Any merge** → **never** (D4/D5 hard rule). There is deliberately **no `merge()` function and no
  `glab mr merge` invocation anywhere** in this module. `mergeable` resolves to "report ready for human".
- **The agent worker** (P2), **the polling loop / scheduler** (P7), and **comment-driven re-enqueue**
  (P3/P7) — this module is the *primitive* those build on, not the loop itself.
- Commit/push and `glab mr create` *as a pipeline gate* — P2 wires `openMR` into the stage machine; here it
  is just a callable function + CLI command.

## Design (TS interface, glab commands used, JSON parsing, idempotency, error handling; explicitly NO merge)

### TS interface sketch
```ts
// All operations run as the OPERATOR via `glab` (operator auth, D2). Never called from a worker.
// There is intentionally NO merge() — humans only merge (D4/D5 hard rule).

export type MergeStatusAction =
  | "ready_for_human"     // mergeable — orchestrator reports, human merges
  | "server_rebase"       // need_rebase — `glab mr rebase` (server-side, no agent)
  | "local_rebase"        // conflict — must do local rebase (P4); NOT executed here
  | "wait"                // ci_still_running | ci_must_pass | checking | preparing
  | "blocked";            // everything else (default/else) — report blocked, never assume mergeable

export type DetailedMergeStatus = {
  raw: string;                 // exact `detailed_merge_status` string from GitLab
  action: MergeStatusAction;   // mapped via the table below (default => "blocked")
};

export type CommentSource = "greptile" | "human" | "orchestrator" | "other";

export type MRComment = {
  id: string;                  // note id (for dedup + reply targeting)
  discussionId?: string;       // for threaded replies
  author: string;
  source: CommentSource;       // classified from author/username
  body: string;
  createdAt: string;
  resolvable: boolean;
  resolved: boolean;
};

export type CIStatus = {
  status: "success" | "failed" | "running" | "pending" | "canceled" | "manual" | "none" | "unknown";
  pipelineId?: number;
  webUrl?: string;
};

export type MR = { iid: number; webUrl: string; sourceBranch: string; targetBranch: string; title: string };

export type RebaseResult =
  | { kind: "rebased" }                 // server-side rebase succeeded
  | { kind: "needs_local_rebase" }      // conflict — hand off to P4; nothing done here
  | { kind: "not_needed" };             // already up to date

export interface GitLabModule {
  // Idempotent: reuse existing open MR for sourceBranch (glab mr list --source-branch) before creating.
  openMR(opts: {
    sourceBranch: string; targetBranch: string; title: string; description?: string;
    project?: string; removeSourceBranch?: boolean; draft?: boolean;
  }): Promise<MR>;

  getDiff(mr: number | string, opts?: { project?: string }): Promise<string>;

  listComments(mr: number | string, opts?: { project?: string; source?: CommentSource }): Promise<MRComment[]>;

  // Dedup by tracked comment IDs in the state store: re-running never double-posts.
  postComment(mr: number | string, body: string, opts?: { dedupKey?: string; project?: string }): Promise<MRComment>;
  postReply(mr: number | string, discussionId: string, body: string, opts?: { dedupKey?: string; project?: string }): Promise<MRComment>;

  getCIStatus(mr: number | string, opts?: { project?: string }): Promise<CIStatus>;

  getDetailedMergeStatus(mr: number | string, opts?: { project?: string }): Promise<DetailedMergeStatus>;

  // SERVER-SIDE ONLY. Detects conflict and returns needs_local_rebase WITHOUT doing a local rebase (P4).
  rebase(mr: number | string, opts?: { project?: string }): Promise<RebaseResult>;

  // NOTE: there is no merge(). This is intentional and load-bearing (D4/D5).
}
```

### glab commands used
| Operation | `glab` command (executed as child process) |
|---|---|
| find existing MR (idempotency) | `glab mr list --source-branch <branch> -F json` (filter to open) |
| open MR | `glab mr create --source-branch <b> --target-branch <t> --title <…> --description <…> [--draft] [--remove-source-branch] --yes` |
| diff | `glab mr diff <iid>` |
| list comments / notes | `glab mr view <iid> --comments` and/or `glab api projects/:id/merge_requests/:iid/discussions` (for ids + discussion threading) |
| post new comment | `glab mr note <iid> -m <body>` |
| post threaded reply | `glab api -X POST .../merge_requests/:iid/discussions/<discussionId>/notes -f body=<…>` |
| CI status | `glab ci status` / `glab mr view <iid> -F json` (pipeline field) |
| detailed merge status | `glab mr view <iid> -F json` → `.detailed_merge_status` |
| server-side rebase | `glab mr rebase <iid>` |

> All `glab` calls go through one `runGlab(args: string[])` helper that spawns the process with **argv
> arrays (never a shell string)**, captures stdout/stderr/exit code, and enforces a timeout. This avoids
> injection and is the single choke point for logging every side-effect (audit trail).

### JSON parsing — `detailed_merge_status` (full value set, explicit default)
Parse `glab mr view <iid> -F json` and map `detailed_merge_status` deterministically. **Never** treat the
absence of a known value as "mergeable" — the default branch is `blocked`/`wait`.

| `detailed_merge_status` value | `action` | What the orchestrator does |
|---|---|---|
| `mergeable` | `ready_for_human` | Report MR ready; **a human merges** (orchestrator never merges) |
| `need_rebase` | `server_rebase` | `glab mr rebase <iid>` — server-side, no agent, no conflicts |
| `conflict` | `local_rebase` | Hand off to **P4** local rebase + agent resolution; **not done here** |
| `ci_still_running` | `wait` | Wait / report; re-check later |
| `ci_must_pass` | `wait` | Wait for / report failing-or-pending CI |
| `checking` | `wait` | GitLab still computing mergeability; re-poll |
| `preparing` | `wait` | MR still being prepared; re-poll |
| `discussions_not_resolved` | `blocked` | Report blocked (open threads) |
| `not_approved` | `blocked` | Report blocked (approvals missing) |
| `draft_status` | `blocked` | Report blocked (draft) |
| `blocked_status` | `blocked` | Report blocked (external block) |
| `not_open` | `blocked` | Report blocked (closed/merged already) |
| **any other / unknown value** (default/else) | `blocked` | Report blocked — **never assume mergeable** |

> `glab mr rebase` cannot resolve conflicts during a server-side rebase and errors out — which is exactly
> why `conflict` maps to `local_rebase` (P4) and the server-side `rebase()` is only ever invoked for
> `need_rebase`. The `rebase()` helper additionally re-reads status after running and downgrades to
> `needs_local_rebase` if GitLab reports a conflict.

### Idempotency rules
- **`openMR`**: first `glab mr list --source-branch <branch> -F json`; if an **open** MR exists for the
  branch, return it (do not create a second). Only create when none exists. Safe to call repeatedly (P2/P8
  crash-recovery re-runs this gate).
- **`postComment` / `postReply`**: each post takes an optional stable `dedupKey` (e.g.
  `mr:<iid>:reply-to:<noteId>` or `mr:<iid>:decision-log`). Before posting, check the local **posted-comments
  table** (`{dedupKey, mrIid, glabNoteId}` in SQLite); if present, return the recorded comment instead of
  posting again. After a successful post, record the returned note id keyed by `dedupKey`. This makes the
  P3/P7 reply gates safe to re-run after a crash without double-posting.
- **`rebase`**: re-checking detailed merge status before and after is cheap; `need_rebase` → run, `mergeable`
  → `not_needed`, `conflict` → `needs_local_rebase` (no side-effect).

### Error handling
- `runGlab` returns a structured `{ code, stdout, stderr }`; non-zero exit → typed `GlabError` carrying the
  command (with secrets elided), exit code, and stderr tail.
- Distinguish **auth failure** (re-auth needed → surfaced clearly; P0/D2 operator token) from **not-found**
  (no MR for branch → `openMR` proceeds to create; other ops throw `MRNotFound`) from **transient/network**
  (retryable with backoff at the caller; this module surfaces the class, P8 owns the retry policy).
- JSON parse failures (e.g. a `glab` version that changed output) throw a typed `GlabParseError` rather than
  silently returning a wrong status — never degrade an unknown status to `mergeable`.
- **No merge path exists**, so there is no merge error to handle — by construction.

## Implementation steps (ordered)
1. **`runGlab` helper** — argv-array child-process spawn, timeout, captured streams, exit-code → typed
   result; central audit log line per call (command + outcome, secrets elided).
2. **JSON helpers** — typed parsers for `glab mr view -F json` and `glab mr list -F json`; tolerate extra
   fields, fail loudly on missing required ones.
3. **`getDetailedMergeStatus`** — implement the mapping table above with an exhaustive switch + `default =>
   blocked`. (Implement this early; it's the highest-value, most error-prone bit and unblocks P4.)
4. **`openMR`** — list-then-create idempotency; return normalized `MR`.
5. **`getDiff`**, **`getCIStatus`** — straightforward wrappers + normalization.
6. **`listComments`** — fetch notes/discussions, normalize to `MRComment`, classify `source` (Greptile vs
   human vs orchestrator vs other) by author username/bot identity.
7. **Posted-comments dedup store** — minimal SQLite table `{dedupKey PK, mrIid, glabNoteId, postedAt}`.
8. **`postComment` / `postReply`** — dedup-check → post → record.
9. **`rebase`** (server-side only) — status-gate → `glab mr rebase` for `need_rebase`; return
   `needs_local_rebase` for `conflict`; **assert there is no merge code path** (lint/test guard).
10. **CLI front-end** — one subcommand per operation (below), human-readable + `--json` output.
11. **Tests** — unit (mapping table, idempotency, dedup, source classification) + integration against a
    real test MR (battle-testing section).

## How to run it (manual / script) — real glab-backed CLI examples
Assumes `glab` is authenticated as the operator (P0). `gl` = this module's CLI (e.g. `node dist/cli.js`).

```bash
# Open (or reuse) an MR for the current branch — idempotent
gl open-mr --source feature/JIRA-123 --target main \
  --title "feat: JIRA-123 widget" --description "@goal see GOAL.md"
# running it again returns the SAME MR, does not create a second

# Get the diff of MR !42
gl diff 42

# List ALL comments on MR !42
gl comments 42
# Only Greptile comments
gl comments 42 --source greptile
# Only human comments
gl comments 42 --source human

# Post a new comment (idempotent via dedup key)
gl comment 42 --body "Decision log posted." --dedup-key "mr:42:decision-log"
# re-running with the same --dedup-key does NOT post again

# Reply to a specific discussion thread
gl reply 42 --discussion 8f3a... --body "Addressed in <sha>." --dedup-key "mr:42:reply:8f3a"

# CI status for MR !42
gl ci-status 42

# Detailed merge status -> action (the P4 router input)
gl merge-status 42
#   raw: need_rebase   action: server_rebase
gl merge-status 42 --json
#   {"raw":"conflict","action":"local_rebase"}

# Server-side rebase ONLY (need_rebase). conflict => prints "needs local rebase (P4)" and does nothing.
gl rebase 42

# There is deliberately no `gl merge` command. Humans merge in the GitLab UI (D4/D5).
```

## Testing & battle-testing (against a real test MR; edge cases)
**Unit (no network):**
- `detailed_merge_status` mapping — one case per row of the table **plus an unknown/garbage value asserting
  `blocked`** (the load-bearing default; absence of a known value must NOT be `mergeable`).
- `openMR` idempotency — mock `glab mr list` returning an existing open MR → asserts no create; returning
  empty → asserts create.
- `postComment`/`postReply` dedup — same `dedupKey` twice → one underlying post, second returns recorded id.
- `listComments` source classification — Greptile bot author → `greptile`; operator → `orchestrator`;
  others → `human`/`other`.
- `rebase` routing — `conflict` returns `needs_local_rebase` and performs **no** side-effect; `mergeable` →
  `not_needed`; `need_rebase` → runs `glab mr rebase`.
- **Guard test:** assert no code path constructs a `glab mr merge` command (grep/AST guard).

**Battle-testing against a real test MR** (a throwaway MR in a sandbox GitLab project):
- **Existing MR:** run `open-mr` twice on the same branch → second reuses, no duplicate MR created.
- **Missing MR:** `open-mr` on a fresh branch → creates exactly one; `diff`/`comments` on a non-existent iid
  → clean `MRNotFound`, not a crash.
- **All merge-status values:** manufacture each reachable state on the test MR — behind target (→
  `need_rebase`), behind with a conflicting hunk (→ `conflict`), running pipeline (→ `ci_still_running`),
  unresolved thread (→ `discussions_not_resolved`), draft (→ `draft_status`), clean (→ `mergeable`) — and
  confirm the mapped `action`. Confirm `mergeable` reports **ready_for_human and never merges.**
- **Greptile comments:** open the test MR, let Greptile review, confirm `comments --source greptile` returns
  them and classification is correct.
- **Comment dedup:** post with a `dedupKey`, kill mid-run / re-run → exactly one comment on the MR.
- **Server-side rebase:** put the test MR in `need_rebase` → `rebase` succeeds server-side; put it in
  `conflict` → `rebase` returns `needs_local_rebase` and the MR is **untouched** (no force-push, no checkout).
- **Auth failure:** temporarily break `glab` auth → operations surface a clear re-auth error.

## Exit criteria (done when)
- All eight operations (`openMR`, `getDiff`, `listComments`, `postComment`/`postReply`, `getCIStatus`,
  `getDetailedMergeStatus`, server-side `rebase`) are implemented, typed, and exposed via the CLI.
- `getDetailedMergeStatus` handles **every** value in the table plus an explicit `default => blocked`, with a
  unit test per row + an unknown-value test.
- `openMR` is idempotent (verified twice-on-same-branch reuse) and comment posting is dedup-idempotent.
- `listComments` classifies Greptile vs human reliably on the real test MR.
- `rebase` performs **only** server-side rebase and correctly returns `needs_local_rebase` for `conflict`
  without any local git action.
- **No merge function and no `glab mr merge` invocation exist** (guard test passing).
- The module is usable **standalone by hand** to read comments / post a reply / check merge status on a real
  MR, before any agent or pipeline exists.

## Risks & mitigations
- **GitLab MR comment flow is less mature than GitHub's** (architecture open risk) → test `listComments` /
  reply threading against a real MR first; this is the earliest place to catch it. Use the discussions API
  for ids/threading rather than scraping `mr view` text.
- **`glab` output format drift across versions** → centralized typed JSON parsers that fail loudly
  (`GlabParseError`); pin/record the tested `glab` version in P0; never degrade an unknown status to
  `mergeable`.
- **Accidental merge capability creep** → guard test + code review rule: this module must never construct a
  merge command. `mergeable` maps only to `ready_for_human` (D4/D5).
- **Operator credential reachability** (same-user worktrees, architecture caveat) → out of scope to fix
  here; this module only ever runs as the orchestrator/operator, never inside a worker. Tier-1 sandbox (P8)
  is the technical boundary.
- **Double-posting on retries** → `dedupKey` + posted-comments table; verified by kill-mid-run test.
- **Treating a transient/auth error as "no MR"** → typed error classes distinguish `MRNotFound` from auth /
  network failures so `openMR` never creates a duplicate after a transient list failure.
```