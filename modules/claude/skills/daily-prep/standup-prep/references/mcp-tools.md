# Which MCP tools to use (+ the queries)

The Jira and Slack MCP servers are connected on the machine that runs this skill, so
their tools already arrive with full descriptions and parameter schemas — **don't
re-document those here, just read them off the connected tools.** This file exists only
to name the *exact tool to reach for at each step* (so you don't cast around) and to hold
the **queries and classification rules**, which are our logic, not the server's.

Tools are usually prefixed `mcp__<server>__…` (e.g. `mcp__atlassian__searchJiraIssuesUsingJql`).
Match by the names below; if one differs, list the connected tools and pick the obvious
equivalent.

## Jira — reach for these
| Step | Tool |
|---|---|
| Get `cloudId` (call once, reuse everywhere) | `getAccessibleAtlassianResources` |
| Confirm who I am | `atlassianUserInfo` |
| Find issues by JQL (every query below) | `searchJiraIssuesUsingJql` |
| Read one issue's changelog/comments | `getJiraIssue` with `expand: "changelog"` |
| MRs opened (best-effort) | `getJiraIssueRemoteIssueLinks` |

All Jira tools except `getAccessibleAtlassianResources` and `atlassianUserInfo` need the
`cloudId`. Read-only — never call a transition/comment/create tool.

## Slack — reach for these (public channels only)
Prefer a **message-search-by-user-and-date** tool if the connected Slack server has one
(scope it to public channels). If it doesn't, fall back to:
`slack_list_channels` → `slack_get_channel_history` → `slack_get_thread_replies`, plus
`slack_get_users` / `slack_get_user_profile` to resolve the user.

**Never read a DM.** Only pass channel IDs that start with `C` (public). Never pass a
`D…` (DM) or `mpim`/`G…` (group DM). Never call any post/reply/reaction tool.

---

## JQL — our queries (substitute `config.statuses` names + the computed window)
`currentUser()` resolves to the authenticated account, so filtering rarely needs the
accountId — but you need the display_name/accountId to spot **my** entries in a changelog.
Request only `summary,status,assignee,reporter,issuetype,updated`.

- Created by me: `reporter = currentUser() AND created >= <start> AND created < <end>`
- Transitioned by me: `status CHANGED BY currentUser() AFTER <start> BEFORE <end>`
- Released by me: `status CHANGED TO (<released>) BY currentUser() AFTER <start> BEFORE <end>`
- In progress now: `assignee = currentUser() AND status IN (<in_progress>) ORDER BY updated DESC`
- To Do now: `assignee = currentUser() AND status IN (<todo>)`
- Review to pick up: `status IN (<in_review>) AND assignee IS EMPTY`
- My blockers: `assignee = currentUser() AND status IN (<blocked>)`

For `previous_business_day` (Monday covers Fri+weekend), use **explicit dates** computed
from `config.timezone` rather than `-1d`, e.g. `created >= "2026-06-26" AND created < "2026-06-27"`.

## Classifying a transition (deterministic — do it the same way every run)
For each issue from "Transitioned by me", open its changelog (`getJiraIssue`,
`expand: changelog`), take the status-change entries **authored by me** inside the window,
and map each `to` status against `config.statuses`:

| `to` bucket | label | refinement |
|---|---|---|
| released | **released APP-…** | |
| in_review | **moved to review** if I'm the ticket's developer; **reviewed** if I'm not | developer = `config.developer_field` |
| in_progress | **started APP-…** | |
| blocked | (Blockers section, not Yesterday) | |

"Developer" (for the review labelling and the review-pickup exclusion) is resolved per
`config.developer_field`: `reporter`, the assignee while it was in-progress (from the
changelog), or a custom field id. **Never offer to review a ticket whose developer is me.**
