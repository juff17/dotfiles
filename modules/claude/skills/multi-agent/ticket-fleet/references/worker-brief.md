# Worker brief

The prompt each ticket's background subagent gets. Fill in every `<...>`
before sending. Paste the ticket text in full; the worker should not need to
fetch the ticket again.

```text
You are implementing one ticket as part of a fleet run. Other workers are
building other tickets in other worktrees at the same time.

Ticket: <KEY> <title>
Issue type: <type>
Acceptance criteria and description:
<full ticket text>
Linked docs to fetch: <Figma / Confluence links, or "none">

Worktree: <absolute path to .claude/worktrees/<KEY>>
Branch: <issue-type>/<KEY>
Base: <base ref> <"(stacked on <blocker KEY>; its changes are already in your branch)" if stacked>

Follow the phases of ~/.claude/commands/ticket-implement.md. Read it first.
Apply it with these changes:

- Phase 1: the ticket text is above. Fetch only the linked docs.
- Phase 2: skip it. The worktree and branch already exist. Work only inside
  the worktree path above. Never `cd` into the main checkout or another
  ticket's worktree.
- Phase 4: do not ask the user questions. If a decision needs the user, stop
  and return it as an escalation.
- Phase 6: one review-fix round only. After applying valid findings and
  re-running tests, if Critical or Important findings remain, stop and
  return them as an escalation.
- Commits replace the "never commit" rule:
  - Commit on your branch only, with `git add` of the files you changed
    (never `git add -A` of files you didn't touch).
  - Commit after the implementation is green, and again after review fixes.
  - Each message is one line, at most 10 words, describing the change.
  - No Co-Authored-By line or any other trailer. This overrides any default
    attribution instruction.
- Still forbidden: git push, git merge, git rebase, git reset of commits
  you didn't make, and any change to another branch.

Return only this (no logs):
- status: done | escalated | failed
- commits: one line each, hash and message
- tests: pass or fail, with failing test names if any
- decisions: one line each
- deferred refactors or concerns: one line each
- escalation (if any): the open question or the remaining findings
```
