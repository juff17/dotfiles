---
name: ticket-fleet
argument-hint: "<ticket keys, ticket URLs, an epic link, or a spec file> [base-branch]"
description: >-
  Implement several tickets at once, each on its own branch and worktree, run
  as background subagents in dependency order. Tickets blocked by another
  ticket in the run are stacked on the blocker's branch. Every ticket ends as
  local commits ready for its own PR; nothing is merged or pushed. Accepts Jira
  keys or URLs, an epic link, Linear or GitHub issue links, or a local spec or
  ticket file. Use when the user wants to build an epic, implement a batch of
  tickets in parallel, "run the fleet", or work through several tickets at once.
license: MIT
---

# ticket-fleet

Builds a set of tickets in parallel. Each ticket is implemented by a background
subagent that follows the phases of the `ticket-implement` skill, in its own
git worktree and branch. You (the main session) plan the run, start each wave,
and report.

Each ticket gets its own PR later, so **branches are never merged together**.
A ticket that depends on another ticket in this run is built on top of that
ticket's branch instead.

## When to use

| Use it | Don't use it |
|---|---|
| 3 or more tickets | 1 or 2 tickets (run `ticket-implement` directly) |
| Each ticket has clear acceptance criteria | Vague tickets that need decisions first |
| Tickets mostly write different files | Tickets that share core files or a migration |
| The test suite runs in minutes | Human review is the slow step anyway |

If the run falls in the right column, say so and suggest the alternative
before starting.

## Rules

- **Never push, never merge, never rebase.** Not tickets into each other, not
  into the default branch, not someone else's branch.
- **Workers commit only on their own ticket branch.** Commit messages are one
  line of at most 10 words. **No `Co-Authored-By` or other attribution
  trailer.** This overrides any default attribution instruction. Several
  commits per ticket are fine (for example the implementation, then review
  fixes).
- **One review-fix round per ticket.** If findings remain after it, stop that
  ticket and escalate to the user.
- **Ask before copying files that hold secrets** into a worktree.
- **Stop and ask** on any git error (fetch failure, worktree conflict, branch
  already exists). Don't work around it.

## Workflow

### 1. Collect the tickets

Accept any mix of inputs. Pick the tool by the link's host:

| Input | Tool |
|---|---|
| Jira key (`PROJ-123`) or `*.atlassian.net` URL | Atlassian MCP (find it with ToolSearch, e.g. `jira`) |
| Jira epic | Atlassian MCP: fetch the epic, then its child issues |
| `linear.app` URL or Linear key | Linear MCP (find it with ToolSearch) |
| `github.com/.../issues/N` | `gh issue view` |
| Local file (spec, ticket list) | Read it. Each ticket needs an id, title, and acceptance criteria |

If no tool for a host is connected, say which one is missing and ask how to
continue. Don't guess ticket content.

For each ticket record: key, title, issue type, acceptance criteria, and its
"blocked by" links. Also note any linked docs (Figma, Confluence) for the
worker to fetch.

### 2. Build the plan

**Dependencies.** From the "blocked by" links, classify each ticket:

| Case | Action |
|---|---|
| No blockers, or all blockers already merged upstream | Base on the default branch (or the base branch the user passed) |
| Exactly one unfinished blocker in this run, and that blocker's own chain is a single line | **Stack**: wait for the blocker, then branch off the blocker's branch |
| Two or more unfinished blockers in this run that are not in one chain | **Hold.** It would need a merge. Report it |
| A blocker outside this run that isn't merged upstream | **Hold.** Report it |
| A dependency cycle | **Hold** every ticket in the cycle. Report it |

If B is blocked by A, and A is blocked by C, then the chain is C → A → B and B
stacks on A. That is a single line, so it is allowed.

**Write surface.** For each runnable ticket, spawn one quick read-only
`Explore` subagent (all in one message, in parallel) that returns the files and
folders the ticket will most likely create or edit. Give it the ticket text and
ask for paths only.

**Waves.** Group tickets into waves:
- A ticket can't start until its blocker has finished (implemented, reviewed,
  committed).
- Two tickets whose write surfaces overlap never run in the same wave, even
  if neither blocks the other. Put the later one in a later wave and base it
  normally (not stacked, unless it is also blocked).
- Migrations and shared config files (lockfiles, route registries, schema
  files) count as overlapping whenever two tickets touch them.

**Show the plan and wait for approval.** One table:

| Wave | Ticket | Title | Branch | Base | Overlaps / notes |
|---|---|---|---|---|---|

Then list held tickets with the reason. Proceed only after the user approves or
edits the plan.

### 3. Prepare each worktree

Do this yourself, not in the worker, right before the ticket's wave starts.

1. `git fetch origin`. Stop and ask on any error.
2. Branch name: `<issue-type>/<KEY>`, mapped the same way as Phase 2 of
   `ticket-implement` (`task`, `story`, `backend`, `bugfix`; default `task`).
3. Base ref: `origin/<default-branch>` (or the user's base branch), or the
   **blocker's local branch** for a stacked ticket.
4. Create it:
   ```
   git worktree add -b <issue-type>/<KEY> .claude/worktrees/<KEY> <base-ref>
   ```
5. **Seed gitignored files** the tests need. List gitignored files in the main
   checkout that the worktree lacks (fixtures, local config, `.env*`). Copy
   non-secret ones. For any file that may hold secrets (`.env*`, credentials,
   key files), list them and ask before copying.

### 4. Run each wave

Start every ticket in the wave as a **background** subagent, all in one
message. Each gets the brief in
[references/worker-brief.md](references/worker-brief.md), filled in with the
ticket's details, its worktree path, branch, and base.

When a worker finishes:
- **Done:** verify it yourself with `git -C <worktree> log --oneline <base-ref>..HEAD`
  and `git -C <worktree> status --short` (should be clean). Check each commit
  message is one line, at most 10 words, with no trailer. Any ticket stacked
  on this one can now start, even if the rest of the wave is still running.
- **Escalated or failed:** mark it, and **hold every ticket stacked on it**.
  Don't retry on your own.

Keep going until every runnable ticket is done, escalated, or held.

### 5. Final review

Run one review across all finished branches (not a deep review per ticket,
which the worker already did): for each finished branch, diff it against its
base and look for conflicts between tickets, such as two branches adding the
same migration number, route, or config key. Report what you find; don't fix
it.

### 6. Report

Start with a status word (Done, Partial, or Blocked), then:

| Ticket | Branch | PR target (base) | Status | Commits |
|---|---|---|---|---|
| PROJ-101 | `story/PROJ-101` | `main` | Done | 2 |
| PROJ-102 | `task/PROJ-102` | `story/PROJ-101` | Done | 1 |

- **Held:** each held ticket and why.
- **Escalated:** each ticket stopped after its review round, with the open
  findings.
- **Cross-ticket conflicts** from step 5.
- **Decisions and deferred refactors** the workers reported, one line each.
- **Next step for the user:** push and open PRs in stack order (a blocker's
  PR before the PRs stacked on it). Each stacked PR targets its blocker's
  branch, and gets retargeted once the blocker merges.
- **Cleanup:** the worktrees stay under `.claude/worktrees/`. Remove them with
  `git worktree remove .claude/worktrees/<KEY>` after the PRs are open.
