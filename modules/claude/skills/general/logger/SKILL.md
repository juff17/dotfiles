---
name: logger
description: >
  Watch, search, share and investigate a service's logs. Live tail in the
  background with local Docker by default, or kubectl when the user names an
  environment (dev, staging, prod, a cluster or context), reporting errors,
  crashes, restarts, and whether a branch's new log lines are hit. Build
  shareable Kibana Discover links pinned to fixed times through the Elastic
  MCP, with a write-up that walks from symptom to cause. Deep dive into
  production or other environments to find failures and write an evidence-
  backed report. Use when the user wants to watch, tail, follow, or monitor
  logs, "keep an eye on the service", "tell me if anything breaks", check that
  their change runs, asks for links to logs to share with the team, or wants
  to find out what is failing, why, or since when in an environment.
license: MIT
---

# logger: watch, share and investigate logs

Three jobs, one set of rules. Pick the job, read its reference, and follow
the general rules below throughout.

| Job | When | Read |
|-----|------|------|
| **Watch** | Live tail while the user works or tests: "watch the logs", "tell me if it breaks", "is my change hit" | [references/live-tail.md](references/live-tail.md) |
| **Share** | The user wants links to logs, usually after a watch or an answer about past logs | [references/elastic.md](references/elastic.md), then [references/reporting.md](references/reporting.md) "Link set" and "Link write-up" |
| **Deep dive** | Find what is failing and why in an environment, over a past window | [references/deep-dive.md](references/deep-dive.md), which uses the other two |

Scripts in `scripts/` (call them with this skill's directory as `<skill-dir>`):

| Script | Does |
|--------|------|
| `watch_logs.py` | Streams Docker or kubectl logs, filters, de-duplicates, rate limits, reconnects. Runs under the Monitor tool. |
| `change_markers.py` | Lists log messages added on the current branch, as regexes to watch for. |
| `discover_link.py` | Builds a Kibana Discover link pinned to an absolute time range, and optionally a short link. |

A watch often leads to the other two: errors seen in a remote watch can be
shared as links or deep-dived. Offer that in one line when it fits.

## General rules

### Work out the target

| Item | Default | Override |
|------|---------|----------|
| Service | The repo the user is in | The user names another service or repo |
| Environment | Local Docker for a watch; the user must name one for share and deep dive | Any named env, cluster or context |
| What to look for | General errors and issues | The user's instructions replace or add to this |
| Branch changes | Watch for the branch's new log lines when it has changes and the env runs the branch | The user turns it off |

Ask only for what you cannot find in the repo, the kube contexts, or Elastic.

### Choose the source

| Need | Source |
|------|--------|
| Live, local | Docker (`watch_logs.py docker`) |
| Live, remote, current pods | kubectl (`watch_logs.py k8s`) |
| Past logs, pods that are gone, several services, links to share | Elastic MCP |

Local Docker logs are not in Elastic, so they cannot be shared as links.

### Handling logs

- **Read-only.** Never restart, scale, exec into, or change anything in
  Docker, a cluster, or Elastic.
- **Do not flood the conversation.** Live logs go through `watch_logs.py`
  under Monitor; Elastic results are aggregated before raw lines are pulled.
  Never stream or paste raw logs into the main thread.
- **Silence is not success.** Before trusting a quiet stream, check the
  source is connected (the `[watch] attached` line, or a non-zero count in
  Elastic for the same filter without the error condition).
- **Absolute UTC times** in everything you say, link or report.
- **Find the source in the repo.** For an error that plausibly comes from
  this service, grep the message and give file and line.
- **Tell the story, not the dump.** What happened, when, how much, where,
  why, with evidence. Details in [references/reporting.md](references/reporting.md).
- **Mask secrets and personal data** in anything you quote.
- **No Elastic MCP?** For share and deep dive, stop and ask the user to
  install it (steps in [references/elastic.md](references/elastic.md)).
