---
name: system-overview
description: Generates a high-level system overview wiki for a codebase — repo purpose, core frameworks/packages, architecture (with mermaid), endpoints with shared response patterns and Swagger pointers, database layout, LLM flow if present, external service dependencies, and notable workflows worth deeper investigation. Invoke ONLY when the user explicitly runs the /system-overview slash command. Do NOT invoke for general "explain this code", "what does this repo do", or other walkthrough phrasings — only when the user types /system-overview.
---

# System overview

Produces a high-level system overview wiki for a codebase. The output is written to `docs/system-overview/` under the **target directory** (the cwd by default, or a path the user passes as an argument). The folder is a fixed, tracked path. The first run **creates** it; once it exists, later runs **update** it in place — refreshing only what materially changed rather than regenerating from scratch. The wiki is meant to be skimmed by someone trying to build a mental map of the repo before they start reading code in depth.

## Supported harnesses

Runs on both **Claude Code** and **Cursor** (2.4+). Both surface the skill via `/system-overview` and both ship a built-in `Explore` subagent. The only harness-specific bits inside this skill are:
- The subagent-dispatch tool — Claude Code's `Agent` vs Cursor's `Task` (both invoked the same way).
- The on-disk install path — when a subcommand workflow needs to invoke a script, resolve any of `~/.claude/skills/`, `~/.cursor/skills/`, `.cursor/skills/`, `.claude/skills/`.

## When to use

Only when the user explicitly invokes `/system-overview`. Do not trigger on phrases like "explain this codebase" or "what does this repo do" — those are different requests.

## What this skill is (and isn't)

**It is**: a high-level wiki that orients the reader. Think "tour guide", not "manual". Skim-friendly, pointer-rich, opinionated about what's worth a closer look later.

**It isn't**: exhaustive documentation. The reader will go read the code; you are giving them the map. Authoritative sources (Swagger, schema files, infra manifests) own the details — point to them rather than duplicate them.

## Operating principles

These apply to the main agent and to every subagent it spawns.

1. **Build a mental map, not a manual.** The reader will go read the code. You're orienting them — what the parts are, how they fit, where to look.
2. **Skim what's standard, dwell on what's unique.** Standard practice (e.g., "endpoints return `id` on resources") gets a single bullet and no explanation. Custom logic (ranking, selection, transformation, prompt-output reshaping) gets a *what* and a *why*, with a file:line link.
3. **Infer the *why* from code comments first.** Comments often hold the rationale that the code itself can't show. If a comment captures the reason concisely, quote it.
4. **Don't duplicate authoritative sources.** Swagger has the schemas; you have the patterns. Schema files have the columns; you have the meanings. Migrations have the history; you have the shape.
5. **Omit sections that don't apply.** No DB? No "Database" section. No LLM? No "LLM flow" section. Don't fabricate or pad to fill the template.
6. **Conventions only if they hold *most of the time*.** If a pattern is broken often, say it's inconsistent and move on. Do not catalog every place where a convention is or isn't followed.
7. **Cite files as markdown links — relative to the rendered file's location, not the project root.** All output lives inside `docs/system-overview/`, so a bare `src/file.ts#L42` will resolve *inside* the docs folder and 404. Use the right prefix for where the link will render:
   - **Section files** (`README.md`, `endpoints.md`, `database.md`, `llm.md`, `queues.md`, `notable.md`) sit two levels inside the project root (`docs/system-overview/`). Use `../../`: `[file.ts:42](../../src/file.ts#L42)`.
   - **Diagram files** (`diagrams/sequence/<name>.md`, `diagrams/flowcharts/<name>.md`) sit four levels inside the project root (`docs/system-overview/diagrams/<kind>/`). Use `../../../../`: `[file.ts:42](../../../../src/file.ts#L42)`.
   - **Links between docs in the same folder** (e.g., README → endpoints.md) stay relative: `[Endpoints](endpoints.md)`. No prefix needed.
   - **Links from a diagram file back to the README** use `../../README.md` (two levels — README is at `docs/system-overview/README.md`, diagram is at `docs/system-overview/diagrams/<kind>/<name>.md`).

## Subcommands

