# Briefing format

Briefings go in the chat, never in a file or doc. Use bullets and short
sentences. Skip any section with nothing in it.

## Event briefing (sent with a notification)

```
**<repo> !<number>: <what needs you>**
- <what happened, with link>
- <what you did, or what you need from the user>
- <command to run, if any>
```

## Full briefing (when the user comes back or asks)

```
## <repo> !<number> "<title>"

**Status**: pipeline <passed/failed/running> on <sha>, <N> behind <base>, <approvals>

### Needs you
- <manual or stuck job, failure needing a decision, changes requested>

### Ready for review (uncommitted in <worktree path>)
| Comment | Change | Checks |
|---------|--------|--------|
| [@alice on src/a.py:42](<url>) | <one line> | lint ✓ tests ✓ |

Then, for each one:
> <full comment text>
- My take: <why it was clearly worth doing>
- Files: <list>

### Rebase (not pushed)
- <base sha, conflicts and how they were combined, test results>
- Review: `git range-diff ...`  Push: `git push --force-with-lease origin <branch>`

### Not addressed
For each Unsure or No comment:
- [@bob on src/b.py:10](<url>): Unsure / No
  > <full comment text>
  - My take: <what you think, what decision it needs, or why no>

### Pipeline
- <failures seen since the last briefing, cause, and status now>
```

Each comment links to its URL from the event line, and its full text is quoted.
Clear an item from the briefing list once the user has seen it; it is not
repeated for the rest of the session.
