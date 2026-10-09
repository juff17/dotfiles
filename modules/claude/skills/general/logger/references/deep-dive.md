# Deep dive: investigate failures with Elastic

Find what is going wrong in an environment, why, and since when, then report
it with evidence. Requires an Elastic MCP server ([elastic.md](elastic.md)).
All work is read-only.

## 1. Scope

Settle these before querying. Ask only for what you cannot infer.

| Item | Default |
|------|---------|
| Service | The current repo |
| Environment | Production, if the user said "prod" or named none for a deep dive. Confirm it in the first update. |
| Window | The time the user names. Otherwise the last 24 hours, then narrow. |
| Question | The symptom the user reports (an alert, a ticket, "checkout is slow"). With none, look for the biggest problems in the window. |

Turn the window into absolute UTC times at the start, and use those times for
every query and link. Results must not shift while you work.

## 2. Orient

1. Find the indices and the service and environment fields
   ([elastic.md](elastic.md), section 3).
2. Get the shape of the window: total log volume and error volume per bucket
   (1 minute for an hour, 15 minutes for a day).
3. Get a baseline: the same counts for the same window one day or one week
   earlier. An error that is always there is not the incident; say so, and
   list it separately as background noise.

## 3. Find what changed

- **When**: the first bucket where errors rise above baseline. Use
  `observability.get_log_change_points` or `run_log_rate_analysis` if present.
- **What**: group errors by `error.type` and `error.message` (or
  `observability.get_log_groups`). Normalize ids and numbers so one bug is one
  group. Rank by count and by how new each group is (new groups first).
- **Where**: split the top groups by pod, host, version, endpoint, and region
  or zone. Concentration in one value is the strongest clue.
- **Around it**: deploys (`service.version` changing), pod restarts and OOM
  kills, config changes, and errors in upstream and downstream services at the
  same time. Check `observability.get_alerts` and
  `observability.get_service_topology` if present.

## 4. Trace examples

For each top error group, pick 1 or 2 example events:

1. Read the full document (all fields, stack trace).
2. Follow its `trace.id` or request id across all services, sorted by time
   (`observability.get_traces` if present). Find the first failure in the
   chain; that service is usually the cause, the others are symptoms.
3. Read the logs from the same pod in the 1 to 5 minutes before the first
   error of the group.

## 5. Connect to the code

- Grep the repo for the error message, the logger name, or the stack trace
  frames. Give file and line.
- `git log` for changes to those files between the last good version and the
  first bad one (from `service.version` or image tags). Name the commit when
  one plausibly caused it.
- Check the current branch too: if it changes the failing code, say whether
  it fixes or worsens the problem.

## 6. Test the hypothesis

Before reporting a cause, write down what else must be true if it is right,
and check it in the logs. Examples:

- "The v2.41.0 deploy caused it" → old-version pods have no errors, and errors
  start within minutes of the rollout.
- "The database is slow" → other services that use it fail at the same time.
- "One customer's data triggers it" → errors share a tenant or account id.

A hypothesis that fails a check goes into "Ruled out" with the evidence. Stop
when the cause is confirmed, or when the remaining checks need data that is
not in the logs (then say what data would settle it).

## 7. Report

Build the link set and write the deep dive report as described in
[reporting.md](reporting.md). Post a one-line progress update to the user at
each step above (scope set, change found, cause tested). Keep the findings
themselves for the report.

## Guard rails

- Every query has a time range and a `LIMIT`. Start with counts and
  aggregations; pull raw documents only for chosen examples.
- Do not paste large result sets into the conversation. Summarize them.
- Mask secrets and personal data in anything you quote.
- Never write to Elastic or the cluster. Do not change code unless the user
  asks after the report.
