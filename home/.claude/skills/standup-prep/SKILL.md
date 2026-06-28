---
name: standup-prep
description: Prepare the user's daily standup update from yesterday's Jira and Slack activity. Pulls the tickets they created, moved, reviewed, and released; the MRs they opened; and the public Slack threads they took part in — then writes a brief, scannable "Yesterday / Today / Blockers" update to read at standup. Use when the user asks for their standup, daily update, "what did I do yesterday", or standup prep.
---

# Standup prep

Produce a short standup update for the user covering **yesterday**, **today**, and
**blockers**, built from their Jira and Slack activity. Jira is the primary source.
The output is read aloud at standup, so keep it brief and skimmable — follow
`references/standup-format.md` exactly.

You are the orchestrator. You call the MCP tools, classify the activity, and write the
update. The MCP servers are connected at runtime (OAuth), so their tools already carry
full descriptions/schemas — `references/mcp-tools.md` only tells you **which** tool to
reach for at each step and holds our JQL + classification rules. **Never post to Slack
and never read DMs.**

## 0. Load identity
Read `config.yaml` from this skill's directory. If it is missing, read
`config.example.yaml` instead and **warn loudly in the output** that example/placeholder
values are in use. It tells you who the user is (Jira + Slack identity), the timezone, the
lookback, and the status vocabulary for their board. If individual fields are blank, fall
back to the live lookups below and tell the user which ones to fill in for a more reliable
run.

Compute the **time window** from `timezone` + `lookback`:
- `yesterday` → the previous calendar day in that tz.
- `previous_business_day` → previous calendar day, except on **Monday** cover **Fri
  00:00 → Mon 00:00** (Fri + weekend). Use today's real date — check it, don't assume.

## 1. Resolve who you are (Jira)
1. Call `getAccessibleAtlassianResources` → take the `cloudId` for the user's site. Reuse
   it on every Jira call.
2. Call `atlassianUserInfo` → confirm the account matches `config.jira` (display_name /
   account_id / email). This account is "me" for the changelog checks below.

`currentUser()` in JQL already resolves to this account, so most queries don't need the
accountId — but you need the display_name/accountId to read **who** moved a ticket in a
changelog.

## 2. Gather yesterday's Jira activity
Run these with `searchJiraIssuesUsingJql` (substitute your board's status names from
`config.statuses`, and use explicit yesterday dates — see `references/mcp-tools.md`).
Request only `summary,status,assignee,reporter,issuetype,updated`.

- **Created by me:** `reporter = currentUser() AND created >= <start> AND created < <end>`.
- **Transitioned by me:** `status CHANGED BY currentUser() AFTER <start> BEFORE <end>`.
  For each hit, call `getJiraIssue` with `expand: "changelog"` and find the status
  change(s) **I** made in the window. From the `to` status, classify against
  `config.statuses`:
  - → released/done  ⇒ **released**
  - → in_review      ⇒ **moved to review** (if it was my own work) / **reviewed** (if I
    was moving someone else's ticket through review — i.e. I'm not its developer)
  - → in_progress    ⇒ **started**
  - → blocked        ⇒ note for the **Blockers** section
- **MRs opened (best-effort):** for the tickets above, call
  `getJiraIssueRemoteIssueLinks` and keep any GitLab/GitHub merge-request links created
  in the window. Also pick up MRs explicitly announced in your Slack messages (step 3).
  If nothing is clearly an MR, omit MRs — don't guess.

Keep a per-ticket record: `key, summary, action (released|reviewed|moved-to-review|
started|created), status`.

## 3. Gather yesterday's public Slack activity
Read `references/mcp-tools.md` for the tool set. **Public channels only. Never read a DM
(`D…`/`mpim`).** Resolve the user's `user_id` from `config.slack` (or via `slack_get_users`
if only the handle is set).

- If a **message-search-by-user-and-date** tool exists (official Slack server): search
  for messages authored by the user in the window, scoped to public channels.
- Otherwise (reference server): `slack_list_channels` → for each public `C…` channel,
  `slack_get_channel_history`, keep messages where `user == my id` and `ts` is in the
  window; for threads, `slack_get_thread_replies` to read the surrounding context. Don't
  scan more channels than needed — focus on engineering/team channels.

From what you find, extract only signal:
- **discussions** — substantive public threads I took part in → `discussed <topic> in #channel`.
- **assists** — where I helped someone → `assisted <person> with <thing>`.
- **promises** — anything I committed to do ("I'll send…", "I'll deploy…") → carries into
  **Today** as a follow-up.

Drop greetings, acks, "lgtm", "thanks", logistics.

## 4. Gather today's plan + blockers (current Jira state)
- **In progress (priority):** `assignee = currentUser() AND status IN (<in_progress>) ORDER BY updated DESC`.
- **To Do:** `assignee = currentUser() AND status IN (<todo>)`. Only surface these as
  *"may start"* if there is in-progress work; if there's no in-progress work, they're the
  real plan.
- **Review to pick up:** `status IN (<in_review>) AND assignee IS EMPTY`. For each, check
  the **developer** (per `config.developer_field`: `reporter`, the in-progress assignee
  from the changelog, or a custom field). **Exclude any where the developer is me** — we
  can't review our own work. If at least one survives, emit a single line: *"will try to
  pick up a ticket for review."*
- **Blockers:** `assignee = currentUser() AND status IN (<blocked>)`, plus any ticket I
  moved into a blocked status in step 2.

## 5. Write the update
Build the update per `references/standup-format.md`: `**Yesterday**`, `**Today**`,
`**Blockers**`. Apply the priority rules (in-progress before To Do; review-pickup line;
Slack promises as follow-ups). Keep it to one screen.

Present it **directly in the chat** for the user to read at standup. Do not post it to
Slack or anywhere else unless the user explicitly asks.

## Guardrails
- **Read-only.** Never transition a ticket, comment, or post a Slack message.
- **No DMs, ever.** Only public channels (`C…`).
- **Don't fabricate.** If a source is empty or a tool errors, say so briefly and continue
  with what you have — never invent tickets, MRs, or messages.
- **Don't review our own work** — enforce the developer check in step 4.
