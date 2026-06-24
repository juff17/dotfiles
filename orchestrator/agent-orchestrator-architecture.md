# Agent Orchestrator — Architecture & Decision Doc

> Goal: sit on top of many coding agents as an **orchestrator**, not a developer. Triage work into
> queues, let agents grind through the repetitive implementation + first-pass review in isolation,
> and come back to do final review of an MR + transcript.

## Fixed constraints (decided)

| Constraint | Decision | Consequence |
|---|---|---|
| VCS platform | **GitLab only (for now)** | Side-effects via `glab` CLI from the orchestrator. GitLab MCP used only to *read* MR comments for the agent. |
| Where agents run | **Local, enterprise plan** | Drive Claude Code *headless on this machine*. We do **not** run cloud models ourselves. |
| Cloud reviewer | **Greptile (already set up)** | Reviews the MR asynchronously after push; its comments are pulled and triaged like any other review source. |
| Pre-cloud reviewers | **pr-review-toolkit** (plugin), then **ponytail** | Run locally *before* pushing, as advisory passes the agent triages. |
| Worker | **Claude Code** | Already has MCP, worktrees, hooks, skills, subagents, headless mode. No from-scratch harness. |
| Model | **Opus for every stage** | Enterprise plan = **unlimited Opus**, so model tier is not a constraint (D1 resolved). |
| Merging | **Humans only — hard rule** | The orchestrator/agent NEVER merges; it prepares MRs to *ready* and a human merges (D4/D5). |

## Side-effect boundary — the core principle

**The agent decides; the orchestrator acts.** Git/GitLab side-effects are deterministic and happen
*because the pipeline reached a stage gate*, never because the LLM chose to.

> **HARD RULE — only humans merge.** The orchestrator NEVER merges (never runs `glab mr merge`); agents
> never merge. The pipeline prepares an MR to a *ready* state and notifies a human; **merging is
> exclusively a human action.** Everything below stops at "ready for human".

- **Deliberative (agent):** implement, run reviews, judge feedback validity, write pushback text. Edits
  files only (via Edit/Write).
- **Side-effecting (orchestrator, deterministic 🔒):** *all* state-mutating git + GitLab — `commit`,
  `push`, `rebase`, `glab mr create`, fetch comments, post replies. Runs as the orchestrator's own process.

Worker `.claude/settings.json` deny-list (defense-in-depth, **not** a security boundary):
```json
{ "permissions": { "deny": [
  "Bash(git commit:*)", "Bash(git push:*)", "Bash(git merge:*)", "Bash(git rebase:*)",
  "Bash(git reset:*)", "Bash(git checkout:*)", "Bash(git restore:*)", "Bash(git clean:*)",
  "Bash(git branch:*)", "Bash(git stash:*)", "Bash(glab:*)", "Bash(rm:*)"
] } }
```
> **The deny-list is best-effort, not a boundary.** String-prefix matching is bypassable (`git$IFS commit`,
> `sh -c`, aliases, a git library, writing+running a script). The orchestrator performs every commit/push/MR
> action, and workers are denied `git`/`glab` mutations. **Honest caveat for this setup:** workers run as the
> **same user with bare worktrees** (D3), so the operator's `glab` token in `~/.config/glab` is technically
> reachable by a determined worker — full credential isolation would need sandboxing, which we've deferred
> (trusted enterprise code). So the deny-list + trusted-code is the best-effort guard, and the **human-only
> merge rule is the real backstop** (a worker cannot complete a merge even if it reached `glab`). A
> `PreToolUse` hook adds logging/alerting on attempts.

### The cost / capacity rule
- **Enterprise plan: Opus usage is unlimited** — model tier is *not* a constraint; use Opus everywhere.
- Run the orchestrator and all workers **locally**, invoking the **genuine `claude` CLI** (never proxy the
  plan's OAuth token into a custom API client — that risks account action under Anthropic's usage policy).
- The remaining capacity limits are **per-account API/TPM rate limits + local hardware** (the concurrency
  cap), not a model-hours bucket. The scheduler still backs off on 429/rate-limit signals, but passive
  bulk is no longer gated by an Opus ceiling.

---

## What already exists (adopt, don't build)

