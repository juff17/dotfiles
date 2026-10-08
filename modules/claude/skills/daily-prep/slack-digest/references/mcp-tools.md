# Which Slack MCP tools to use

The Slack MCP server is connected on the machine that runs this skill, so its tools
already arrive with full descriptions and parameter schemas — **don't re-document those
here, just read them off the connected tools.** This file only names the *tool to reach
for at each step* and the fetch rules, which are our logic, not the server's.

Tools are usually prefixed `mcp__<server>__…`. Match by the names below; if one differs,
list the connected tools and pick the obvious equivalent.

## Fetching one channel for the window
1. **Resolve the channel** — `slack_list_channels` (or a channel-search tool) to map the
   configured `#name` to its ID. Not found → record `#name: not found` in `errors` and move on.
2. **Find activity in the window** — prefer a **message-search** tool scoped to the
   channel and dates (e.g. `in:#name after:<day before start> before:<end date>`). Search
   returns thread replies too, so it catches old threads that came alive in the window.
   Without search, fall back to `slack_get_channel_history` from
   `window start − thread_lookback_days` to `window end`, keeping parents that were posted
   in the window or whose latest reply is in it.
3. **Read the threads** — `slack_get_thread_replies` for every thread with activity in the
   window. Replies before the window are **context** (background only); messages inside
   it are **summary targets** (what you report).
4. **Resolve people** — `slack_get_users` / `slack_get_user_profile` to turn user IDs into
   names, and to match the group's `members` (by @handle, real name, or display name).
5. **Permalinks** — use the permalink the tool returns. If none, build it as
   `https://<workspace>.slack.com/archives/<channel id>/p<ts without the dot>`.

## Rules
- **Read-only.** Never call any post / reply / reaction / canvas tool.
- **Never read a DM.** Only read channel IDs for the channels in `config.yaml`; never a
  `D…` (DM) or group DM.
- Skip system events (joins, leaves, topic/purpose/name changes) and empty messages.
- When `ignore_bot_messages` is true, skip bot / app / webhook posts.
- Drop any message matching a `noise.drop_message_patterns` entry (case-insensitive,
  `*` is a wildcard).
- If a Slack call fails, record `#name: <error>` in `errors` — never invent content.
