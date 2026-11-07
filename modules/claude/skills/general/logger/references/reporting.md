# Reporting: logs that tell a story

The reader is a developer with little time. They open the report to learn
what went wrong, when, how bad it is, and why, and to use the logs as
evidence for a conclusion. Raw log dumps make them do your job. Every line in
a report, and every link, must answer a question they would ask.

## Rules for every report

- **Conclusion first.** One or two sentences: what happened and the impact.
- **Absolute UTC times.** `14:02 UTC`, with the date when it is not today.
  Never "a few minutes ago".
- **Numbers, not adjectives.** "312 errors in 9 minutes, 4% of requests", not
  "lots of errors".
- **Each claim has evidence.** A link, a quoted log line, or a query result.
  Mark anything without evidence as a guess.
- **Confidence.** Say how sure you are about the cause (confirmed, likely,
  guess) and what would confirm it.
- **Quote, do not dump.** At most 3 log lines per point, trimmed to the
  useful part. Collapse repeats into a count ("x312").
- **No secrets.** Mask tokens, passwords, emails, card numbers and other
  personal data in quoted lines.
- **Say what is missing.** Gaps in logs, services you could not see, and
  questions you could not answer.

## Link set

Build 3 to 6 links that, opened in order, walk the reader from symptom to
cause. One question per link. Pick from:

| Link | Question it answers | Query shape |
|------|---------------------|-------------|
| Overview | When did it start and stop, and how big is it? | Error count per minute, with the window padded to show the normal state before |
| Signatures | What distinct errors are there? | `STATS count BY error.type, error.message`, sorted by count |
| First occurrence | What happened right before the first error? | All levels for the service, a 2 to 5 minute window ending just after the first error |
| One request | What did one failing request do, end to end? | Filter on one `trace.id` or request id, all services, sorted by time |
| Blast radius | Is it one pod, one version, one customer, one endpoint? | `STATS count BY kubernetes.pod.name, service.version` (or the relevant field) |
| Before and after | Did a deploy or config change cause it? | Same query, split by `service.version`, around the deploy time |
| Change marker | Is the new code running and logging? | Filter on the marker text |

For each link:

- Keep only the columns needed (`KEEP` in ES|QL). Usually time, pod or
  service, level, message.
- Sort by time ascending for stories, by count descending for signatures.
- Test the query through the MCP before sharing (see [elastic.md](elastic.md)).

## Link write-up

Use when the user asks for links to share. Ready to paste into Slack or a
ticket:

```markdown
**payments-api errors on prod, 2026-10-08 14:02 to 14:11 UTC**

Card payments failed for 9 minutes (312 errors, about 4% of checkouts).
Cause (likely): the ledger client's connection pool ran out after the
14:00 deploy of v2.41.0 lowered the pool size from 50 to 5.

1. [Error rate](<link>): errors start at 14:02, two minutes after the deploy, and stop at 14:11 after the rollback.
2. [Error types](<link>): 97% are `PoolTimeoutError: timed out waiting for connection`.
3. [First failure](<link>): pool usage logs climb to 5/5 in the 30 seconds before the first timeout.
4. [One failed checkout](<link>): the request waits 10 s for a connection, then returns 503.
5. [By version](<link>): every error comes from v2.41.0 pods; v2.40.3 pods had none.

Not checked: whether retried payments were charged twice.
Links show fixed times and work while logs are retained (30 days).
```

Each list item: the link, then what the reader will see and why it matters.
Not "Link to errors".

## Watch summary

Use when a live tail session ends, or the user asks how it went:

- One line: what was watched, where, and for how long (UTC times).
- Errors and status changes, grouped by signature, with counts and first and
  last times. Source location in the repo if found.
- Change markers: hit (with count) and not hit.
- Anything the user should act on.

If the watch was local Docker, those logs are not in Elastic. Links are not
possible; quote the key lines instead and say so.

## Deep dive report

Use for investigations ([deep-dive.md](deep-dive.md)). Sections:

1. **Summary**: what happened, impact, cause, confidence. Three sentences at most.
2. **Timeline**: a table of UTC time, event, evidence link. Include deploys,
   config changes, the first error, peaks, recovery.
3. **Findings**: one block per issue, ranked by impact. Each: what, how many,
   where, cause, evidence (links and up to 3 quoted lines), source location in
   the repo.
4. **Ruled out**: hypotheses checked and rejected, with the evidence. This
   saves the reader from re-checking them.
5. **Open questions**: what you could not answer, and what data would answer it.
6. **Next steps**: concrete actions (fix, rollback, alert, more logging), each
   tied to a finding.

Short reports (one clear issue) go in the chat. Long ones (several findings,
a timeline of more than a few rows), or ones the user wants to share with
the team: offer to publish them as a document, and give the chat a short
summary with the link.