| Capability | Mechanism in Claude Code |
|---|---|
| Worktree per task | `claude --worktree` → default **`.claude/worktrees/`** under the repo (configurable). First interactive use needs the trust prompt — headless `-p` skips it. **Must be git-ignored** (see README setup + SessionStart hook). |
| MCP | `.mcp.json`, `/mcp`, local/project/user scopes, OAuth |
| Context groups (repo sets) | the **`/cg` skill** — already does "load a predefined set of repos for this task" |
| Headless worker | `claude -p "…" --output-format stream-json` (event stream for the dashboard) |
| Hooks (wrap behavior) | PreToolUse / PostToolUse / Stop / SessionStart / Compaction / WorktreeCreate |
| Subagents / skills | `.claude/agents/*.md`, skills as selectable workflow steps |
| Diff review | VSCode Source Control + **GitLens**; desktop app diff view |
| AFK orchestration (optional) | **Sandcastle** (`sandcastle.run()`): branch strategy, planner → implementers → reviewer. **Sandbox + auto-merge NOT used** — we run bare worktrees (D3) and **humans merge** (hard rule). |
| OS-level sandbox (Tier 1) | **Claude Code sandbox** / `@anthropic-ai/sandbox-runtime` — Linux bubblewrap + socat + seccomp; per-process filesystem + network isolation, **no container** |

> Note: subagent `isolation: worktree` frontmatter exists but is **undocumented** (may change without
> notice). We rely on top-level `--worktree` per worker as the primary, stable primitive.

## What you must build (the thin custom layer)

1. **Dependency-aware queue (DAG scheduler)** — the core value. `dependsOn` is **derived from Jira
   links** (see *Jira-driven dependency graph*); scheduler only dispatches when deps are **merged**;
   enforces a concurrency cap; **cycle-detects** (topological sort) and flags.
2. **Branch-stacking strategy** — when X blocks Y (same repo): Y's worktree branches **off X's branch**;
   on X merge, **rebase** Y. Cross-repo block = ordering only (branch off `main`).
3. **GitLab side-effect module** — orchestrator wrapper over `glab`: open MR, post/reply comments,
   get diff, get CI status, rebase. (GitLab MCP used only for the agent to *read* comments.)
4. **Comment-driven loop (local poller)** — poll GitLab for new Greptile/human comments on open MRs →
   enqueue an "address comments" task → agent triages, orchestrator pushes replies + commits.
5. **Workflow templates + selector** — pluggable pipelines you pick per task set (not forced):
   `ticket-impl`, `trd-review`, `doc-gen`. Each = an ordered list of stages (agent runs / skills).
6. **Monitoring dashboard** — the genuine gap in Claude Code's TUI for *passive* multi-agent work.
   Local web UI (or TUI) reading orchestrator state + each worker's `stream-json` events.
7. **Jira sync module** — orchestrator polls Jira REST API (`fields.issuelinks`) to build the DAG,
   resolve branch-stacking targets, and (optionally) derive workflow template + context group from
   issue type/component/labels. Deterministic orchestrator logic, not agent-via-MCP.
8. **Reliability layer** — crash-recovery reconciliation, idempotent gates, retry/timeout policy,
   runaway-worker detection, circuit breakers, worktree GC. See *Reliability & recovery*.
9. **Safety layer** — Tier-1 native sandbox profile (FS + network), credential isolation,
   untrusted-input handling, conflict re-review gating, global kill-switch. See *Safety & trust* + *Sandboxing*.

---

## Architecture

```
                      ┌──────────────────────────────────────────┐
   you (ticket) ───▶  │  INTAKE (Jira-driven)                     │
                      │  → task: ticket + context + workflow +     │
                      │    context-group + dependsOn (from links)  │
                      └───────────────┬──────────────────────────┘
                                      ▼
                      ┌──────────────────────────────────────────┐
                      │  ORCHESTRATOR CORE (local, long-running)  │
                      │  • queue + DAG scheduler (concurrency cap)│
                      │  • branch-stacking + rebase policy        │
                      │  • workflow-template engine               │
                      │  • reliability (recovery, retry, breakers)│
                      │  • state store + audit log (SQLite)       │◀── dashboard reads this
                      └───────┬───────────────────────┬──────────┘
                              ▼                        ▼
              ┌───────────────────────┐   ┌───────────────────────┐
              │  WORKER (per task)    │   │  WORKER (per task)    │   … capped N
              │  git worktree +       │   │  git worktree +       │
              │  branch (off dep?)    │   │  branch               │
              │  claude -p (Opus)     │   │  claude -p (Opus)     │
              │  NO push credentials  │   │  stream-json events ──┼──▶ dashboard
              └──────────┬────────────┘   └───────────────────────┘
                         ▼
              ┌───────────────────────┐
              │  GITLAB MODULE (glab) │  open MR, comments, rebase, CI status
              └──────────┬────────────┘
                         ▼
                 ┌───────────────┐
   you (review) ◀┤  MR + tx + log │  final human review of diff + decision-log
                 └───────────────┘
                         ▲
              comment-poller (local) ── new comment ──▶ re-enqueue "address comments" (rate-limited)
```

