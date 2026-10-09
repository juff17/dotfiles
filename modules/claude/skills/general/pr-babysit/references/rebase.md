# Rebasing

All rebases are local, in the babysit worktree. You never push. The user
reviews and pushes.

## When

| Event | Rebase? |
|-------|---------|
| `[conflict]` | Yes |
| `[behind]` with "host requires a rebase" | Yes |
| `[behind]` only | No. Note the count for the briefing. The user can ask for one. |

If the worktree has uncommitted changes from a feedback fix, do not rebase.
Tell the user both are waiting, and rebase after they commit or discard the fix.

## Steps

1. Record the starting point: `old_head=$(git rev-parse HEAD)` and
   `old_base=$(git merge-base HEAD origin/<base>)`.
2. `git fetch origin <base> <branch>`. If the remote branch moved past the
   local one (the user pushed from elsewhere), fast-forward first. If they
   diverged, stop and ask.
3. `git rebase origin/<base>`.
4. For each conflict:
   - Read both sides and the base commits that caused it:
     `git log --oneline $old_base..origin/<base> -- <file>`.
   - Keep the intent of both sides. The branch's change applies on top of
     what the base now does. Never drop one side to make it compile.
   - `git add <file>`, then `git rebase --continue`.
   - If a conflict needs a decision you can't make from the code (two
     incompatible behaviors, deleted code the branch still needs), run
     `git rebase --abort` and notify the user with the files and the reason.
   - Never use `git rebase --skip`, and never resolve a whole file with
     `--ours` / `--theirs` without reading it.
5. Verify: run the repo's linter and unit tests. If something fails because of
   the rebase, fix it as part of the conflict resolution and run them again.
   If it fails on the base branch as well, say so and don't fix it.
6. Notify, then brief in the chat:
   - The new base commit, and how many commits came in.
   - Each conflicted file: what each side changed and how you combined them.
   - Lint and test results.
   - To review: `git range-diff $old_base..$old_head origin/<base>..HEAD`.
   - To publish: `git push --force-with-lease origin <branch>`.
   - To undo: `git reset --hard $old_head` (give the actual sha).

A rebase with no conflicts gets a one-line briefing: new base, lint and tests
passed, and the push command.
