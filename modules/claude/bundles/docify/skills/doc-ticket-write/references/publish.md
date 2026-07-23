# Publishing a ticket

This file is the provider-agnostic mechanics of pushing
a ticket into whatever tracker is connected — Jira, Linear, GitHub, Asana,
Monday, ClickUp, Azure DevOps. The steps are the same everywhere; only the small
**quirks table** at the bottom differs by provider.

## Pick the provider

Detect it from the connected MCPs rather than asking by default:

- **Discover** which tracker tools are connected — try `ToolSearch` for
  `"create issue"`, `"create task"`, `"create work item"`.
- **One clear match** (only one tracker connected) → use it, no question.
- **Several connected** (e.g. Jira *and* Linear) → ask which one, **once per
  session**, and reuse that choice for every ticket after.
- **None connected** → tell the user and offer the Markdown fallback:
  > I don't see an issue-tracker MCP (Jira, Linear, GitHub…) connected, so I
  > can't file this ticket directly. I can write it as a Markdown file instead —
  > want that, or would you rather connect one first?

Skip detection only if the user already named a provider.

## Create a ticket

1. **Discover the tools by capability, not by name.** Tool names vary by server
   (`createJiraIssue`, `create_issue`, `issue_write`, `create_tasks`,
   `create_item`, `create_task`, `wit_create_work_item`). Find the create / get /
   update / search tools with `ToolSearch` and read their input schemas — the
   schema is the source of truth for required fields.
2. **Resolve the container.** Every tracker needs one before you can create — a
   Jira project, Linear team, GitHub `owner/repo`, Asana workspace/project,
   Monday board, ClickUp list, Azure project. Look it up with the provider's
   list/search tool or ask - don't guess a key.
3. **Create with title + Markdown body.** Summary in `[<repo_name>] <description>`
   form. The ticket body (user story → requirements → acceptance criteria) as a
   Markdown string. Some trackers require a work-item **type** on create — default
   to `Task` (or the project's unit-of-work convention) - see the quirks table.
4. **One create call per ticket**, even when a request produced several tickets.
5. **Link relationships; never write them into the body.** If the ticket depends
   on, blocks, or belongs under something, set it with the tracker's own
   link/relation field (see the quirks table) — that's the only place a ticket
   key goes. If there's no real ticket to point at, leave the relationship out
   rather than describing it in prose.
6. **Report** each created ticket's key and link.

## Update a ticket

1. **Fetch first** with the get tool — never overwrite blind. Read its current
   summary, type, and description before touching anything.
2. **Change only what changed**, in place; keep the edit minimal. Re-render any
   section that shifted (per the SKILL.md template), and propagate to the
   acceptance criteria so nothing stale is left behind.
3. **Report** what changed and the link.

See [`update.md`](update.md) for the full cautious update flow; the above is just
its publishing half.

> **Scope note.** This skill writes and publishes ticket *content*. It does not
> drive workflow: setting **status** (transitions/states) and **custom fields**
> is per-tracker and out of scope. If the user explicitly asks for a status
> change, treat that as a separate per-tracker step, not part of authoring.
> **Relationship links are the exception** — they carry content the body is no
> longer allowed to hold, so setting them is part of publishing.

## Provider quirks

Everything above is shared. These are the only per-provider differences — add a
row when you wire up a new tracker:

| Provider | Container | Type on create | Body | Relations |
|---|---|---|---|---|
| Jira | project key | **required** — default `Task`/`Story` | Markdown → ADF | issue links (`blocks`/`relates to`), parent for epic |
| Azure DevOps | project | **required** work-item type — default `Task` | Markdown → `System.Description` | work-item link types (`Predecessor`/`Parent`) |
| Linear | team id | none | Markdown | issue relations, `parentId` |
| GitHub Issues | `owner/repo` | optional | Markdown | sub-issues; `blocked by` via project fields |
| Asana | workspace/project gid | none | `name` + `notes`/`html_notes` | task dependencies, subtasks |
| Monday | board id | none | ⚠️ no body field — put detail in a long-text column or an update | dependency column |
| ClickUp | list id | none | Markdown | task dependencies (`waiting_on`/`blocking`) |

Status transitions and custom fields are per-provider and out of scope (see the
scope note above).
