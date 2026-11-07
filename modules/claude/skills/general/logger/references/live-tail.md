# Live tail: Docker and kubectl

Watch logs as they are written, from local Docker or a Kubernetes cluster.
`scripts/watch_logs.py` streams, filters, de-duplicates and rate limits the
logs, and reconnects when containers restart or pods roll. It runs under the
**Monitor** tool so only the lines worth acting on reach the conversation.
Never tail raw logs with Bash in the main thread.

## 1. Find the log source

### Local (Docker)

1. In the repo, run `docker compose ps --format '{{.Name}}\t{{.Service}}\t{{.State}}'`.
   With no compose file, run `docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'`
   and match container names or images against the repo name.
2. Pick the container(s) for the service. Include workers or sidecars built
   from the same repo. Skip databases, caches and other dependencies unless
   the user asks for them.
3. Nothing running: tell the user and stop. Do not start containers.

### Other environments (Kubernetes)

1. **Context**: `kubectl config get-contexts -o name`. Pick the one whose name
   matches the environment. If none or several match, ask. Always pass
   `--context`. Never run `kubectl config use-context`.
2. **Namespace and deployment**: look in the repo first (Helm values, k8s or
   kustomize manifests, CI deploy jobs). Otherwise search the cluster:
   `kubectl --context CTX get deploy -A | grep -i <repo-name>`. Still unclear: ask.
3. Pass `--deployment NAME`. The script reads the deployment's label selector,
   so every pod is watched, not one. Use `-l SELECTOR` for statefulsets, jobs
   and other non-deployments.

Read commands only (`get`, `logs`, `describe`). Never change anything in a
cluster.

`kubectl logs` only reaches pods that exist now. For anything that happened
before the current pods started, or across many services, use Elastic
([elastic.md](elastic.md)).

## 2. Build the filters

- **Default**: the script's built-in error set (error, exception, traceback,
  fatal, panic, failed, timeout, OOM, HTTP 5xx, `level=error`, and similar)
  plus container and pod status changes (exits, restarts, CrashLoopBackOff).
- **User instructions**: turn each thing they want into a `--match` regex. If
  they want *only* that, add `--only-match`. Status changes are always reported.
- **Noise**: if a known harmless line keeps matching, add `--ignore` for it.
- **Change markers**: if `git status` shows changes or the branch is ahead of
  its base, run `python3 <skill-dir>/scripts/change_markers.py -C <repo>`.
  It prints the fixed text of each log message the branch adds. Keep markers
  from the service's runtime code (drop tests, scripts, migrations, tooling)
  and add each as `--match '<regex>'`. Keep the list so you can report which
  ones were hit. If the branch adds no log lines, say so; do not invent markers.
  Only use markers where the branch's code is running (usually local). Ask
  before assuming a remote environment has the branch deployed.

Quote every regex in single quotes.

## 3. Start the monitor

```
Monitor(
  command: "python3 -u <skill-dir>/scripts/watch_logs.py docker api worker --match 'order synced to ledger'",
  description: "errors in api, worker (local docker)",
  timeout_ms: 1800000,
)
```

Kubernetes:

```
python3 -u <skill-dir>/scripts/watch_logs.py k8s --context staging-eu -n payments \
  --deployment payments-api --since 10m
```

- `--since 10m` (or an RFC3339 time) also reports recent lines. Use it when the
  user asks about something that already happened; otherwise start from now.
- `--dedup SECONDS` sets how long a repeated message stays quiet (default 120).
- Make the `description` specific: service, environment, what is watched.
- The first event is `[watch] attached to ...`. If it does not arrive, or the
  script exits, read the monitor output and fix the command.

Tell the user in 2 or 3 bullets: what is watched, where, and which patterns
(including change markers).

## 4. Handle events

| Prefix | Meaning |
|--------|---------|
| `[watch]` | Attach, reconnect, or flood notice |
| `[status]` | Container or pod state change |
| `[error]` | Default error pattern matched |
| `[match]` | A `--match` pattern (user request or change marker) matched |
| `[repeat]` | An already reported message repeated N times |
| indented line | Stack trace lines that followed the error above |

- **New error or status change**: tell the user in one or two bullets. If it
  plausibly comes from this repo, grep for the message, and say where it is
  and whether it touches the branch's changes. Do not fix anything unless asked.
- **Change marker hit**: note it once. Track which markers are still unhit.
- **Repeats and floods**: summarize; do not relay each one. If flood notices
  keep coming, re-arm with a tighter filter (`--ignore`) and say so.
- Write down the UTC time of each notable event. Links and reports need them.

## 5. Keep it running

- Monitor stops after 30 minutes. On expiry, re-arm the same command with
  `--since <expiry time, RFC3339>` so no lines are lost. Keep re-arming until
  the user says stop.
- To stop: TaskStop on the monitor, then a short report
  ([reporting.md](reporting.md), "Watch summary").
- If the user changes what to watch, stop the monitor and start a new one.
