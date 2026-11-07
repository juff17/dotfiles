# Elastic: querying logs and building Discover links

Elastic holds history that `kubectl logs` cannot reach: logs from pods that are
gone, from every service at once, and from before the watch started. Use it
for shareable links and for deep dives.

## 1. Check that an Elastic MCP server is connected

Look for Elastic tools in this session. Search the deferred tool list with
ToolSearch (`elastic esql`, `kibana`, `execute_esql`, `list_indices`) or run
`claude mcp list`. Either of these counts:

| Server | Typical tool names | Notes |
|--------|--------------------|-------|
| Kibana Agent Builder MCP (current) | `platform.core.execute_esql`, `platform.core.search`, `platform.core.list_indices`, `platform.core.get_index_mapping`, `observability.get_logs`, `observability.get_log_groups`, ... | Elastic 9.2+ or Serverless. Tool names may show with `_` in place of `.`, and prefixed with the server name. |
| `mcp-server-elasticsearch` (legacy) | `esql`, `search`, `list_indices`, `get_mappings` | Deprecated by Elastic. Works for queries, has no observability tools. |

### Not connected

Stop and ask the user to connect it. Do not fall back to guessing links.
Give them this:

- The current option is the Kibana Agent Builder MCP endpoint at
  `<KIBANA_URL>/api/agent_builder/mcp` (with a space: `<KIBANA_URL>/s/<space>/api/agent_builder/mcp`).
  Setup docs: https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/mcp-server
- It needs an API key with `feature_agentBuilder.read` and read access to the
  log indices: https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/mcp-server-api-keys
- Add it to Claude Code:

  ```sh
  claude mcp add --transport http elastic "$KIBANA_URL/api/agent_builder/mcp" \
    --header "Authorization: ApiKey $ELASTIC_API_KEY"
  ```

- Restart the session (or `/mcp`) so the tools load.

If the user cannot install it, you can still build links from a query they
confirm works, but say the links are untested.

## 2. Find the Kibana URL and space

Links point at Kibana, not Elasticsearch. Take the URL from, in order:

1. The MCP server's URL (`claude mcp get <name>`), minus `/api/agent_builder/mcp`.
2. `KIBANA_URL` in the environment.
3. The repo (runbooks, README, alert configs, dashboards links).
4. Ask the user. Offer to save it to the project's CLAUDE.md so you do not ask again.

The legacy server points at Elasticsearch, so its URL is not the Kibana URL.

## 3. Find the logs and the field names

Never assume field names. Check them once per session.

1. `list_indices` and pick the log data streams (`logs-*`, `filebeat-*`,
   or a team-specific pattern).
2. `get_index_mapping` on one of them, or run a sample:
   `FROM logs-* | WHERE @timestamp > NOW() - 15 minutes | LIMIT 5`.
3. Find the fields that identify the service and environment. Common ECS names:

| Meaning | Common fields |
|---------|---------------|
| Service | `service.name`, `kubernetes.deployment.name`, `kubernetes.labels.app`, `container.name` |
| Environment | `service.environment`, `kubernetes.namespace`, `orchestrator.cluster.name`, `data_stream.namespace` |
| Severity | `log.level` (case varies: `error`, `ERROR`) |
| Message | `message`, `error.message`, `error.type`, `error.stack_trace` |
| Request tracing | `trace.id`, `transaction.id`, `http.request.id`, or an app field such as `request_id` |
| HTTP | `http.response.status_code`, `url.path`, `http.request.method` |
| Where it ran | `kubernetes.pod.name`, `host.name`, `container.id` |
| Version | `service.version`, `container.image.tag` |

4. Confirm the filter returns the right service:
   `FROM logs-* | WHERE <service filter> AND @timestamp > NOW() - 1 hour | STATS count = COUNT(*) BY <env field>`.

## 4. Query with ES|QL

Prefer ES|QL. The same query you run through the MCP becomes the Discover
link, so the link shows exactly the evidence you looked at. Keep queries
bounded: always a time range and a `LIMIT`.

Useful shapes:

```esql
// Error volume over time (find when it started)
FROM logs-*
| WHERE service.name == "payments-api" AND log.level IN ("error", "ERROR")
| STATS errors = COUNT(*) BY bucket = BUCKET(@timestamp, 1 minute)
| SORT bucket

// Distinct error messages, most common first
FROM logs-*
| WHERE service.name == "payments-api" AND log.level IN ("error", "ERROR")
| STATS count = COUNT(*), first = MIN(@timestamp), last = MAX(@timestamp) BY error.type, error.message
| SORT count DESC
| LIMIT 20

// Errors by pod or version (one bad pod? one bad release?)
FROM logs-*
| WHERE service.name == "payments-api" AND log.level IN ("error", "ERROR")
| STATS count = COUNT(*) BY kubernetes.pod.name, service.version

// One request end to end, across services
FROM logs-*
| WHERE trace.id == "4bf92f3577b34da6a3ce929d0e0e4736"
| KEEP @timestamp, service.name, log.level, message, error.message
| SORT @timestamp
```

Time in ES|QL queries run through the MCP: use explicit bounds
(`@timestamp >= "2026-10-08T14:00:00Z" AND @timestamp < "2026-10-08T14:30:00Z"`).
In Discover links, leave the time out of the query; the link's time range
does that job (see below).

When ES|QL is not available (old cluster, legacy server without it), use the
search tool with query DSL, and build KQL links instead.

If the Agent Builder observability tools are present, use them for the
heavy lifting: `observability.get_log_groups` (group errors by type),
`observability.get_log_change_points` and `observability.run_log_rate_analysis`
(when and why volume changed), `observability.get_traces` (one trace's logs,
spans and errors), `observability.get_alerts`. Still confirm key findings with
an ES|QL query, because only queries become links.

## 5. Build Discover links

Use `scripts/discover_link.py`. It pins every link to an absolute UTC time
range, so the link shows the same logs next week. Relative ranges ("last 30
minutes") show different logs every time they are opened. Never share them.

```sh
python3 <skill-dir>/scripts/discover_link.py \
  --kibana https://kibana.example.com --space prod \
  --from 2026-10-08T13:45:00Z --to 2026-10-08T14:30:00Z \
  --esql 'FROM logs-* | WHERE service.name == "payments-api" AND log.level == "error" | KEEP @timestamp, kubernetes.pod.name, message, error.message | SORT @timestamp'
```

- **ES|QL mode** (`--esql`) needs no data view and shows only the `KEEP`
  columns. Use it by default.
- **KQL mode** (`--kql` + `--data-view <id>`) needs the data view's saved
  object id (not its name). Use it only when the team works in KQL or ES|QL is
  not available. `--columns` sets the visible columns.
- **Short links** (`--short`): if `KIBANA_API_KEY` is set (an API key allowed to
  create short URLs), the script also calls Kibana's short URL API and prints a
  `/r/s/<slug>` link. Short links are easier to paste and survive SSO
  redirects that drop URL fragments. The short URL API is a technical preview;
  if it fails, use the full link.
- **Time window**: pad 5 to 15 minutes before the first relevant line, so the
  reader sees the normal state before the problem. End shortly after the last
  relevant line, or after recovery.
- **Run the query through the MCP first**, with the same time bounds, and
  check it returns what the link claims. Never share a link you have not
  checked.

### Limits on "permanent"

- A link only works while the data is retained. Check the index lifecycle
  (ILM or data stream retention) if the user needs the link for an incident
  review weeks later, and warn them when retention is short (for example 7 days).
  For evidence that must outlive retention, copy the key lines into the report.
- Links open only for people with Kibana access to that space and index.
