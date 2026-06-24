# Agent Orchestrator — Setup & Prerequisites

Local orchestration layer on top of Claude Code that runs many coding agents over GitLab, driven by
Jira dependencies, with deterministic git side-effects and on-demand rebase babysitting. Full design:
[`agent-orchestrator-architecture.md`](./agent-orchestrator-architecture.md).

This README lists the **prerequisite setup steps** to run the orchestrator. Items marked **(auto)** are
enforced deterministically at runtime; the rest are one-time manual setup.

---

## 1. System dependencies
- **`claude`** CLI (Claude Code) — the worker. Logged in to the enterprise plan (unlimited Opus).
- **`glab`** CLI — authenticated as the operator (personal token they rotate). The orchestrator acts as
  the user via `glab`; workers get no credentials.
- **`git`**, **Node.js** (orchestrator + optional Sandcastle).
- **Tier-1 sandbox (fast-follow phase):** `bubblewrap`, `socat`, and a seccomp filter (Linux; **WSL2**,
  not WSL1). Verify via `/sandbox` → Dependencies tab. Not required for the first build.

## 2. Authentication
| Service | How |
|---|---|
| **Greptile** | Org-managed; runs automatically when an MR is opened. Nothing to configure locally. |
| **Jira** | Via Claude's existing authenticated connection (the operator's Claude is already connected). |
| **GitLab** | The operator's own `glab` auth (personal access token they rotate). |

> Tokens live only where the orchestrator can reach them — never injected into worker sessions.

## 3. Claude Code global configuration (`~/.claude/settings.json`)
- `model`: Opus.
- `cleanupPeriodDays`: **90+** (session transcripts must survive the review→merge lag for `--resume`).
  **Never set `0`** — a known bug disables transcript writing entirely.
- MCP servers: Jira (read), GitLab (read MR comments).
- The **SessionStart ignore hook** (§4) and, for orchestrated repos, the worker **deny-list** (§5).

## 4. Deterministic per-session setup — ignore worktrees + artifacts **(auto)**

`claude --worktree` creates worktrees under **`.claude/worktrees/`** inside the repo, and the agent writes
orchestration artifacts (`GOAL.md`, `decision-log.jsonl`, `rebase-transcript.md`) into the worktree root.
Neither should ever land in a commit/MR diff.

**Mechanism:** a global `SessionStart` hook appends the patterns to the repo's **`.git/info/exclude`** —
the repo-local, *untracked* ignore file. This needs no commit, never modifies a tracked file, and applies
to **any** repo you open with Claude Code (not just orchestrated ones). It is idempotent.

Add to `~/.claude/settings.json`:
```json
{
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
Notes:
- Uses `--git-common-dir` so the exclude applies across all worktrees of the repo (not the per-worktree git dir).
- The `|| true` makes it a no-op outside a git repo.
- **Team-wide alternative:** instead of (or in addition to) the local exclude, add the same patterns to the
  tracked `.gitignore` as a one-time PR so the convention is shared. The hook is the safety net regardless.

## 5. Worker permission deny-list (orchestrated repos)
The worker `.claude/settings.json` denies all state-mutating git/glab (the orchestrator owns those):
```json
{ "permissions": { "deny": [
  "Bash(git commit:*)", "Bash(git push:*)", "Bash(git merge:*)", "Bash(git rebase:*)",
  "Bash(git reset:*)", "Bash(git checkout:*)", "Bash(git restore:*)", "Bash(git clean:*)",
  "Bash(git branch:*)", "Bash(git stash:*)", "Bash(glab:*)", "Bash(rm:*)"
] } }
```
> Defense-in-depth, not a boundary — the real backstops are the orchestrator owning all side-effects and the
> **human-only-merge** rule. Tier-1 sandbox (when added) makes it a technical boundary.

## 6. Per-repo onboarding checklist
1. Register the repo in a context group (`/cg` set).
2. Ignore worktrees + artifacts — **(auto)** via §4; optionally add to tracked `.gitignore`.
3. Define per-repo `verify` / `build` commands + timeouts (used by the verification gate).
4. Ensure the worker deny-list (§5) is present.
5. Confirm `glab` project mapping + Jira issue-type→workflow + component/label→context-group mapping.
6. Confirm Greptile is enabled on the repo.
7. Confirm sandbox policy (D3) for the repo's task types.

## 7. Hard rules (do not violate)
- **Only humans merge.** The orchestrator/agent never runs `glab mr merge`. Pipeline stops at "ready for human".
- **Workers never perform git/glab side-effects.** The orchestrator does, as the operator, deterministically.
