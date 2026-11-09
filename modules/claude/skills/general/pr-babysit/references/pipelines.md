# Handling pipeline events

`[failed]`, `[manual]`, and `[stuck]` lines carry `id=` and a URL. The id is
the GitHub check run id (the same as the Actions job id), a GitHub commit
status context (`status:<name>`), a workflow run (`run:<id>`), or the GitLab
job id.

## Read the failure

Fetch only the end of the log:

| Host | Command |
|------|---------|
| GitHub Actions job | `gh api repos/<owner>/<repo>/actions/jobs/<id>/logs \| tail -n 200` |
| GitHub commit status (`status:`) | External CI; the log is behind the URL. Report the URL. |
| GitLab job | `glab api "projects/<url-encoded path>/jobs/<id>/trace" \| tail -n 200` |
| GitLab bridge (child pipeline) | `glab api "projects/<path>/pipelines/<child id>/jobs?scope=failed"`, then the trace of each failed job |

Read more of the log only if the cause is not in the tail.

A job marked "(allowed to fail)" does not block the merge. Note it for the
briefing and do not notify.

## Classify it

| Cause | Signs | Do |
|-------|-------|----|
| The branch's code | Test, lint, type, or build errors in files the branch changed, or in code they call | Reproduce locally if it runs in a few minutes. If the fix is obvious (same bar as [feedback.md](feedback.md)), make it in the worktree, run lint and unit tests, and commit it on `babysit/<number>`. Propose the push (SKILL.md step 6). |
| The base branch | The same failure on the base branch's latest pipeline | FYI only; a rebase may fix it once the base is fixed |
| Flaky or infra | Runner lost, network or registry errors, OOM, timeout with no code cause, test that passed on the last run | Propose a retry with the reason: `approval.py propose retry ... --reason "runner lost connection"`. Settings may run it at once, once per job. |
| Unknown | None of the above | Notify with the key log line and your best guess. If a retry is worth trying, propose one. |

Base branch pipelines: `gh api "repos/<owner>/<repo>/actions/runs?branch=<base>&per_page=5"`
or `glab api "projects/<path>/pipelines?ref=<base>&per_page=5"`.

Never run a retry yourself; `approval.py` runs it once approved. An outside
CI status (`status:` id) can't be retried from here: give its URL.

## Manual, approval, and stuck jobs

These need a person. Propose them; the tray and Alt+A show them at once.

- GitLab manual job: `approval.py propose manual <url> --session <id> --job <id> --name <job> --stage <stage>`.
  Settings may play it on its own; a job whose name or stage says deploy,
  release or prod always waits for the user.
- GitHub environment or workflow approval: the same command. On GitHub it
  becomes a deployment approval, which always waits for the user. If the
  token can't approve it, the `[approval]` failure says so: tell the user to
  approve at the link.
- Stuck: the job is waiting for a runner. Say how long, and whether other
  jobs got runners. Ask "Want me to cancel it?". On yes:
  `gh api -X POST repos/<owner>/<repo>/actions/runs/<run id>/cancel` (GitHub
  cancels the whole run) or `glab api -X POST "projects/<path>/jobs/<id>/cancel"`.
