---
name: pr-walkthrough-audit
argument-hint: "[base-branch] [--entry <name>] [--state] [--tour]"
description: >-
  Walk through the code a PR adds or changes, starting from each entry point it
  touches (endpoint, UI action, job, webhook, CLI command), and report every
  point where something can fail and whether that failure is handled, surfaced,
  and leaves data consistent. Use when the user wants a PR walkthrough, an
  error-handling or failure-path audit of a branch, or asks "what can go wrong
  in this PR".
license: MIT
---

# pr-walkthrough-audit

Reviews a PR by **walking it the way it runs**. For each entry point the PR
touches, follow the code path in execution order and, at every step that can
fail, answer:

- What fails here, and how?
- Where is that handled, if anywhere?
- What does the user, the caller, and the operator see?
- What state is left behind?

This catches what a file-by-file diff review misses: a failure point with **no
handler at all**, a write that succeeded before a later step failed, a success
message shown while the background work died. It complements
`pr-review-toolkit:silent-failure-hunter`, which grades the error handlers that
exist; this skill finds the steps that have none and judges each step against
the whole flow.

Report only. Never edit code unless the user asks after seeing the report.

## Workflow

### 1. Scope the PR

The PR is the current branch compared with its base.

- Base: the argument if given, otherwise the repo's default branch
  (`git symbolic-ref refs/remotes/origin/HEAD`, falling back to `main` then
  `master`).
- Changed code: `git diff <merge-base>...HEAD`. If there are uncommitted
  changes, ask whether to include them, and mark findings that come only from
  uncommitted code.
- Record the HEAD commit now. Check it again before writing the report; if it
  moved, say so and re-check any finding in files that changed.
- Read the full diff before tracing anything.

### 2. Find the entry points

List every entry point whose path runs through changed code:

- HTTP routes and RPC handlers
- UI actions (button, form submit, page load that fetches)
- jobs, cron, queue consumers
- webhooks
- CLI commands

A changed helper counts if an entry point calls it: follow callers up until you
reach one. Modes of one command (a CLI's `--uninstall`, a route's `DELETE` vs
`PUT`) count as separate entry points when they take different paths. With
`--entry <name>`, or when the user names the entry points, trace only those.

Show the list (entry point, file:line, which changed files it passes through).
If there are more than about 8, ask the user which to trace before continuing.

### 3. Trace each entry point

Follow the path in execution order, into unchanged code where the path goes
there. Stop at code the repo doesn't own (a library, an external API) and record
what it is assumed to do on failure.

Write one record per step that can fail, using the fields in
[`references/report-format.md`](references/report-format.md). Check each step
against [`references/failure-checklist.md`](references/failure-checklist.md).
With `--state`, also apply [`references/state-lens.md`](references/state-lens.md)
to UI entry points.

For 4 or more entry points, trace them in parallel: one subagent per entry
point, each given the diff range, its entry point, and these reference files.
With `--state`, build the store side-effect map first and pass it to every
subagent.

Rules while tracing:

- **Read before citing.** Every file:line comes from code you opened. Never
  guess a line.
- **Follow state and timing past the path.** When a step sets a status, flag,
  lock, or "pending" record, find what moves it on after both success and
  failure. When a step makes data visible to another process (a row, an event,
  a cache entry, a file, a response), check that it is complete and committed
  at that moment. Checklist items 15 and 16 cover what to look for.
- **Unhandled steps are the main finding.** Most of the value is in steps where
  nothing catches the failure, not in grading catch blocks that exist.
- **A fallback may be deliberate.** If a default value or skipped step looks
  intentional (a comment, a test, a documented degrade), mark it `DEGRADED-OK`.
  If it's unclear, list it as a question for the user, not a finding.
- **"This can't fail" needs evidence**: a type, a guard, a constraint, a test.
- **Changed code first.** Steps in unchanged code matter when the PR's code
  depends on how they fail, or when the PR feeds them new inputs (new names,
  paths, data shapes) that make an old failure reachable.
- **Reproduce when it's safe.** You may confirm a failure by running something
  that can't touch real state: a dry-run flag, a test, or a copy of the repo in
  your scratchpad with `HOME` or config pointed there. Never run against the
  user's real environment, shared services, or production. Mark confirmed
  findings as reproduced.

### 4. Report

Follow the output section of [`references/report-format.md`](references/report-format.md):

- In chat: a short summary, then the top findings ranked by consequence, then
  open questions.
- Write the full step-by-step report to a Markdown file in your scratchpad and
  give the path.
- If every step is `HANDLED` or `DEGRADED-OK`, say so in one line.

### 5. Tour (optional)

With `--tour`, or if the user asks after the report, turn the findings into a
CodeTour file using the `explain-code` skill (its `references/tour.md`), one step per finding in execution
order, with `ref` set to the HEAD commit hash you recorded (a branch name moves
as commits land). Write it to your scratchpad, not the repo, and offer to copy
it into the repo's `.tours/`. The mapping is in
[`references/report-format.md`](references/report-format.md). Validate it with
the explain-code skill's `scripts/validate.py` before reporting the path.

### 6. Offer fixes

End by asking whether to fix any findings. Fix only what the user picks, with
the smallest change, and add a test for each failure path you fix.
