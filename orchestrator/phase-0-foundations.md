# Phase 0 — Foundations & Prerequisites
> Get the environment and global config ready so a worker and the orchestrator can run — no orchestration logic yet.

## Value & rationale
Every later phase assumes a working `claude` CLI, an authenticated `glab`, a global `~/.claude/settings.json`
that pins Opus and survives the review→merge lag, a deterministic ignore mechanism so worktrees/artifacts
never leak into a diff, and a worker deny-list so workers cannot perform git/glab side-effects. None of that
is orchestration logic — it is the substrate. Getting it wrong here surfaces as silent, hard-to-debug
failures much later (a worktree committed into an MR, a transcript silently deleted before a days-later
`--resume`, a worker that quietly pushed). This phase makes those failure modes impossible-by-default before
any pipeline code exists, and it is the one phase that is **pure setup** — manual + a couple of validation
commands, no TypeScript to write.

The two foundational principles this phase encodes (derived from the architecture doc's *Side-effect
boundary* section):
- **The agent decides; the orchestrator acts** — all state-mutating git/glab is the orchestrator's job;
  workers are denied it (§5 deny-list).
- **Only humans merge** — a hard rule that this phase cannot enforce by code (it is a runtime gate) but
  whose first defensive layer (the deny-list) is installed here.

## Dependencies (Depends on / Enables)
- **Depends on:** nothing. This is the root of the roadmap.
- **Enables:** **all** later phases. P1 (GitLab module) needs an authed `glab`; P2 (single-task pipeline)
  needs the worker `claude` + worktree ignore + deny-list; P3 needs the MCP read servers (Jira/GitLab) and
  the raised `cleanupPeriodDays`; P4 (rebase babysitting) depends critically on `cleanupPeriodDays` ≥ 90 so
  the session transcript survives for `--resume`; P8 (sandbox) builds on the deny-list to turn it from
  best-effort into a technical boundary.

## In scope
- **System dependencies:** `claude` CLI logged into the enterprise plan (unlimited Opus); `glab` CLI
  authenticated as the operator; `git`; Node.js. (Sandbox deps `bubblewrap`/`socat`/seccomp are noted but
  NOT installed here — that is P8.)
