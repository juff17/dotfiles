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
| The branch's code | Test, lint, type, or build errors in files the branch changed, or in code they call | Reproduce locally if it runs in a few minutes. If the fix is obvious (same bar as [feedback.md](feedback.md)), make it in the worktree, run lint and unit tests, and commit it on `babysit/<number>`. Notify. |
| The base branch | The same failure on the base branch's latest pipeline | FYI only; a rebase may fix it once the base is fixed |
| Flaky or infra | Runner lost, network or registry errors, OOM, timeout with no code cause, test that passed on the last run | Notify and ask "Want me to retry?". Retry only on yes, once per job. |
| Unknown | None of the above | Notify with the key log line and your best guess. If a retry is worth trying, ask "Want me to retry?" |

Base branch pipelines: `gh api "repos/<owner>/<repo>/actions/runs?branch=<base>&per_page=5"`
or `glab api "projects/<path>/pipelines?ref=<base>&per_page=5"`.

Retry commands (run them only after the user says yes):

- GitHub: `gh api -X POST repos/<owner>/<repo>/actions/jobs/<id>/rerun`
- GitLab: `glab api -X POST "projects/<path>/jobs/<id>/retry"`

## Manual, approval, and stuck jobs

These need a person. Notify right away with the job name and URL, and offer
to act. Act only after the user says yes.

- GitLab manual job: ask "Want me to run it?". On yes:
  `glab api -X POST "projects/<path>/jobs/<id>/play"`.
- GitHub environment approval: ask "Want me to approve it?". On yes, get the
  environment id from `gh api repos/<owner>/<repo>/actions/runs/<run id>/pending_deployments`,
  then `gh api -X POST repos/<owner>/<repo>/actions/runs/<run id>/pending_deployments -f state=approved -F "environment_ids[]=<env id>" -f comment="Approved from pr-babysit"`.
  If the token is not allowed, say to approve at the link instead.
- Stuck: the job is waiting for a runner. Say how long, and whether other
  jobs got runners. Ask "Want me to cancel it?". On yes:
  `gh api -X POST repos/<owner>/<repo>/actions/runs/<run id>/cancel` (GitHub
  cancels the whole run) or `glab api -X POST "projects/<path>/jobs/<id>/cancel"`.
