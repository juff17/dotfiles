# Rebasing

All rebases are local, in the babysit worktree on `babysit/<number>`. Fix
commits already on the branch are rebased with it. You never push. The user
reviews and pushes.

## When

| Event | Rebase? |
|-------|---------|
| `[conflict]` | Yes |
| `[behind]` with "host requires a rebase" | Yes |
| `[behind]` only | As the latest `[settings]` line says. Auto rebase off: no, note the count for the briefing; the user can ask for one. When clean: yes, but on any conflict abort the rebase and ask. Always: yes. |

## Steps

1. `git fetch <remote> <base>` (retry on lock errors, as in SKILL.md step 3).
2. Check the PR head is still `lease_sha` (the worktree may have fix commits
   on top). If the PR moved, handle the `[push]` first.
3. Record the starting point: `old_head=$(git rev-parse HEAD)` and
   `old_base=$(git merge-base HEAD <remote>/<base>)`.
4. `git rebase <remote>/<base>`.
5. For each conflict:
   - Read both sides and the base commits that caused it:
     `git log --oneline $old_base..<remote>/<base> -- <file>`.
   - Keep the intent of both sides. The branch's change applies on top of
     what the base now does. Never drop one side to make it compile.
   - `git add <file>`, then `git rebase --continue`.
   - If a conflict needs a decision you can't make from the code (two
     incompatible behaviors, deleted code the branch still needs), run
     `git rebase --abort`, notify, and ask the user to choose ("Want me to
     keep it or drop it?"). Redo the rebase with their answer.
   - Never use `git rebase --skip`, and never resolve a whole file with
     `--ours` / `--theirs` without reading it.
6. Verify: run the repo's linter and unit tests. If something fails because of
   the rebase, fix it as part of the conflict resolution and run them again.
   If it fails on the base branch as well, say so and don't fix it.
7. Propose the push (SKILL.md step 6), then brief with the rebase item format in [briefing.md](briefing.md):
   the new base, each conflict and how both sides were kept, and lint and
   test results. Keep `$old_base` and `$old_head` so you can give
   `git range-diff $old_base..$old_head <remote>/<base>..HEAD` or an undo
   (`git reset --hard $old_head`) if the user asks.