- **Auth model:** Greptile (org-auto, nothing local); Jira (Claude's existing authenticated connection);
  GitLab (operator's own `glab` token).
- **Global `~/.claude/settings.json`:** `model = Opus`; `cleanupPeriodDays` ≥ 90 (never `0`); MCP servers
  for Jira (read) and GitLab (read MR comments).
- **SessionStart ignore hook** writing patterns to `.git/info/exclude` (the exact hook from README §4).
- **Worker permission deny-list template** (README §5 / architecture *Side-effect boundary*).
- **Per-repo onboarding checklist** (README §6).
- **Validation steps** proving `claude -p`, `glab`, and the ignore hook all work in isolation.

## Out of scope (deferred to …)
- Any **orchestrator code** / state store / scheduler — deferred to P2+ (orchestrator core appears from P2).
- **GitLab side-effect module** (`glab` wrapper: MR ops, comments, `detailed_merge_status`) — **P1**.
- **Pipeline / stage machine** (implement → commit → MR, reviews, decision-log) — **P2 / P3**.
- **Rebase babysitting** and session-resume flow — **P4** (this phase only ensures transcripts survive).
- **Jira sync / DAG** — **P6** (this phase only confirms Jira auth exists).
- **Tier-1 native sandbox** (bubblewrap + network allowlist; turns deny-list into a real boundary) — **P8**.
- The `PreToolUse` logging/alerting hook on deny-list attempts — that is reliability/safety hardening (**P8**).

## Design (config files, exact settings, the hook, deny-list; how each maps to architecture/README sections)

### 0.1 System dependencies (maps to README §1)
| Dependency | Purpose | Notes |
|---|---|---|
| `claude` (Claude Code) | the worker; runs headless `claude -p` / `--resume` | logged into enterprise plan = **unlimited Opus** (D1). |
| `glab` | orchestrator's GitLab side-effects, acting **as the operator** | authed with the operator's personal token (D2). Workers get **no** glab creds. |
| `git` | worktrees, commits, rebases | the orchestrator performs all mutations; workers are denied them. |
| Node.js | orchestrator runtime (TS/Node) + optional Sandcastle | nothing to build this phase, but the runtime must be present. |
| bubblewrap / socat / seccomp | **Tier-1 sandbox** — **NOT this phase** | listed only so the box is ready for P8; Linux requires **WSL2**, not WSL1. |

### 0.2 Auth model (maps to README §2, architecture *Safety & trust* / D2)
- **Greptile:** org-managed; runs automatically when an MR is opened. **Nothing to configure locally.**
- **Jira:** via **Claude's existing authenticated connection** (the operator's Claude is already connected).
  No separate Jira token held by the orchestrator.
- **GitLab:** the operator's own `glab` auth (personal access token they rotate). The orchestrator acts
  **as the user** through `glab`.
- **Invariant:** tokens live only where the orchestrator can reach them, **never injected into worker
  sessions**. Workers are denied `git`/`glab` mutations (best-effort given same-user bare worktrees — the
  human-only-merge rule is the real backstop until P8's sandbox).

### 0.3 Global `~/.claude/settings.json` (maps to README §3)
The complete global config to install (merge into any existing file; do not clobber unrelated keys):

```json
{
  "model": "opus",
  "cleanupPeriodDays": 90,
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear",
        "hooks": [
          {
            "type": "command",
            "command": "git rev-parse --git-common-dir >/dev/null 2>&1 && { ex=\"$(git rev-parse --git-common-dir)/info/exclude\"; for p in '.claude/worktrees/' 'GOAL.md' 'decision-log.jsonl' 'rebase-transcript.md'; do grep -qxF \"$p\" \"$ex\" 2>/dev/null || echo \"$p\" >> \"$ex\"; done; } || true"
          }
        ]
      }
    ]
  }
}
```

MCP servers are configured separately (see 0.4) — keep them in the appropriate scope rather than inlining
secrets into the global settings.

Key-by-key rationale:
- **`model: opus`** — Opus for every stage; the enterprise plan makes model tier a non-constraint (D1).
- **`cleanupPeriodDays: 90`** — session transcripts MUST survive the review→merge lag so P4's `--resume`
  works days later. Default is 30 days (plus reported silent-cleanup bugs), which is too short.
  **Never set `0`** — a confirmed bug makes `0` *disable transcript writing entirely* rather than "retain
  forever". 90 is the floor; raise further if the team's typical merge lag is longer.
- **SessionStart hook** — see 0.5.

### 0.4 MCP servers — Jira (read) + GitLab (read MR comments) (maps to README §3, architecture *Jira-driven dependency graph* + *GitLab side-effect module*)
- **Scope of these MCP servers is strictly READ:**
  - **Jira MCP** — lets the agent *read* ticket data / issue links. (The orchestrator's DAG logic is
    deterministic and reads `fields.issuelinks` via Claude's auth — that is P6; here we only register the
    server.)
  - **GitLab MCP** — used **only** for the agent to *read* MR comments. **All GitLab writes go through
    `glab`** in the orchestrator (P1), never through this MCP. This separation is the *agent decides /
    orchestrator acts* boundary expressed at the tooling level.
- Register them in `.mcp.json` (project/user scope as appropriate). Do not grant the GitLab MCP any
  write capability — read MR comments only.

### 0.5 SessionStart ignore hook (maps to README §4 — "Deterministic per-session setup")
`claude --worktree` creates worktrees under **`.claude/worktrees/`** inside the repo, and the agent writes
orchestration artifacts (`GOAL.md`, `decision-log.jsonl`, `rebase-transcript.md`) into the worktree root.
**Neither should ever land in a commit/MR diff.**

Mechanism: a global `SessionStart` hook appends the four patterns to the repo's **`.git/info/exclude`** —
the repo-local, *untracked* ignore file. This needs no commit, never modifies a tracked file, applies to
**any** repo opened with Claude Code (not just orchestrated ones), and is **idempotent** (`grep -qxF`
guards each append).

Properties that matter:
- Uses **`--git-common-dir`** so the exclude applies across all worktrees of the repo (not the per-worktree
  git dir) — essential because each worker runs in its own worktree.
- The trailing **`|| true`** makes it a safe no-op outside a git repo (so opening Claude in a non-git dir
  does not error).
- **Team-wide alternative:** add the same four patterns to the tracked `.gitignore` as a one-time PR so the
  convention is shared. The hook is the safety net regardless.

(Exact hook JSON is in 0.3 above — it is the verbatim hook from README §4.)

### 0.6 Worker permission deny-list template (maps to README §5, architecture *Side-effect boundary*)
For **orchestrated repos**, the worker `.claude/settings.json` denies all state-mutating git/glab so the
orchestrator owns every side-effect:

```json
{ "permissions": { "deny": [
  "Bash(git commit:*)", "Bash(git push:*)", "Bash(git merge:*)", "Bash(git rebase:*)",
  "Bash(git reset:*)", "Bash(git checkout:*)", "Bash(git restore:*)", "Bash(git clean:*)",
  "Bash(git branch:*)", "Bash(git stash:*)", "Bash(glab:*)", "Bash(rm:*)"
] } }
```

> **Best-effort, not a boundary.** String-prefix matching is bypassable (`git$IFS commit`, `sh -c`,
> aliases, a git library, writing+running a script). The real backstops are (a) the orchestrator performing
> every commit/push/MR action and (b) the **human-only-merge** hard rule — a worker cannot complete a merge
> even if it reached `glab`. The Tier-1 sandbox (P8) upgrades this to a technical boundary. The
> `PreToolUse` logging/alerting hook on attempts is **P8**, not here.

### 0.7 Per-repo onboarding checklist (maps to README §6 / architecture *Onboarding a repo*)
Items below are the full checklist; **only steps 1, 2, and 4 are actionable in Phase 0** — the rest depend
on modules built in later phases and are listed so the checklist is complete and ready to use as repos come
online.

1. Register the repo in a context group (`/cg` set). *(actionable now)*
2. Ignore worktrees + artifacts — **(auto)** via the SessionStart hook (0.5); optionally also add the four
   patterns to the tracked `.gitignore`. *(actionable now — verify the hook fires; see validation)*
3. Define per-repo `verify` / `build` commands + timeouts (consumed by the verification gate). *(consumed P3/P4)*
4. Ensure the worker deny-list (0.6) is present in the repo's `.claude/settings.json`. *(actionable now)*
5. Confirm `glab` project mapping + Jira issue-type→workflow + component/label→context-group mapping. *(P1/P5/P6)*
6. Confirm Greptile is enabled on the repo. *(consumed P3)*
7. Confirm sandbox policy (D3) for the repo's task types. *(P8)*

## Implementation steps (ordered, concrete)
1. **Install / verify system deps.** Confirm `claude`, `glab`, `git`, and `node` are on `PATH`
   (`command -v` each). On Linux for the future sandbox, confirm you are on **WSL2** if applicable (record
   it; do not install bubblewrap yet).
2. **Confirm `claude` is logged into the enterprise plan.** Run `claude` once interactively (or check the
   account) to confirm Opus access / unlimited usage.
3. **Authenticate `glab` as the operator.** `glab auth login` with the operator's personal access token;
   confirm with `glab auth status`. Do **not** put this token anywhere a worker session can read it.
4. **Confirm Jira via Claude's connection.** Verify the operator's Claude already has Jira connected (no
   separate token to install). Confirm Greptile is org-managed (nothing local to do).
5. **Write `~/.claude/settings.json`.** Merge in `model: opus`, `cleanupPeriodDays: 90`, and the verbatim
   SessionStart hook from 0.3. Validate the JSON parses (`node -e 'JSON.parse(require("fs").readFileSync(...))'`
   or `jq . <file>`).
6. **Register the read-only MCP servers** (Jira read; GitLab read-MR-comments) in `.mcp.json` at the
   appropriate scope. Do not grant GitLab MCP write scope.
7. **Create the worker deny-list template** — keep a canonical copy (0.6) to drop into each orchestrated
   repo's `.claude/settings.json` during onboarding.
8. **Run the validation suite** (next section) to prove `claude -p`, `glab`, and the ignore hook each work.
9. **Record the onboarding checklist** (0.7) somewhere the team uses when bringing a repo online.

## How to run it (manual / script) — exact validation commands
All commands assume a normal shell; nothing here is orchestrator code.

**A. System deps present**
```sh
command -v claude && command -v glab && command -v git && command -v node
node --version
```

**B. `claude -p` works headless (and Opus is in effect)**
```sh
claude -p "Reply with exactly: PONG"
# Expect: PONG (proves headless invocation + auth, no interactive trust prompt).
```

**C. Global settings parse and contain the right values**
```sh
jq '.model, .cleanupPeriodDays' ~/.claude/settings.json
# Expect: "opus"  and  a number >= 90 (and never 0).
jq '.hooks.SessionStart' ~/.claude/settings.json   # confirm the hook is present
```

**D. `glab` authed as operator**
```sh
glab auth status
# Expect: logged in to the GitLab host as the operator, token valid.
```

**E. MCP read servers registered**
```sh
claude mcp list        # or /mcp inside an interactive session
# Expect: Jira and GitLab servers listed (read scope).
```

**F. The SessionStart ignore hook fires (the key proof)**
```sh
cd /path/to/some/git/repo
# Start a headless session to trigger SessionStart, then inspect the exclude file:
claude -p "Reply with exactly: OK"
cat "$(git rev-parse --git-common-dir)/info/exclude"
# Expect to see all four lines:
#   .claude/worktrees/
#   GOAL.md
#   decision-log.jsonl
#   rebase-transcript.md
```

**G. Idempotency of the hook**
```sh
# Run the session/hook a second time, then confirm no duplicate lines:
claude -p "Reply with exactly: OK"
grep -c '^GOAL.md$' "$(git rev-parse --git-common-dir)/info/exclude"
# Expect: 1 (exactly one occurrence — grep -qxF guard prevents dupes).
```

**H. Worktree + artifacts are actually ignored**
```sh
mkdir -p .claude/worktrees && touch .claude/worktrees/.probe GOAL.md decision-log.jsonl rebase-transcript.md
git status --porcelain
# Expect: NONE of those paths appear as untracked (they are excluded).
rm -f GOAL.md decision-log.jsonl rebase-transcript.md .claude/worktrees/.probe   # cleanup probes
```

## Testing & battle-testing (prove each prereq works in isolation; edge cases)
- **`claude -p` in isolation** — validation B; proves headless + Opus + no trust prompt. Re-run in a fresh
  repo to confirm the worktree trust prompt does not block `-p`.
- **`glab` in isolation** — validation D, plus a read-only call (e.g. `glab api user` / `glab repo view`) to
  confirm the token actually authorizes. Do **not** test any write here (writes are P1).
- **Ignore hook in isolation** — validations F/G/H. Battle-test:
  - **Non-git directory:** run `claude -p` in a dir that is not a git repo; the `|| true` must make it a
    no-op (no error, no file written). Confirm no `info/exclude` is created anywhere.
  - **Worktree (not main checkout):** open Claude inside a `git worktree`; because the hook uses
    `--git-common-dir`, the exclude must land in the **shared** common dir so it applies to all worktrees.
  - **Idempotency under repeated sessions:** run several sessions; each pattern stays single (validation G).
  - **Pre-existing exclude content:** seed `info/exclude` with unrelated entries first; the hook must
    **append**, never overwrite them.
  - **Patterns already present** (e.g. team added them to `.gitignore`): hook still no-ops cleanly.
- **`cleanupPeriodDays` correctness** — assert the value is a number ≥ 90 and is **not** `0` (validation C);
  document why (P4 `--resume` lag + the `0`-disables-writing bug).
- **MCP read-only posture** — confirm the GitLab MCP cannot write (it is registered read-only); all writes
  must route through `glab` later. This is a config assertion, not a runtime test in this phase.
- **WSL2 edge case** — if on Windows, confirm WSL2 (not WSL1): record kernel/namespace support now so P8's
  bubblewrap-based sandbox is not blocked later. WSL1 is unsupported for the sandbox.
- **Deny-list smoke (advisory)** — in a repo carrying the deny-list, confirm a worker `Bash(git commit …)`
  is denied. Caveat openly: this is best-effort (prefix matching bypassable); it is **not** a security test,
  and the human-only-merge rule + P8 sandbox are the real boundaries.

## Exit criteria (done when)
- [ ] `claude`, `glab`, `git`, `node` all resolve on `PATH`; `claude` is logged into the enterprise plan
      (Opus available).
- [ ] `glab auth status` shows the operator authenticated; a read-only `glab` call succeeds.
- [ ] Jira confirmed reachable via Claude's existing connection; Greptile confirmed org-managed (no local
      config).
- [ ] `~/.claude/settings.json` parses and has `model: opus`, `cleanupPeriodDays` ≥ 90 (never `0`), and the
      verbatim SessionStart hook.
- [ ] Jira (read) and GitLab (read-MR-comments) MCP servers are registered with read scope only.
- [ ] `claude -p "…"` returns output headlessly without a trust prompt.
- [ ] Opening Claude in a git repo writes all four ignore patterns to `.git/info/exclude`; re-running does
      not duplicate them; the worktree dir + the three artifacts show as ignored in `git status`.
- [ ] Opening Claude in a **non-git** directory is a clean no-op (no error, no file written).
- [ ] The worker deny-list template exists and is documented for per-repo onboarding.
- [ ] The per-repo onboarding checklist is recorded and ready to apply.

## Risks & mitigations
| Risk | Mitigation |
|---|---|
| `cleanupPeriodDays` left at default (30) or set to `0` → transcripts vanish before P4 `--resume`, or writing is disabled entirely. | Pin to **90+** in global settings; validation C asserts a number ≥ 90 and never `0`; back up the transcript at MR creation (P3/P4) as a second layer. |
| Worker session can reach the operator's `glab` token (same user, bare worktrees — D3). | Deny-list (best-effort) + **human-only-merge** backstop now; **Tier-1 sandbox (P8)** turns it into a technical boundary later. Never inject the token into worker sessions. |
| Ignore hook fails silently / writes nothing (e.g. permissions, non-git dir). | `|| true` keeps it safe outside git; validation F/G/H prove it actually fires and is idempotent; team `.gitignore` PR is the optional belt-and-suspenders. |
| GitLab MCP accidentally granted write scope → bypasses the *orchestrator-acts* boundary. | Register read-only; all writes go through `glab` (P1). Assert scope during onboarding. |
| Proxying the plan's OAuth token into a custom API client (against usage policy). | Always invoke the genuine `claude` CLI; never proxy the token. |
| On Windows, WSL1 used → P8 sandbox cannot run. | Confirm/record WSL2 now; flag if WSL1 so it is fixed before P8. |
| Deny-list mistaken for a security boundary. | Document explicitly as defense-in-depth; the real boundaries are orchestrator-owned side-effects, human-only-merge, and the P8 sandbox. |
