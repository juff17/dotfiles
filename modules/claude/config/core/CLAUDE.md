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

## Secrets and tokens

Never read, print, or log the value of an API key, access token, or other
secret. This covers environment variables and the files that store them.

Examples:

- Env vars: `GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITLAB_TOKEN`,
  `NPM_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`,
  and anything named `*_TOKEN`, `*_KEY`, `*_SECRET`, or `*_PASSWORD`.
- Files: `.env`, `.env.*`, `~/.npmrc`, `~/.config/gh/hosts.yml`,
  `~/.config/glab-cli/config.yml`, `~/.aws/credentials`, `~/.netrc`,
  `~/.git-credentials`, and shell profiles that export secrets.
- Commands that expose them: `echo $TOKEN`, `env`, `printenv`, `set`,
  `cat .env`, `gh auth token`, `gh auth status`, `glab auth status`,
  `git config --get credential.*`, `set -x` in scripts that use them.

To check that a secret is set, test it without printing it, for example
`[ -n "$GITHUB_TOKEN" ] && echo set || echo unset`. If a task seems to need a
secret's value, stop and ask the user.

Why: these keys grant access to the user's accounts, and anything printed
lands in the transcript.
