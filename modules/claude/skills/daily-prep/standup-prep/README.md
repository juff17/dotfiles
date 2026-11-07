# standup-prep

A portable Claude skill that prepares your **daily standup update** — *Yesterday / Today /
Blockers* — from your own **Jira** activity (primary) and your **public Slack** messages.
It reads only; it never posts. The update is presented to you in chat to read at standup.

- **Data:** Jira (Atlassian Cloud), **read-only**, via the Atlassian MCP — plus public
  Slack channels via the Slack MCP.
- **Output:** a short update **in chat** (not posted anywhere).
- **Auth:** MCP + OAuth only. No API tokens, no stored credentials.
- **Schedule:** optional — a Claude **cloud routine** (`/schedule`) on weekday mornings.

Example output:

```
**Standup — 2026-06-26**

**Yesterday**
- released APP-175232 — create new react controllers
- started APP-174214 — implement scaffolding for document search queues
- moved APP-17142 to review — implement document classification
- discussed new API contracts in #checkout-eng
- assisted John with local setup issues

**Today**
- continue APP-174214 — implement scaffolding for document search queues
- may start APP-17533 — wire up search result pagination
- will try to pick up a ticket for review
- follow up on the staging deploy I promised in #checkout-eng

**Blockers**
- APP-17890 blocked — waiting on infra access
```

## Files
| File | Tracked | Purpose |
| --- | --- | --- |
| `SKILL.md` | yes | The standup logic (generic, company-agnostic). |
| `references/mcp-tools.md` | yes | Which Jira/Slack MCP tool to use per step + our JQL & classification rules. |
| `references/standup-format.md` | yes | The output format spec. |
| `config.example.yaml` | yes | Template of every config field. |
| `config.yaml` | **no (gitignored)** | Your real identity + board status names. |

## What it pulls

| Source | What | How |
|---|---|---|
| **Jira** (primary) | Tickets you **created, moved, reviewed, released** yesterday; what's **in progress / To Do** now; what's **blocked** | JQL + per-issue changelog |
| **Jira** (best-effort) | **MRs opened** | remote issue links on your tickets (a GitLab/GitHub MCP would do this better) |
| **Slack** (public only) | Public **threads you took part in**, people you **helped**, **promises** you made | message search, or channel/thread reads — **never DMs** |

The "Today" plan rules: in-progress work first; To Do items show as *"may start"*;
unassigned review-column tickets you **didn't develop** become *"will try to pick up a
ticket for review"*; promises from yesterday's Slack become follow-ups.

## Activation — 3 steps

### 1. Connect the MCPs (OAuth, read-only Jira)
```bash
claude mcp add --transport sse --scope user atlassian https://mcp.atlassian.com/v1/sse
```
Complete the OAuth flow; verify with `claude mcp list` and a trivial JQL search. Then add
your **Slack MCP** (OAuth) — **read-only public-channel access is all that's needed**; the
skill never posts and never reads DMs. Make sure the Slack app is invited to the public
channels you want included.

### 2. Fill `config.yaml`
```bash
cp config.example.yaml config.yaml
```
| Field | Meaning |
| --- | --- |
| `jira.display_name` (and ideally `account_id`) | So the skill recognises **you** in ticket changelogs. Get `account_id` from `atlassianUserInfo`. |
| `slack.handle` (and ideally `user_id`) | So it can find the messages **you** posted. |
| `timezone` | Your IANA tz (defines "yesterday"). |
| `lookback` | `previous_business_day` (Mon covers Fri+weekend) or `yesterday`. |
| `statuses` | Your board's real column/status names, grouped todo / in_progress / in_review / released / blocked. **Most important to get right** — classification depends on it. |
| `developer_field` | How to tell who wrote a ticket (so you're never offered your own work to review): `reporter`, `assignee_history`, or a custom field id. |

### 3. Run it
With the MCPs connected, ask Claude Code:
> **"prep my standup"**  (or "what did I do yesterday")

It resolves your identity, runs the Jira/Slack reads, and prints the update in chat.
Nothing is written to disk and nothing is posted. Tune `config.yaml` (especially
`statuses`) until the classification looks right.

## Run it on a schedule (optional)
Once the output looks good, create a cloud routine via the `/schedule` skill, roughly:
- **MCP connections:** attach the Atlassian + Slack connectors to the routine.
- **prompt:** `Prep my standup for yesterday using the standup-prep skill.`
- **cron:** e.g. `0 13 * * 1-5` (weekdays 9am America/New_York = 13:00 UTC; min interval 1h).

> Routines run in the cloud with **no access to your local machine** — all data comes from
> the connected MCP servers, so the connectors must be attached to the routine. The
> gitignored `config.yaml` is **not** in the repo the routine clones; either keep your
> board's status names in the routine prompt, or commit a non-secret `config.yaml` to a
> private fork. (Identity is resolved live via `atlassianUserInfo`/`slack_get_users`.)

## Moving to a new company
Reconnect the Atlassian + Slack MCPs for the new workspace and edit `config.yaml` (new
display name / handle, new board status names). Nothing in `SKILL.md` changes.

## Notes / limits
- **Read-only** by design — never transitions, comments, or posts.
- **No DMs, ever** — only public channels (`C…`).
- **MRs are best-effort** without a GitLab/GitHub MCP (inferred from Jira remote links /
  Slack mentions).
- **Never reviews your own work** — the "pick up a review" suggestion excludes tickets you
  developed.
- The skill **reports** empty sources / tool errors rather than fabricating around them.
