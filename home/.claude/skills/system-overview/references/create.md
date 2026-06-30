# Create flow

Playbook for `/system-overview create [<path>]` (and the bare/path-only invocations, which fall through to this flow for backward compatibility). Produces a fresh `docs/system-overview/` folder under the target directory.

The shared context — operating principles, target-directory resolution, output templates — lives in [../SKILL.md](../SKILL.md). This file is the create-specific workflow only.

## Phase 1 — Initial sweep (you, the main agent)

Operate inside the target directory. Read the obvious top-level files:
- `README*`
- The manifest file (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, etc.)
- Top-level directory listing
- Any obvious config: `docker-compose.yml`, `.env.example`, `Makefile`, `Procfile`

From this — without spawning anything yet — produce these pieces of the final output yourself, since they don't need a focused investigator:

- **Overview** — one paragraph, no more. Purpose, core function, what it sits between.
- **Core frameworks & packages** — short bulleted list. The libraries a new dev *must* know to navigate. Skim the manifest, then do a quick `grep` of imports to drop dead deps. Skip standard utility libs (lodash, dotenv, etc.) unless they're load-bearing.
- **External services this repo depends on** — bulleted list, no per-service "why". Derive from SDK imports, env vars (`*_API_KEY`, `*_URL`), and config.
- **Module inventory** — list the top-level subsections (e.g., `api/`, `db/`, `services/orchestrator/`, `prompts/`). Note which look complex or core (you'll spawn `domain-investigator` instances for those in Phase 2).

Then form **detection signals** for the deep-dive dispatch:
- API present? (look for routes/controllers/handlers — see [detection.md](detection.md))
- DB present? (look for ORM imports, schema files, migrations dir — see [detection.md](detection.md))
- LLM present? (look for `anthropic`/`openai`/`langchain` imports, `prompts/` dir — see [detection.md](detection.md))
- Queues / async messaging present? (look for queue-library imports, worker entry points, cron registrations, pub/sub topics — see [detection.md](detection.md))
- Which modules look complex enough to warrant a focused `domain-investigator`?

Read [detection.md](detection.md) once at the start of this phase if you need the catalog of patterns.

## Phase 2 — Deep-dive dispatch (parallel subagents)

Spawn `Explore` subagents in **a single message with multiple `Agent` tool calls** so they run in parallel. Spawn only the ones that apply:

| Subagent | Spawn when | Briefing | Returns |
|---|---|---|---|
| `api-investigator` | API detected | [../agents/api-investigator.md](../agents/api-investigator.md) | Endpoints section + flagged conventions + flagged notable workflows in handlers |
| `data-investigator` | DB detected | [../agents/data-investigator.md](../agents/data-investigator.md) | Database section + flagged conventions + flagged notable workflows in models/queries |
| `llm-investigator` | LLM detected | [../agents/llm-investigator.md](../agents/llm-investigator.md) | LLM flow section + flagged notable workflows in LLM-output handling |
| `queues-investigator` | Queue / pub-sub / scheduler detected | [../agents/queues-investigator.md](../agents/queues-investigator.md) | Async messaging section + flagged conventions + flagged notable workflows in job handlers |
| `domain-investigator` | once per complex/core module from sweep | [../agents/domain-investigator.md](../agents/domain-investigator.md) | Notable workflows from that module + flagged conventions seen there |

For each subagent you spawn:
1. Read its briefing file from `../agents/`.
2. Pass the briefing's content as the subagent's prompt, plus the subsection-specific scope (which paths/modules this agent should focus on).
3. Target the built-in **`Explore`** subagent. Both supported harnesses ship it:
   - **Claude Code**: `Agent` tool with `subagent_type: "Explore"`.
   - **Cursor**: `Task` tool targeting the built-in `Explore` subagent.

A repo with two heavy domain modules gets **two** parallel `domain-investigator` calls, each scoped to one module. Don't try to make a single domain-investigator do both — give each a focused scope.

## Phase 2.5 — Diagram dispatch (you, the main agent)

After the Phase 2 agents return, dispatch the `diagram-investigator`. This phase is **serialized** — it depends on the others' outputs.

1. Collect the **notable endpoints** flagged by `api-investigator` and the **notable workflows** flagged by `domain-investigator` (and any flagged inside `llm-investigator` or `queues-investigator` output, when present). These form the candidate list.
2. Spawn `diagram-investigator` *once*, passing:
   - The candidate list (title, entry-point file:line, originating blurb)
   - The target directory as scope
   - The briefing file [../agents/diagram-investigator.md](../agents/diagram-investigator.md)
3. Target the built-in **`Explore`** subagent (Claude Code: `Agent` tool with `subagent_type: "Explore"`; Cursor: `Task` tool with the built-in `Explore` subagent).

The agent returns one structured block per diagram it decided to produce. If the candidate list is empty (no notable endpoints or workflows), **skip this phase entirely** — no `diagram-investigator` call, no `diagrams/` folder, no Diagrams section in the README.

## Phase 3 — Synthesis (you, the main agent)

When all subagents return:

1. **Assemble the primary outputs** into the template (see "Output template" in [../SKILL.md](../SKILL.md)). Drop sections whose signal was absent (no LLM section in a non-AI repo, etc.).
2. **Roll up flagged conventions** from all agents. Apply the *most-of-the-time* rule: a convention surfaces only if multiple agents reported it or one agent saw it pervasively. If any agent flagged a convention as inconsistent, say so on that line. Don't catalog exceptions.
3. **Roll up flagged notable workflows** + the `domain-investigator`'s primary list. De-duplicate. Order by how central they look.
4. **Refine the architecture diagram.** Now that the agents have surfaced the actual layers, data flow, and external touchpoints, draw the diagram. Apply the multi-diagram rule from [diagrams.md](diagrams.md): if it's getting bloated (>~12 nodes or >3 layers), split into a simplified high-level + one or more focused breakdowns of the most important subsystem.
5. **Create the docs folder.** Run the create script via Bash. The skill may be installed under Claude Code or Cursor (global or project) — resolve its location, then call `scripts/create.sh`:
   ```sh
   SKILL_DIR="$(ls -d ~/.claude/skills/system-overview ~/.cursor/skills/system-overview .cursor/skills/system-overview .claude/skills/system-overview 2>/dev/null | head -n1)"
   bash "$SKILL_DIR/scripts/create.sh" <target-dir>
   ```
   It ensures `<target-dir>/docs/system-overview/` exists (idempotent — re-running over an existing folder is fine) and prints the absolute folder path to stdout. Capture that path. The folder is intentionally a tracked location; no `.gitignore` change is needed and none is made.
6. **Write the files.** Use the Write tool to create each markdown file inside the returned folder, following the "Output template" in [../SKILL.md](../SKILL.md). Skip files whose section was absent (no `llm.md` in a non-AI repo, etc.). Always write `README.md`. Order of operations:
   - **Diagrams first** (only if Phase 2.5 produced any). For each structured block the `diagram-investigator` returned, write the diagram file to `diagrams/sequence/<short-name>.md` or `diagrams/flowcharts/<short-name>.md` (subdirs auto-create). Use the "Diagram file template" in [../SKILL.md](../SKILL.md).
   - Then write `endpoints.md`, `database.md`, `llm.md`, `queues.md`, `notable.md`, splicing in cross-reference links to any diagrams that exist for the relevant notable endpoint or workflow.
   - Finally write `README.md`, including the `Diagrams` section if any diagrams were produced.
7. **Report briefly in chat.** One or two sentences: where the folder is and which files were written (mention diagram count if non-zero). Do NOT dump the markdown into the chat — the output is on disk now.