### Task data model (sketch)
```ts
type Task = {
  id: string
  jiraKey: string           // source of truth; task store keyed by this
  repo: string              // branch-stacking only applies within same repo
  type: "ticket" | "trd" | "doc"  // derived from Jira issue type
  workflow: string          // template id -> ordered stages (from issue type)
  contextGroup: string      // -> /cg repo set (from component/labels)
  brief: string             // ticket description + operator-supplied context
  dependsOn: string[]       // = Jira "is blocked by" links (jiraKeys)
  baseBranch: string        // same-repo blocker -> blocker's branch; else main
  worktree?: string
  branch?: string
  sessionId?: string        // for --resume; re-capture after each resume
  mrUrl?: string
  conflictsResolvedByAgent?: boolean   // forces needs-human re-review (D4)
  stage: string             // current stage; persisted for crash-recovery
  workerPid?: number        // for recovery + runaway detection
  status: "queued" | "blocked" | "running" | "review" | "needs-human" | "merged" | "failed" | "stale"
  stages: { name: string; agent?: string; skill?: string; status: string }[]
}
```

### Ticket pipeline (stage machine; 🔒 = deterministic orchestrator gate)

| # | Stage | Who | Output |
|---|---|---|---|
| 0 | Write **GOAL.md** to worktree root (incl. acceptance criteria) | agent | persistent goal, re-read every later stage |
| 1 | Implement until done | agent (Opus) | edited working tree |
| 🔒 | `git add -A && commit -m "feat: <goal>"` (no-op if clean) | orchestrator | checkpoint |
| 2 | **pr-review-toolkit** as subagent → findings → main agent triages (address/skip/pushback) | agent | edits + decision-log entries |
| 🔒 | commit `"address pr-review-toolkit"` | orchestrator | checkpoint |
| 3 | **ponytail**, with GOAL.md injected (don't flag intentional scaffolding) → agent triages | agent | edits + decision-log entries |
| 🔒 | commit `"address ponytail"` | orchestrator | checkpoint |
| 4 | **GOAL-conformance check** — a *fresh* agent (not the implementer) reads GOAL.md + diff, reports unmet criteria | agent | conformance entries in decision-log |
| 🔒 | `git push` + `glab mr create` (reuse existing MR for branch if present) | orchestrator | MR opened → **Greptile** reviews async |
| 5 | Poll MR for **Greptile** comments → agent decides per comment {address / skip / pushback} | agent | edits, reply text, decision-log entries |
| 🔒 | post replies (incl. pushback), commit `"address review comments"`, push | orchestrator | updated MR |
| 6 | Render **decision log** → post to MR + notify human | orchestrator | human reviews diff + log |

**Review-as-advisor:** each reviewer (pr-review-toolkit, ponytail, Greptile, GOAL-conformance) returns
findings; the main agent triages each as `address | skip | pushback` **with a reason**. Only the source differs.

**Each reviewer stage records one of `{findings | clean | error}`:** `clean` (zero findings) → advance
the gate and log it; `error` (crash / timeout / unparseable output) → retry once, then `needs-human`.
An errored reviewer is **never** treated as clean — that would silently skip a quality gate.

**Decision-log integrity:** the **orchestrator**, not the agent, appends the *raw reviewer findings* to
`decision-log.jsonl`; the agent may only **annotate** each with a decision+reason. This stops the agent
from omitting a finding from its own paper trail. The human-facing summary lists every `skip`/`pushback`
as a required read, and lists each GOAL.md acceptance criterion as met/unmet.

**Artifacts in the worktree (all git-ignored — kept on disk for `--resume`/rebase, never committed to the MR):**
- `GOAL.md` — written stage 0, injected into every later stage.
- `decision-log.jsonl` — `{stage, source, finding, decision, reason}`; raw findings written by orchestrator.
- `rebase-transcript.md` — written during conflict babysitting.
- Final summary rendered from the log (posted to the MR, not committed).

> TRD/doc templates reuse the same engine with different stages (e.g. `draft → critique → revise`),
> selected at intake — so the workflow is **opt-in per task set**, never forced on your normal use.

### Rebase babysitting (on-demand, runs days after human review)

Triggered by the operator when an MR is finally ready to merge — usually long after review, so the
target branch has moved and a rebase (often with conflicts) is needed.

**Detection** via `glab mr view <id> -F json` → `detailed_merge_status`:

| `detailed_merge_status` | Action |
|---|---|
| `mergeable` | **report ready — human merges** (orchestrator never merges) |
| `need_rebase` (behind, no conflicts) | `glab mr rebase <id>` — **server-side**, no agent |
| `conflict` (behind, with conflicts) | **local rebase + agent resolution** (below) |
| `ci_still_running` / `ci_must_pass` | wait / report |
| **any other value** (`discussions_not_resolved`, `not_approved`, `draft_status`, `checking`, `preparing`, `blocked_status`, …) | report blocked / wait — **do not** treat absence of the three known values as mergeable |

> `glab mr rebase` cannot resolve conflicts during a server-side rebase and returns an error — which is
> why the `conflict` status routes to a local rebase *before* `glab mr rebase` is ever called.

**Conflict flow** (deterministic gates 🔒; agent only edits conflict *content*):
1. 🔒 disk-space precondition; ensure original worktree on disk → `git fetch` → capture remote tip SHA → `git rebase origin/<target>`
2. 🔒 on stop: list conflicts `git diff --name-only --diff-filter=U`
3. **resume original session** `claude --resume <id>` + inject GOAL.md + decision-log; agent resolves those files, appends to **rebase-transcript**. Re-capture the (new) session ID afterward.
4. 🔒 `git add <resolved>` → `git rebase --continue` (loop per commit)
5. 🔒 run per-repo verification (D-config); on failure → back to agent
6. 🔒 fresh `git fetch`; `git push --force-with-lease=<branch>:<captured-SHA>` (pinned, so a concurrent fetch can't turn it into a blind force-push)
7. 🔒 set `conflictsResolvedByAgent = true` → **route to `needs-human` re-review of the resolution hunks** (⚠ D4); post rebase-transcript to MR; notify operator (force-push re-triggers CI + Greptile)

**Session-continuity requirements (days-later lag — design around these):**
- Transcripts deleted after **30 days** (`cleanupPeriodDays`) by default + reported silent-cleanup bugs
  → raise `cleanupPeriodDays` (90+) **and** back up the transcript at MR creation. **Do not use `0`** — a
  confirmed bug makes `0` *disable transcript writing entirely* rather than "retain forever".
- `--resume` needs the **original directory + working files** → **do not GC the worktree until merged**
  (with a stale backstop — see *Reliability*).
- Days-old sessions may be **compacted** → treat GOAL.md + decision-log as the *durable* source of truth;
  the live session is an optimization. If the session is gone → **fall back** to a fresh session primed
  with GOAL.md + decision-log + diff.
- **Session ID can change on resume** → capture the new ID afterward and update the task→session mapping.

### Concurrency, isolation, dependencies
- **Independent tasks** → parallel, one worktree each, capped at N (start small, e.g. 3–4 passive).
- **Blocked tasks** → scheduler holds them; when the blocker reaches `review`/`merged`, the blocked
  task branches off the blocker's branch. On blocker **merge to main**, rebase dependents and re-run tests.
- **Isolation defers, it does not avoid, same-file conflicts.** Only declared `dependsOn` (Jira) edges are
  stacked; two *undeclared* concurrent MRs editing the same file will both pass review in isolation, then
  the second hits a conflict at merge. ⇒ The orchestrator **detects file-overlap between concurrently open
  MRs in the same repo** and either serializes them or flags the second for `needs-human` rebase rather
  than auto-resolving. The only thing needing a real lock is the orchestrator's **state store** (SQLite).

### Jira-driven dependency graph

Jira is the **source of truth for the DAG**. Jira access uses **Claude's existing authenticated
connection** (the operator's Claude is already connected to Jira). A thin headless `claude -p` call (or the
Jira MCP) fetches `fields.issuelinks` and returns them as JSON; the **orchestrator builds the DAG
deterministically from that JSON** — the *fetch* goes through Claude's auth, the *graph logic* stays
deterministic (not agent-judged). Each issue → `Task` keyed by `jiraKey`.

What it gives, for free:
- **Edges:** "is blocked by" links → `dependsOn`. Direction: for the "Blocks" link type, the issue
  carrying an `inwardIssue` with `type.inward = "is blocked by"` is the *blocked* one — `inwardIssue` vs
  `outwardIssue` is the classic footgun; add a unit test asserting direction.
- **Scheduling:** refuse to dispatch while a blocker is unmerged; auto-release when the blocker's MR merges.
- **Branch-stacking target:** `baseBranch` resolves from the link instead of manual entry.
- **(Bonus) intake:** issue type → workflow template; component/labels → context group.

Correctness guardrails:
1. **Release on *merge*, not Jira status.** Gate on the blocker's MR being merged, never on Jira workflow state.
2. **Branch-stack only within the same repo.** Cross-repo block = ordering dependency only (branch off `main`).
3. **Unmanaged/external blockers** (no agent-owned MR) → release on Jira link clearing or manual override.
4. **Re-poll + reconcile each tick.** New blocker after Y branched off main → flag/pause; removed blocker
   → rebase Y back onto main. **Detect cycles** and flag, never deadlock.

---

## Reliability & recovery

- **Orchestrator crash-recovery:** persist current `stage` + `workerPid` per task in SQLite. On startup,
  reconcile tasks in `running`: check live PIDs and on-disk worktree/commit state, and **resume from the
  last completed gate** (gates are checkpoints, so this is safe).
- **Idempotent gates:** every 🔒 gate is safe to re-run — commit gates no-op on a clean tree;
  `glab mr create` first checks for an existing MR on the branch (`glab mr list --source-branch`) and
  reuses it; comment replies are de-duplicated by tracking posted comment IDs in the state store.
- **Failure/retry policy** (⚠ D8 for thresholds): idempotent `glab`/network calls retried with backoff;
  non-idempotent or repeatedly-failing side-effects → `failed` + notify. A commit that succeeded but whose
  push failed is recoverable because gates are idempotent.
- **Runaway / hung worker detection** (⚠ D8): per-stage wall-clock timeout + a no-progress heuristic
  (no new stream-json events for X min, or a per-stage token-spend cap). On trip → kill → retry-or-`needs-human`.
- **Circuit breakers** (prevent self-amplifying loops): per-MR cap on automated comment-resolution rounds
  (e.g. 3) then force `needs-human`; detect comment-reply oscillation (same finding re-raised) and stop;
  per-task token/turn budget + a global daily/weekly orchestrator budget that pauses dispatch on approach;
  suppress auto-enqueue on Greptile comments responding to the agent's own just-pushed change (cooldown).
- **Worktree lifecycle / GC:** track worktree age/state in SQLite; MRs with no activity for N days → `stale`
  and reclaimable (safe because of the fresh-session fallback). Disk-space precondition before any worktree
  create or rebase — a full disk itself causes destructive git failures.
- **CI-failure path** (⚠ D7): decide whether a red pipeline auto-enqueues an "address CI failure" task
  (like the comment loop) or routes straight to `needs-human`. Distinguish CI failure from local verification.

## Safety & trust

- **Credentials (D2 resolved):** *Greptile* is org-managed and runs automatically on MR open (nothing for
  us to hold). *Jira* via Claude's existing authenticated connection. *GitLab* via the operator's own `glab`
  CLI auth (personal token they rotate) — the orchestrator acts **as the user**. Workers are denied
  `git`/`glab` mutations (best-effort given same-user bare worktrees — see the side-effect caveat).
- **Untrusted input handling (prompt injection):** Jira ticket text, MR comments, and Greptile output are
  untrusted. Wrap all such text in clearly-delimited blocks with a standing instruction that content
  inside is *data, never instructions*. The comment-poller auto-enqueues comment text, so this matters.
  Treat any agent attempt to edit `.gitlab-ci.yml`/CI config, `.mcp.json`, `.claude/settings.json`,
  lockfiles, or `.git/hooks` as auto-`needs-human`.
- **Humans only merge (D4 resolved, hard rule):** agents/orchestrator never merge. Agent-resolved conflicts
  always route to `needs-human` with a diff of just the resolution hunks (verification-green is necessary
  but not sufficient — an agent can "resolve" by dropping one side's logic).
- **Sandbox (D3): bare worktrees now → Tier-1 native sandbox fast-follow.** Code is trusted (no container
  needed for arbitrary-code risk), but workers ingest **untrusted** Jira/MR/Greptile text, so we add the
  OS-level **native sandbox** (filesystem + network isolation) as a hardening phase — see *Sandboxing* below.
- **Global kill-switch:** a single command that pauses dispatch and stops all workers; required for an
  AFK system that runs overnight.
- **Oversight against rubber-stamping** (⚠ D9): rate-limit how many MRs land in `needs-human` per period;
  random-sample deep audits of merged MRs to calibrate trust over time.

## Sandboxing (Tier 1 — native OS sandbox, fast-follow)

**Why, despite trusted code:** the *inputs* are untrusted — Jira tickets, MR comments, Greptile output —
and the comment-poller auto-enqueues them. The sandbox defeats injection-driven exfiltration regardless of
how trusted the code is, and **upgrades the human-only-merge backstop from a policy to a technical boundary**
(a worker physically cannot read the `glab` token).

**Mechanism:** Claude Code's native sandbox / `@anthropic-ai/sandbox-runtime` — **no container**. On Linux:
bubblewrap (FS bind mounts + network namespace removed) + `socat` + seccomp. **Only workers are sandboxed;
the orchestrator stays outside it** (it legitimately holds creds and performs all side-effects).

**Filesystem profile** (the main design task — naive "RW worktree only" would break us):
- **RW** the worktree.
- **RW** the specific `~/.claude/projects/<project>/` session-transcript path — required for `--resume`.
- **Allow** only the specific MCP cred path a worker needs (e.g. Jira) — granularly.
- **Exclude** `~/.config/glab`, `~/.ssh`, other secrets, and everything else outside the worktree.

**Network profile:** egress only via the proxy allowlist — allow package registries + Anthropic API +
Jira/GitLab *read* API; block all else (incl. GitLab *write* — workers don't push anyway). Optional: swap in
mitmproxy for deeper filtering.

**Enforcement:** managed settings refuse to start if the sandbox can't init and forbid retrying commands
outside it, so it can't be silently bypassed.

**Effort & caveats:** ~1–3 days, mostly config + testing the `--resume`/MCP carve-outs; doesn't disturb the
rest of the architecture. Linux requires **WSL2** (bubblewrap needs user+mount namespaces; WSL1 unsupported).
Network allowlist is tuned per repo (registries).

## Observability & audit

- Persist a **per-task structured log** (orchestrator actions + each worker's stream-json) to disk/SQLite,
  independent of the live dashboard and **retained past worktree GC**, so any task is debuggable post-mortem.
- The orchestrator logs **every side-effect as an audit trail**: commit SHAs, pushes, MR/comment IDs, merges.
- **Notifications** (⚠ D6): `needs-human`, `failed`, rebase-ready, and auth-failure events fire a chosen
  channel (Slack/email/desktop) — a passive system the human must poll defeats the AFK model.

## Onboarding a repo / context group (checklist)
1. Register repo in a context group (`/cg` set).
2. **Ignore Claude worktrees + orchestration artifacts** (`.claude/worktrees/`, `GOAL.md`,
   `decision-log.jsonl`, `rebase-transcript.md`). Handled automatically per-session by the SessionStart
   hook writing to `.git/info/exclude` (idempotent); optionally add to the tracked `.gitignore` for the
   team. See **README → Deterministic per-session setup**.
3. Define per-repo `verify` / `build` commands + timeouts (consumed by the verification gate).
4. Ensure worker `.claude/settings.json` deny-list is present.
5. Confirm `glab` project mapping + Jira project/issue-type → workflow + component/label → context-group mapping.
6. Confirm Greptile is enabled on the repo.
7. Confirm sandbox policy (D3) for the repo's task types.

> The ignore step is a **deterministic prerequisite**, not workflow-specific — the SessionStart hook makes
> it apply to *any* repo you open with Claude Code, so worktrees/artifacts never leak into a diff anywhere.

---

## Build vs adopt summary

| Layer | Decision |
|---|---|
| Worker / loop / tools / MCP / worktrees | **Adopt** Claude Code (headless, Max) |
| Per-run branch strategy + planner/reviewer (no sandbox, no auto-merge) | **Adopt selectively** Sandcastle |
| Context groups | **Adopt** existing `/cg` skill |
| DAG scheduler + branch-stacking + rebase | **Build** (small, ~the core value) |
| GitLab side-effect module (`glab`) | **Build** |
| Comment-driven local poller | **Build** |
| Workflow-template engine + selector | **Build** (thin) |
| Reliability + safety layers | **Build** |
| Monitoring dashboard | **Build** (the real UX gap) |

## Phased roadmap

Built in small, independently testable increments — each usable (manually triggered or script-run) before
the next exists. **Hard principle: ONE pipeline must be fully working and battle-tested before we add any
concurrency, scheduling, or UI.** Detailed per-phase docs live alongside this file (see [`README.md`](./README.md)).

**Stage A — one task, end-to-end, manually triggered** (prove the pipeline)
| Phase | Delivers | Doc |
|---|---|---|
| **P0** | Foundations & prerequisites (env, auth, global config, ignore hook, deny-list) | `docs/phase-0-foundations.md` |
| **P1** | GitLab module — `glab` wrapper (MR ops, read/post comments, `detailed_merge_status`); standalone-useful | `docs/phase-1-gitlab-module.md` |
| **P2** | Single-task pipeline: implement → MR (worker + worktree + artifacts + deterministic commit/push/MR; no reviews) | `docs/phase-2-single-task-pipeline.md` |
| **P3** | Review pipeline (pr-review-toolkit → ponytail → GOAL-conformance → Greptile triage → decision-log → ready-for-human) | `docs/phase-3-review-pipeline.md` |
| **P4** | Rebase babysitting (on-demand, session-resume conflict flow → ready-to-merge) | `docs/phase-4-rebase-babysitting.md` |
| **P5** | Workflow templates (generalise to ticket / TRD / doc; selectable) | `docs/phase-5-workflow-templates.md` |

**Stage B — many tasks, with dependencies** (add automation)
| Phase | Delivers | Doc |
|---|---|---|
| **P6** | Jira sync & dependency graph (issuelinks → DAG; derive template/context-group/branch-target) | `docs/phase-6-jira-dependency-graph.md` |
| **P7** | Scheduler, concurrency & branch-stacking (queue, cap, dispatch-on-merged, stacking, file-overlap) | `docs/phase-7-scheduler-concurrency.md` |

**Stage C — manage at scale** (hardening + UX)
| Phase | Delivers | Doc |
|---|---|---|
| **P8** | Reliability & safety hardening (crash-recovery, idempotency, retry/timeout, circuit breakers, GC, kill-switch, Tier-1 sandbox) | `docs/phase-8-reliability-safety.md` |
| **P9** | Dashboard, notifications & audit (manage-many UI, notifications, audit log) | `docs/phase-9-dashboard-notifications.md` |

> Stage A is fully usable by hand (a `run`/`rebase` script per task). Stage B adds running *many*; Stage C
> adds *managing* many. Sandcastle is optional within Stage B (branch strategy only — no sandbox, no auto-merge).

## Open risks
- **GitLab MR comment flow is less mature** than GitHub's — test the poller early.
- **Same-user bare worktrees** make credential isolation best-effort — the human-only-merge rule is the real backstop.
- **API/TPM rate limits + local hardware** are the capacity limits now (not model-hours).

## Decisions
| # | Decision | Status |
|---|---|---|
| **D1** | Model tier | ✅ **Opus everywhere** — enterprise plan has unlimited Opus |
| **D2** | Credentials | ✅ Greptile org-auto; Jira via Claude's auth; GitLab via operator's `glab` token; workers denied |
| **D3** | Sandbox | ✅ **Bare worktrees now → Tier-1 native sandbox fast-follow** (FS + network isolation; see *Sandboxing*) |
| **D4** | Conflict / merge | ✅ **Humans only merge (hard rule)**; agent-resolved conflicts → `needs-human` |
| **D5** | Approval / merge signal | ✅ Human merges in GitLab UI; the **merge event releases dependents** |
| **D6** | Notification channel | ⬜ open — default: Slack (or desktop) for `needs-human`/`failed`/rebase-ready |
| **D7** | CI-failure path | ⬜ open — default: auto-enqueue "fix CI" task, cap rounds, then `needs-human` |
| **D8** | Retry/timeout/runaway thresholds + budgets | ⬜ open — default: per-stage timeout + token cap; 3 retries w/ backoff |
| **D9** | Oversight: `needs-human` rate-limit + sample audits | ⬜ open — default: cap `needs-human`/day; random-sample merged-MR audits |
