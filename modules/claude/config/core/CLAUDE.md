# Global instructions

## Deleting files

Run every `rm` or `git rm` as its own Bash call: one plain command with literal
paths, for example `rm /tmp/claude-1000/<project>/<session>/scratchpad/probe.txt`.

- Don't chain it with `&&`, `;` or `|`, or put it inside a heredoc,
  `bash -c`, `python3 -` script, `for` loop or `$(...)`.
- Write paths out in full: no `$VAR`, `~`, globs, quotes or `.`/`..` as a target.
- Run the rest of the work in a separate call before or after.

Why: the rm-guard hook (`hooks/core/rm-guard.sh` in jstack) approves an `rm` on
its own only when it is a single plain command and every target is inside
Claude's scratchpad or a linked git worktree. Any other form makes the user
approve it by hand, and those prompts were most of the user's manual approvals.
An `rm` outside the scratchpad or a worktree still asks, as intended.