The optional first keyword — `create` or `update` — is **only an input**, not a flow selector. It does **not** decide which workflow runs; the **Routing** section below does, based purely on whether the wiki already exists. A bare invocation (no keyword) or an unrecognized first argument is treated as legacy syntax: the optional first argument becomes the target-directory path (resolution rules under "Target directory").

| Keyword | Intent (subject to Routing) |
|---|---|
| `create` | The user expects a fresh wiki. Honored only if Routing returns `create` (i.e. no `docs/system-overview/` exists yet). |
| `update` | The user expects an in-place refresh. Routing returns `update` whenever `docs/system-overview/` exists. |

Whatever the keyword, resolve the target directory next, then follow **Routing** — it is the sole authority on create vs update.

## Target directory

Decide which directory you're documenting from the user's invocation. The path argument (if present) is the last positional argument; the keyword (if present) precedes it. Resolving the path is all this step does — it does **not** pick create vs update (that's Routing, next).

- `/system-overview` → the current working directory.
- `/system-overview <path>` → resolve `<path>` as below (legacy syntax — `<path>` is the target).
- `/system-overview create` / `/system-overview update` → the current working directory.
- `/system-overview create <path>` / `/system-overview update <path>` → resolve `<path>` as below.

To resolve `<path>`: accept a repo name (resolved relative to cwd), an absolute path, or a `~`-prefixed path. If it doesn't resolve to an existing directory, stop and ask the user.

The resolved path is the **target directory**. Every subagent's scope is rooted there, and the `docs/system-overview/` folder lives inside it.

## Routing — mandatory, before any workflow

After resolving the target directory, determine the route **only** by running `scripts/route.sh` against it. Do **not** decide from the user's keyword, by inspecting the directory yourself, or by inference — the `SL_SYSTEM_OVERVIEW_ROUTE=` line is the sole authority.

```sh
SKILL_DIR="$(ls -d ~/.claude/skills/system-overview ~/.cursor/skills/system-overview .cursor/skills/system-overview .claude/skills/system-overview 2>/dev/null | head -n1)"
bash "$SKILL_DIR/scripts/route.sh" <resolved-target-dir>
```

The script prints exactly two lines:

```
SL_SYSTEM_OVERVIEW_ROUTE=<create|update>
SL_SYSTEM_OVERVIEW_DOCS_DIR=<absolute path to docs/system-overview>
```

- `SL_SYSTEM_OVERVIEW_ROUTE=update` → read [references/update.md](references/update.md) and follow it. Capture `SL_SYSTEM_OVERVIEW_DOCS_DIR` — that existing folder is the wiki you refresh in place.
- `SL_SYSTEM_OVERVIEW_ROUTE=create` → read [references/create.md](references/create.md) and follow it.

**Absolute rule: if `docs/system-overview/` exists, the route is `update` — even if the user typed `create`. The only way to reach `create` is for the folder not to exist.** To deliberately start over, the user deletes the folder and re-runs. The script decides on existence alone and never consults the keyword, so the keyword cannot override it.

## Output template

The wiki is split across multiple markdown files in the `docs/system-overview/` folder. `README.md` is always written and serves as the index/home page; the others are written only when their signal was present.

**Navigation requirements — non-negotiable, every file must have these:**
- `README.md` **must** include the `## Index` section listing every other doc that was written. Without it the reader has no way to discover the other pages.
- Every per-section file (`endpoints.md`, `database.md`, `llm.md`, `queues.md`, `notable.md`) **must** start with the back-link as its literal first line: `[← back to overview](README.md)`. No blank line before it.
- Every diagram file (`diagrams/sequence/<name>.md`, `diagrams/flowcharts/<name>.md`) **must** start with: `[← back to overview](../../README.md)` — two `..` segments because diagram files sit two levels below the docs root.

If you find yourself writing a file without one of these, stop and add it before moving on.

### `README.md` — always written

```
# System overview: <repo name>

## Overview
<1-paragraph summary: purpose, core function, who/what it sits between>

## Core frameworks & packages
<short bulleted list — non-exhaustive, just the core ones>

## Architecture
<simplified high-level mermaid flowchart>
<2-4 sentences explaining it>
<if complex: a second focused mermaid breaking down the most important subsystem>

## Infrastructure
<2-3 sentences max — runtime, where deployed if obvious from configs; flag for follow-up if user wants depth>

## External services this repo depends on
<bulleted list — service name + which env vars/configs reference it; no "why" prose>

## Diagrams
<Include this section only if Phase 2.5 produced diagrams. Two subsections: Sequence and Flowcharts. One bullet per diagram with a one-line description. Omit a subsection if it would be empty.>

### Sequence
- [Send message](diagrams/sequence/send-message.md) — SSE stream lifecycle from POST through response completion.
- [Search](diagrams/sequence/search.md) — query → planner → ranker → response.

### Flowcharts
- [Search ranking](diagrams/flowcharts/search-ranking.md) — blended-score logic with per-intent branches.

## Index
<This section is **mandatory** — every README.md must include it. It's the reader's only navigation aid; without it they don't know other documents exist. Include one bullet per file that was actually written.>
- [Endpoints](endpoints.md) — <one-line summary of what this doc covers; omit this bullet only if endpoints.md was not written>
- [Database](database.md) — <one-line summary; omit only if database.md was not written>
- [LLM flow](llm.md) — <one-line summary; omit only if llm.md was not written>
- [Async messaging](queues.md) — <one-line summary; omit only if queues.md was not written>
- [Worth knowing about](notable.md) — <one-line summary; omit only if notable.md was not written>
```

### `endpoints.md` — when API was detected

```
[← back to overview](README.md)

# Endpoints

## Common response patterns
<shared shapes / wrappers / pagination envelopes / error format / id-on-resource convention>

## Endpoint list
<compact table: METHOD | path | one-line purpose>

## Notable endpoints
<for complex / less-straightforward endpoints only — endpoint + brief description of its input and output shape + non-obvious behavior + file:line link. If a diagram exists for this endpoint, append diagram links on the same entry: `→ [Sequence](diagrams/sequence/<name>.md) · [Flow](diagrams/flowcharts/<name>.md)` (include only whichever ones the diagram-investigator produced).>

> Full request/response schemas: see Swagger at [<path or URL>](<path or URL>)
```

### `database.md` — when DB was detected

```
[← back to overview](README.md)

# Database

<if >12 entities: simplified erDiagram (entity names + relationships, no fields) first, then the full diagram>
<otherwise: the full erDiagram showing every entity and every column>

<one-line description per entity covering meaning + role in the system>

<short list — how key relations are used at a high level>

<flag any complex modeling choices: soft deletes, denormalizations, polymorphic refs>
```

### `llm.md` — when LLM usage was detected

```
[← back to overview](README.md)

# LLM flow

<mermaid flowchart of the pipeline>
<per-prompt: name, role, brief input, brief output, file:line link>
<note any non-standard transformation of LLM output beyond plain storage>
```

### `queues.md` — when queues / pub-sub / scheduled jobs were detected

```
[← back to overview](README.md)

# Async messaging

## Infrastructure
<broker(s), client library, connection config pointer (env vars / config file path) — 1-3 lines>

## Queue / topic / schedule inventory
<compact table: name | type (queue / topic / schedule) | producer(s) | consumer(s) | purpose>

## Notable handlers
<for complex handlers only — name + brief description of orchestration / reliability mechanics + file:line link. If a flowchart exists for this handler, append on the same entry: `→ [Flow](diagrams/flowcharts/<name>.md)` (include only whichever ones the diagram-investigator produced). Skip simple "do one thing" handlers.>

## Reliability posture
<1-3 lines on retry/backoff defaults, DLQ wiring, and idempotency conventions. Skip this section entirely if everything is library default.>
```

### `notable.md` — always written when there's anything to put in it

```
[← back to overview](README.md)

# Worth knowing about

## Notable workflows / unique logic
<for each: short title, 1-3 line description of what it does and *why* (quote a code comment if it captures it), file:line link. If a flowchart exists for this workflow, append `→ [Flow](diagrams/flowcharts/<name>.md)` on the same entry.>

## Conventions worth noting
<short callouts of patterns that hold most of the time — one line each, no explanation>
<flag inconsistency if a pattern is broken often; do not catalog the exceptions>

## Areas to explore on demand
<topics deliberately not covered in detail — infra deep-dive, full test setup, observability stack, etc.>
```

If none of the three subsections have content, skip writing `notable.md` and drop its bullet from the README's "Documents in this folder" list.

### `diagrams/sequence/<name>.md` and `diagrams/flowcharts/<name>.md` — one per meaningful endpoint/service

Written only when the `diagram-investigator` produced a corresponding block. The agent's structured output gives you the metadata (`title`, `description`, `cross_ref`, `entry_point`, optional `notes`) and the mermaid block(s). Splice them into this template:

```
[← back to overview](../../README.md)

# <title> — <Sequence|Flow>

<description from the agent's block — 1–2 sentences.>

<If the agent emitted a SIMPLIFIED mermaid block (only when the full one exceeds ~7 nodes), render it here first.>

<FULL mermaid block — every participant/step/branch. Always present.>

<If the agent emitted `notes:`, render them as bullets here.>

_Entry point: [api/handlers/messages.py:142](../../../../api/handlers/messages.py#L142)_
```

Path math (verify when reviewing):
- `[← back to overview](../../README.md)` — diagram is at `<target>/docs/system-overview/diagrams/sequence/foo.md`; `..` → `<target>/docs/system-overview/diagrams/`, `../..` → `<target>/docs/system-overview/`, so `../../README.md` resolves to `<target>/docs/system-overview/README.md`. Two `..` segments — the diagram and the README share the docs root, so the diagram nesting level is what determines this number, not where the docs folder lives in the repo.
- The **`entry_point` link**, and any file:line link inside the mermaid block or notes, needs `../../../../` (four `..` segments) to escape the docs folder *and* the `docs/system-overview/` nesting and reach the project root. The `diagram-investigator` is briefed to emit links already prefixed this way; pass them through as-is.

## Mermaid

Templates and the multi-diagram rule live in `references/diagrams.md`. The key rule from the user: **when a system or aspect is complex, generate multiple diagrams — one simplified high-level diagram first, then one or more focused breakdowns**. A single bloated diagram with everything on it is worse than two focused ones.

## Adaptiveness

Don't hard-code framework names or paths into your reasoning. Detection patterns live in `references/detection.md`. If a detection signal is absent, omit the section. If a repo's structure is unusual, fall back on first principles: find the entry point (manifest's `main`/`scripts.start`, framework conventions), follow the imports.

## Subagent briefing files

Detailed instructions for each subagent live in `agents/`. Read the relevant file before spawning each subagent and pass the contents in. Each file describes:
- Role (what subsection of the repo it covers)
- Search strategy (broad-then-focused)
- What to look for (with pointers into `references/detection.md`)
- Exact output format (with worked examples from `references/section-examples.md`)
- Universal rules from this skill, repeated for the subagent's context

## Reference files

- `references/create.md` — playbook for the `create` route (Phases 1–3). Loaded when Routing returns `create`.
- `references/update.md` — playbook for the `update` route (Phases 0–3): a non-destructive, diff-driven refresh of an existing wiki. Loaded when Routing returns `update`.
- `references/detection.md` — detection patterns for frameworks, DBs, LLMs, external services, notable-workflow signals, module-complexity heuristics
- `references/diagrams.md` — mermaid templates and the multi-diagram rule
- `references/section-examples.md` — worked good/bad examples for the format-heavy sections (Endpoints "Notable", Notable workflows entries, Conventions callouts)

## Scripts

- `scripts/route.sh` — decides `create` vs `update` for the target directory by testing whether `docs/system-overview/` already exists, then prints the route (`SL_SYSTEM_OVERVIEW_ROUTE=`) and the absolute docs path (`SL_SYSTEM_OVERVIEW_DOCS_DIR=`). Run first, by the Routing step. Existence is the sole determinant — the user's keyword is never consulted.
- `scripts/create.sh` — ensures `docs/system-overview/` exists under the target directory (idempotent) and prints its absolute path. Invoked by the create flow before any files are written. The folder is intentionally a tracked path; the script does not touch `.gitignore` or `.git/info/exclude`.
