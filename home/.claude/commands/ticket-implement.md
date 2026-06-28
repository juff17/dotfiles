---
description: Implement a JIRA ticket end-to-end in an isolated worktree — fetch context (Atlassian + Figma), plan, build with tests, then self-review (pr-review-toolkit → ponytail → comment cleanup) and report.
argument-hint: <TICKET-NUMBER> [base-branch]
---

# ticket-implement

Implement the JIRA ticket end-to-end, then review your own work, then report. Run the
whole pipeline without stopping between phases — only stop to ask the operator when a
rule below explicitly says to.

**Input:** `$ARGUMENTS`
- First token = the JIRA ticket number (e.g. `PROJ-1234`).
- Optional second token = a base branch to build off instead of `main`/`master` (used
  when a blocking ticket isn't merged yet). If absent, base off the latest default branch.

## Non-negotiable rules
- **Never `git push`, `git commit`, `git merge`, or `git add`.** Leave all staging and
  history to the operator. (Don't try to work around it by using similar commands)
- **Confirm before any destructive change** (overwriting a file with `cp`, deleting, etc.).
  `rm` is blocked — do not attempt to bypass it. Copying to a blank file is fine, only copies that over write are bad.
- **Minimal fix, always.** This is an enterprise repo; sweeping changes hit live code for
  every user. Prefer the smallest change that satisfies the ticket. If you spot a worthwhile
  refactor, do **not** do it now — note it and raise it in the final report **after** all
  steps are done.
- **Manage your context window.** Push independent, returnable work into subagents
  (questions that require in depth research, test runs, review validation) so the main thread stays focused. Subagents
  should return only the decision/summary needed — not raw dumps.

## Phase 0 — Understand the system
1. Read `docs/system-overview` (and the notes within) for architecture and design
   principles. These can be stale — check each file's last-modified date against today and
   weight accordingly; trust them most for the established core, less for recent work. Grep for additional information that is related to your work explicitly

## Phase 1 — Gather ticket context
1. Fetch the ticket with the **Atlassian MCP** (find its tools via ToolSearch, e.g.
   `jira` / `atlassian`). Pull the summary, description, acceptance criteria, issue type,
   components, and linked/blocking issues.
2. **Figma links:** if the ticket references Figma, use the **Figma MCP** to extract the
   design details that matter for implementation — layout, spacing, CSS values, colors,
   typography, SVGs/assets, and component structure.
3. **Confluence link** if there are links to confluence documents this is normally a TRD or technical document, use it as supplimentary information. Sometimes there might be openAPI specs or example functions specifically related to this ticket - use those. Otherwise treat it as infomration to understand how this work fits into place in the feature/epic/system we are implementing - we want our current work to fit with the intended system's design. (Note: This could be provided by the operator in addition to the ticket as well)
4. **Slack links:** ignore them entirely.
5. Note the **issue type** — you need it for the branch name in Phase 2.

## Phase 2 — Set up the worktree
Do all implementation in a Claude worktree.

1. Decide the **base ref**:
   - Default: the latest default branch. `git fetch origin`; base off `origin/main` (or
     `origin/master`).
   - If the operator passed a base branch in `$ARGUMENTS`, fetch and base off that instead.
2. Make sure the base is current (`git fetch origin`, and `git pull` if you're on it).
   **If the fetch/pull hits any problem (conflicts, auth, detached state, network), STOP and
   notify the operator** — do not improvise around it.
3. Derive the **branch name** as `<jira-issue-type>/<TICKET-NUMBER>`. Lowercase the issue
   type; map common types to: `task`, `story`, `backend`, `bugfix` (e.g. Bug/Defect →
   `bugfix`). If the type is ambiguous, default to `task` and say so in the final report.
4. Create the worktree (name = the ticket number) and branch off the chosen base:
   ```
   git worktree add -b <issue-type>/<TICKET> .claude/worktrees/<TICKET> <base-ref>
   ```
   Then switch the session into it with **EnterWorktree** (`path: .claude/worktrees/<TICKET>`).
   All subsequent work happens inside that worktree.

## Phase 3 — Explore before building
1. Search the codebase for the patterns you'll need to match: coding style, naming, and
   **where enums/types live** (inline in the file, a separate file, or a hybrid) — follow the
   local convention, don't impose a new one.
2. Look for existing code you can **reuse or lightly abstract** before writing anything new.
   Bias toward reuse and the minimal footprint.

## Phase 4 — Plan
1. Write a `/plan` for the implementation.
2. **Before finalizing, get a second opinion:** spawn a subagent with the ticket context and
   your proposed approach. Prompt it to think hard about the *best* approach and challenge
   yours. If it lacks the context to make a call, it must say so and defer the question to
   the operator rather than guessing.
3. **Auto-approve and proceed** unless there are genuine open questions only the operator can
   answer — in which case ask them (concisely) and wait. Use AskQuestion.
4. If the work appears to need **large, out-of-ticket-scope changes**: first re-think the
   approach to find a contained path. If there genuinely isn't one, **stop and notify the
   operator** — this often means a blocking ticket is missing or must land first.

## Phase 5 — Implement
1. Build the minimal change that satisfies the ticket, following the conventions from Phase 3.
2. **Run unit tests after the initial implementation.** Run tests in a **subagent** and have
   it return only what's needed to fix failures (failing test names, messages, root cause) —
   not the full log. Fix and re-run until green before moving on.

## Phase 6 — Review (do not skip; run in order)

### 6a. pr-review-toolkit
1. Run `/pr-review-toolkit:review-pr`.
2. Spawn **one subagent** to evaluate **all Critical and Important** findings and decide
   which are genuinely valid — this surfacer produces false positives, and the point is to
   filter them out. The subagent returns the validated, actionable subset. Place a higher weight on Critical over important.
3. Apply the **valid** feedback. Then **run the tests again** (in a subagent, as above).

### 6b. ponytail
1. Run `/ponytail-review` on the current branch **on the main agent** (it needs full context
   to judge dead code correctly — do NOT delegate this to a subagent).
2. Apply the **easy wins** (no-brainer cuts: dead code, reinvented stdlib, redundancy).
3. **Be careful with "dead code" flags:** some functions are intentional scaffolding for a
   future service. Decide per-item whether it's *scaffold/setup we added on purpose* (keep)
   or *leftover from an earlier attempt at this solution* (cut). When unsure, keep it and
   note it in the report.
4. **Run the tests again** (subagent) after cuts.

### 6c. Comment cleanup
1. Run the code comment-cleanup skill if one is installed. (A dedicated cleanup/`log` skill
   may not exist on this machine yet — if it's absent, fall back to the
   `pr-review-toolkit:comment-analyzer` agent, and if that's unavailable, do it inline.
   Either way, continue — don't block.)
2. Using the results, clean up only comments **added or modified on this branch**. Think
   critically about each comment's value: remove low-signal AI boilerplate and comments that
   restate the code; keep comments that explain *why*, non-obvious intent, or gotchas.

## Phase 7 — Final check & report
1. Run the **full unit test suite one last time** (subagent) and confirm green.
2. Notify the operator with a short, **scannable bulleted list** covering:
   - **Decisions** you made (and when/why — e.g. during planning after consulting a subagent).
   - **Review feedback applied** (which Critical/Important items, and what you fixed).
   - **Code cut** per ponytail (what and why — dead code vs. redundancy).
   - Any **deferred refactors** or concerns to raise now that the work is done.
   - Anything you defaulted on (e.g. ambiguous issue type → `task`).

   Example:
   - Decided to split `AnalysisPanel` into `AnalysisStatusBar` + `AnalysisPanel` to reduce
     main-component complexity — decided during planning after consulting a subagent.
   - Removed `summarizeDocument`, left over from a previous solution — flagged as dead code
     by ponytail.
   - Fixed a missing `organizationId` check on `documentProxy` (other proxies have it) —
     flagged as Critical by pr-review-toolkit.
