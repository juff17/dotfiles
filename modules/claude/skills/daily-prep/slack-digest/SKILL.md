---
name: slack-digest
description: Produce the morning digest of what happened in Slack yesterday, read through the Slack MCP and presented in chat. Reads only the channels in config.yaml and surfaces decisions, pending decisions, open questions, unaddressed cross-team requests, and technology changes / updates — tailored to an audience (e.g. Engineering, Product, Sales, Operations) or topics the user names, or a general overview if they name none. Use when the user asks for the Slack daily update / digest / "what happened yesterday".
---

# Slack Daily Digest

Build a high-signal digest of yesterday's Slack activity and present it **in the chat**.
Report **outcomes, not deliberation**.

You are the orchestrator. Per-group **subagents** read Slack through the Slack MCP and do
the heavy summarizing; you assemble the result. Keep your own context thin. The Slack MCP
server is connected at runtime, so its tools already carry full descriptions/schemas —
`references/mcp-tools.md` only says **which** tool to reach for at each step. **Read-only:
never post, reply, react, or write a canvas, and never read a DM.** Write no files — the
digest goes straight into your reply.

## 0. Audience and focus
Take both from the user's prompt:
- **Audience** — who the digest is for, e.g. "for Engineering", "Product audience",
  "for the sales team". If none is given, use **general**: a broad, cross-functional
  overview of what mattered across the organization.
- **Focus** (optional) — specific things they want updates on, e.g. "anything about the
  checkout launch" or "just infra changes". If none is given, there is no focus.

Don't ask for either — fall back to the defaults and move on.

## 1. Load config and compute the window
Read `config.yaml` from this skill's directory. If it is missing, stop and tell the user
to copy `config.example.yaml` to `config.yaml` and fill in their channels — never guess
channels.

Compute the **time window** from `timezone` + `lookback` (check today's real date with
`date` in that tz — don't assume):
- `yesterday` → the previous calendar day.
- `previous_business_day` → the previous calendar day, except on **Monday** cover
  **Fri 00:00 → Mon 00:00** (Fri + weekend).

The digest date is the window's start date (`YYYY-MM-DD`).

## 2. Summarize each group (fan out)
For **each** entry in `groups`, spawn a `group-summarizer` subagent — all in one batch so
they run in parallel — and give each one, inline in its prompt:
- the group's `name`, `channels`, `members` (if any), `focus`, and `ignore_bot_messages`;
- the window (start/end with timezone) and `noise.thread_lookback_days`;
- the `noise.drop_message_patterns`;
- the **audience** and the user's **focus** from step 0 (or "none");
- the absolute path to this skill's `references/mcp-tools.md`.

The audience and focus steer what each subagent treats as signal. Each subagent fetches
its own channels through the Slack MCP and returns a JSON object with `headline`,
`overview` bullets, a prose `summary`, `unaddressed_requests`, and `errors`.

Meanwhile, handle `announcements` yourself (it's small): read those channels for the same
window via the Slack MCP (same tools as `references/mcp-tools.md`) and pull out actions
and notices — anything the reader must DO (technology changes / updates, credential
rotations, required migrations) plus any company-wide notice (policy change, all-hands
move). Announcements are typically company-wide, not tied to one team.

## 3. Assemble (narrative)
Read `references/digest-format.md` and build the digest from the per-group objects:
- Start with the H1 from `title`, substituting the digest date.
- Write **"## Across the Organization"** — a 3-5 sentence synthesis you author from the
  groups' `headline`s: the through-line, what's converging, the overall direction.
  Prose, not a list. Optimistic-or-neutral, professional.
- Add the **"Action for everyone"** blockquote with every announcement action + any
  company-wide notice. When there is more than one item, list them as bullets inside the
  blockquote (one `> - ` per item); a single item stays inline. Omit the blockquote if
  there are none.
- Emit one **"## <Group name>"** section per group, carrying its `overview` bullets and
  prose `summary` through as written (the subagent already synthesized them — don't
  re-expand the summary into a per-bullet walk). The summary is a high-level through-line,
  not a restatement of the Overview; the Overview should be ~5-7 high-impact bullets, not
  an exhaustive list. Ensure every `unaddressed_request` shows as a bolded Overview bullet
  and is named in the summary.
- Omit any group whose findings are empty. Do not repeat the same item across groups.
- Never surface read errors inside the digest itself.

If every subagent fails to read Slack (e.g. the MCP isn't connected or authorized), stop
and report that — never fabricate a digest.

## 4. Present
Reply with the digest markdown directly in the chat. After it, outside the digest:
1. If any subagent returned `errors` (channels that couldn't be found or read), one short
   line naming them so the user can fix `config.yaml`.
2. Always close with a one-line offer to narrow it, e.g.:
   *"Want this narrower? Re-run with an audience (Engineering, Product, Sales,
   Operations…) or tell me the topics you want updates on."*

## Notes
- Never widen scope beyond the channels in `config.yaml`.
- Keep the whole digest skimmable in under ~5 minutes.
