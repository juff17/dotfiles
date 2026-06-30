# Update flow

Playbook for `/system-overview update [<path>]` — and for any invocation that Routing resolves to `update` (i.e. `docs/system-overview/` already exists). Refreshes the existing wiki **in place**, like a careful human editor bringing stale docs up to date: re-read the code, find what materially changed, and touch only those parts.

The shared context — operating principles, target-directory resolution, output templates, link-prefix math — lives in [../SKILL.md](../SKILL.md). This file is the update-specific workflow only. It reuses the same investigator briefings in `../agents/` and the same detection / diagram / example references as create; the only thing that changes is that every phase works as a **diff against the existing wiki**.

`SL_SYSTEM_OVERVIEW_DOCS_DIR` (from `scripts/route.sh`) is the existing `docs/system-overview/` folder. Everything below operates on it. **Do not run `scripts/create.sh`** — the folder already exists.

## The one invariant — no-reword guardrail

Read this before any phase; it governs the whole flow.

> **Unchanged content is the source of truth and is never re-emitted.**
> 1. **Frozen unless tagged.** If an item, paragraph, bullet, diagram, or list entry is not tagged `NEW` / `CHANGED` / `REMOVED` by an investigator or the Phase 1 top-level diff, you do **not** touch it — no edit, no reword, no reformat, no reorder. "I would phrase it better" is not a change. Different wording is not a reason to write.
> 2. **You are a diff applier, not an author.** Every edit must trace to a specific tagged delta — name it before you make the edit ("applies CHANGED on `POST /messages`"). If you can't name one, don't edit.
> 3. **Copy, don't recall.** Every `old_string` you edit comes from the baseline text you loaded in Phase 0, pasted exactly — never reconstructed from memory.
> 4. **Smallest possible diff.** Touch the fewest lines that express the change; don't tidy neighbours that happen to be in view.
> 5. **Never regenerate an existing file.** Regenerating rewords as a side effect. The only `Write`s allowed are a brand-new file or a single generated diagram file. Existing section files are edited in place, never rewritten.
> 6. **Preserve navigation invariants** (back-link as the literal first line; complete README `## Index`) — but don't rewrite ones that are already correct.

## Phase 0 — Load the existing wiki as baseline (you, the main agent)

Read everything under `SL_SYSTEM_OVERVIEW_DOCS_DIR` and hold it as the authoritative baseline. Anything a later phase does not tag as changed is carried forward **byte-for-byte** from what you read here.

1. **`README.md`** in full. Capture, verbatim:
   - the Overview paragraph,
   - the Core frameworks & packages list,
   - the Architecture mermaid block(s),
   - the Infrastructure prose,
   - the External services list,
   - the Diagrams section (each diagram's link, name, one-line description),
   - the **`## Index`** — the authoritative list of which section files the wiki currently has.
2. **Each section file the Index lists** (`endpoints.md`, `database.md`, `llm.md`, `queues.md`, `notable.md`) in full. Each becomes the **baseline** you hand to its investigator in Phase 2.
3. **The `diagrams/` tree** — list `diagrams/sequence/*.md` and `diagrams/flowcharts/*.md`. For each, capture its name, `# title`, the `cross_ref` it illustrates, and its `entry_point`. This is the baseline for the diagram delta (Phase 2.5).
4. **Cross-check Index against disk** (`ls` the folder). If a file exists but isn't in the Index, or a bullet points at a missing file, note it as a pre-existing navigation defect to repair opportunistically during synthesis. Don't fail — the wiki may have been hand-edited.

Record three things you'll carry through the run:
- **`BASELINE_SECTIONS`** — the section files present.
- **`BASELINE_SIGNALS`** — which signals the wiki documents (derived from which sections exist: `endpoints.md` ⇒ API, `database.md` ⇒ DB, `llm.md` ⇒ LLM, `queues.md` ⇒ queues).
- **`BASELINE_DIAGRAMS`** — the list of `(kind, name, cross_ref, entry_point)`.

## Phase 1 — Comparative sweep (you, the main agent)

Do the same initial sweep create's Phase 1 does — read `README*`, the manifest, the top-level directory listing, and the obvious config (`docker-compose.yml`, `.env.example`, `Makefile`, `Procfile`) — and form the same detection signals (API? DB? LLM? Queues? which modules look complex?). See [detection.md](detection.md) for the catalog.

But the output is not fresh prose — it's a **diff** that produces the investigator **roster** and a **removal worklist**. Compute `CURRENT_SIGNALS`, then reconcile against `BASELINE_SIGNALS`:

- **Newly-appeared signal** (in `CURRENT`, not `BASELINE` — e.g. LLM imports now present but no `llm.md`): spawn that investigator in Phase 2 with an **empty baseline**. It reports everything as `NEW` — effectively create for that one section.
- **Persisting signal** (in both): spawn the investigator in **delta mode** with its baseline section text. This is the common case.
- **Disappeared signal** (in `BASELINE`, not `CURRENT` — e.g. `queues.md` exists but no broker code remains): do **not** spawn the investigator. Add the section to the **removal worklist** — but only on **positive absence**: the imports / dirs / config that originally triggered the signal must all be genuinely gone. If it's ambiguous (a rename may have hidden the signal from the sweep), do **not** delete from the sweep — instead spawn the investigator in delta mode and let it confirm `REMOVED` item-by-item.

**Module inventory.** Re-derive the top-level module inventory and compare to what the baseline `notable.md` covers:
- **New complex module** → a new `domain-investigator` (empty baseline).
- **Still-present documented module** → a `domain-investigator` in delta mode whose baseline is **only the `notable.md` entries whose `file:line` points inside that module's path**. Partition `notable.md` by path-prefix so each domain investigator sees and tags only its own entries — never another module's.
- **Documented module gone** (directory deleted/renamed, confirmed by absence of the path) → its notable entries go to the removal worklist.

**Top-level fields** (Overview / Core frameworks / External services / Infrastructure — the ones the main agent owns, not an investigator). Re-derive each from the same sources, diff against the Phase 0 baseline, and tag per field: `UNCHANGED` / `CHANGED` (with what) / added items / removed items. If a re-derived value is semantically equivalent to the baseline, **keep the baseline wording** — especially the Overview paragraph: rewrite it only if the repo's purpose, role, or position materially changed.

**Roster rule:** Phase 1 decides *which* investigators run and with *what* baseline; it must **never** downgrade a still-present subsystem to "skip." Every still-present subsystem is fully re-investigated. The changes that matter most — a response-shape change, a new column's meaning, a reworked ranking algorithm — are invisible to this top-level sweep and only surface when the investigator re-reads the code.

## Phase 2 — Delta-dispatch (parallel subagents, reusing the create investigators)

Spawn the same `Explore` subagents create uses, in **a single message with multiple `Agent`/`Task` tool calls** so they run in parallel. Spawn exactly the roster Phase 1 produced. The investigator briefing files in `../agents/` are **reused unchanged** — you adapt them to delta mode entirely through the dispatch prompt.

Each subagent's prompt is an **envelope** of three parts:
1. **The briefing file, verbatim** — read `../agents/<name>.md` and pass its contents, exactly as create does. (Same six: `api-investigator`, `data-investigator`, `llm-investigator`, `queues-investigator`, `domain-investigator`, and later `diagram-investigator`.)
2. **The baseline** — the full current text of the section this investigator owns (from Phase 0). For a `domain-investigator`, the path-partitioned slice of `notable.md`. For a newly-appeared signal, state it explicitly: "baseline: (none — this section does not exist yet)".
3. **The delta instruction** — the fixed block below, appended verbatim to every investigator's prompt.

> **DELTA MODE — read this in addition to your briefing above.**
> You are *refreshing* an existing section of a wiki, not writing it fresh. The section's **current documented content** (the baseline) is included below. Investigate the code exactly as your briefing tells you — same broad-then-focused passes — then report your findings as a **diff against the baseline**, not as a fresh section.
>
> Tag **every** item (each endpoint-list row, notable endpoint, entity, prompt, queue / topic / handler, notable workflow, convention) with exactly one status:
> - `UNCHANGED: <id>` — the code still matches the baseline's claim. **Emit one line only: the tag and the identifier. Do not re-describe, reword, or re-emit its prose.**
> - `CHANGED: <id>` — the item still exists but the code no longer matches the baseline. Emit: the identifier, a one-line *what changed*, the corrected prose for **just that item** (a full replacement of that one item, in your normal format), and the current `file:line`.
> - `NEW` — the item exists in code but not in the baseline. Emit it in your full normal format (prose + `file:line`), tagged `NEW`.
> - `REMOVED: <id>` — the baseline documents it but it no longer exists in code. Emit the tag, the identifier, and a one-line confirmation of why you believe it's gone (e.g. "route deleted; no handler matches `/v1/foo`"). Emit no prose.
>
> Rules:
> - **Identifier** = the stable key for the item type: endpoint = `METHOD path`; entity = entity name; prompt = prompt name; queue / handler = its name; notable workflow / convention = its title text **as worded in the baseline** (so the main agent can find the exact line to replace).
> - **If an item's identity itself changed** but it's clearly the same item (a renamed route or entity), tag it `CHANGED` and give **both** the old and new identifiers — so the writer updates the existing line in place instead of dropping and re-adding it (which would lose any hand-curated prose).
> - **Structural prose** (the section's diagram, the "Common response patterns" blurb, the erDiagram, the LLM flowchart) → report `UNCHANGED` wholesale unless the underlying code materially changed it; if it did, emit the corrected version tagged `CHANGED-STRUCTURE` and say what changed.
> - Your flagged-conventions and flagged-notable-workflows blocks use the same `NEW` / `CHANGED` / `REMOVED` / `UNCHANGED` tagging.
> - **If your only objection to an item is wording, it is `UNCHANGED`. Reword nothing.**

An empty-baseline dispatch naturally returns everything as `NEW`, which is exactly create-for-that-section.

## Phase 2.5 — Diagram delta (you, the main agent)

After the Phase 2 agents return, reconcile diagram candidates against `BASELINE_DIAGRAMS`. As in create, collect the notable endpoints flagged by `api-investigator` and the notable workflows flagged by `domain-investigator` (and any flagged inside `llm-investigator` / `queues-investigator`) — but now each candidate carries its Phase 2 tag. Sort them into three lists:

1. **New / materially-changed** — candidates tagged `NEW` or `CHANGED` / `CHANGED-STRUCTURE`. These need a diagram (new or redrawn).
2. **Unchanged with an existing diagram** — candidates tagged `UNCHANGED` that already have a baseline diagram. **Exclude these from dispatch and leave their diagram files untouched.** This is the point: an unchanged workflow's diagram is never regenerated, so it can't be reworded or have its layout churned.
3. **Prune list** — baseline diagrams whose `cross_ref` workflow / endpoint was tagged `REMOVED`, or whose module disappeared.

Then:
- **If list 1 is empty, skip the `diagram-investigator` entirely** — but still process the prune list in Phase 3. (Create skips the whole phase when there are no candidates; update must not skip the *prune* work just because there's nothing new to draw.)
- **If list 1 is non-empty**, spawn `diagram-investigator` **once** (same as create — read [../agents/diagram-investigator.md](../agents/diagram-investigator.md), target the built-in `Explore` subagent), passing:
  - only the list-1 candidates (title, entry-point `file:line`, originating blurb, and whether each is `NEW` or a redraw of an existing diagram),
  - the target directory as scope,
  - a delta note in the envelope: *"The wiki already contains these diagrams — do **not** reproduce them: `<names + cross_refs from BASELINE_DIAGRAMS>`. Produce blocks only for the candidates I'm passing."*
  - for a redraw, tell it to **reuse the existing diagram's filename** so inbound cross-reference links from the section files stay valid.

## Phase 3 — Surgical synthesis (you, the main agent)

Apply only the tagged deltas. The no-reword guardrail at the top of this file governs every write here — re-read it now. The mechanism per change:

| Change | Mechanism |
|---|---|
| `CHANGED` / `NEW` / `REMOVED` item **inside** an existing section file | **Edit** — replace / insert / delete exactly that item's lines (match `old_string` against the baseline wording) |
| `UNCHANGED` items | **no operation at all** — the absence of a write is the strongest guarantee |
| A whole **new** section file (newly-appeared signal) | **Write** the new file (back-link `[← back to overview](README.md)` as the literal first line) + **Edit** README's `## Index` to add its bullet in canonical order (Endpoints, Database, LLM flow, Async messaging, Worth knowing about) |
| A whole **removed** section file (disappeared signal, positive absence) | `rm` the file + **Edit** README's `## Index` to drop its bullet + prune any diagrams that cross-referenced it (below) |
| README top-level lists (Core frameworks, External services) | **Edit** — add / remove only the changed bullets; never re-emit the list |
| README Overview / Infrastructure prose | **Edit only if Phase 1 tagged it `CHANGED`**; otherwise leave it |
| Architecture mermaid | **Edit-replace the block only if architecture *materially* changed** — a participant / layer / external touchpoint added or removed, or a top-level data-flow edge changed direction / existence. A renamed helper, a new endpoint inside an existing layer, or "I'd lay it out differently" are **not** material. When in doubt, leave it alone. |
| A single diagram file (`NEW` or redraw) | **Write** (overwrite by name) — a diagram file is a generated artifact with no hand-authored prose to preserve |
| A pruned diagram | `rm` the file + remove its bullet from README's Diagrams section + strip the `→ [Sequence](…) · [Flow](…)` tail from the section entry that pointed at it (no dangling links). If that empties a Diagrams subsection, drop the subsection; if it empties the whole section, drop the section. |

**Removed individual items** within a surviving file → delete exactly that item's lines (and any dangling diagram tail on it). Whole subsystems are removed as whole files; individual items are removed as lines.

**Notable workflows / unique logic over-grows on update — guard it explicitly.** Create is implicitly bounded (it emits the whole wiki in one pass, so output-length pressure naturally restrains this section); update emits far less, so the same restraint is gone and `NEW` entries accumulate. This section is reserved for **critical, highly unique workflows that aren't surfaced anywhere else in the wiki** — it is not a catch-all summary, and more entries is not better. So before you apply a `NEW` notable-workflow entry to `notable.md`, hold it to two tests:

1. **Is the logic genuinely critical or highly unique?** If it's ordinary service/glue logic, drop it.
2. **Is it already covered by another section** (`endpoints.md`, `database.md`, `llm.md`, `queues.md`) — a notable endpoint, a modeling choice, an LLM transformation, a queue handler? If so, drop it; that section is its home.

An entry earns a place here only if it passes (1) and is *not* covered under (2). **Drop every `NEW` entry that fails either test — do not add it.** Filtering out a weak or duplicate *addition* is not a reword and does not breach the no-reword guardrail.

**The same caution applies to Notable endpoints in `endpoints.md` — being `NEW` is not the same as being notable.** A `NEW` endpoint always belongs in the **endpoint-list table** (that's plain inventory — add its row). But it earns a place in the **Notable endpoints** subsection only if it would clear that bar on its own merits — a non-obvious behavior, a custom or streaming response shape, a surprising status code — something worth flagging *relative to all the endpoints in the system*, not just because it didn't exist before. Most endpoints are ordinary CRUD and stay in the table. So when the `api-investigator` tags an endpoint `NEW`, add its table row, but **promote it to Notable endpoints only if it is genuinely notable, not merely new.**

**Deletion** is the one state-changing shell op the create flow never needs. Do it with a narrowly-scoped `rm` of the **exact** path under `SL_SYSTEM_OVERVIEW_DOCS_DIR` — name the file you're deleting and why. `route.sh` and `create.sh` are not involved in deletion.

When you write a `CHANGED` item, your `Edit` `old_string` must be the baseline text you loaded in Phase 0, pasted exactly. If a match fails, re-read that section file from disk (it is the baseline) — do not reconstruct the string from memory.

**Before finishing**, re-read README's `## Index` against the files now on disk: every section file present has a bullet, and every bullet points at a file that exists. Repair any mismatch (including pre-existing ones noted in Phase 0).

## Report — a changelog (you, the main agent)

Report briefly in chat. Do **not** dump file contents. Use a changelog shape, grouped, with counts that reconcile to the deltas you applied:

```
Refreshed the system overview at <SL_SYSTEM_OVERVIEW_DOCS_DIR>.

Added
- <e.g. llm.md (LLM layer now present): 3 prompts + pipeline diagram>
- <e.g. endpoint POST /threads/:id/messages (notable; new sequence diagram)>

Changed
- <e.g. GET /search — pagination offset→cursor>
- <e.g. architecture diagram — added Redis cache layer>

Removed
- <e.g. queues.md — no broker detected in current code; section, Index entry, and 1 diagram removed>

Left unchanged
- <e.g. database.md, notable.md, and 4 diagrams — no material change detected>

<N files touched, M left unchanged. No prose reworded on unchanged sections.>
```

The **Left unchanged** group is not decoration — it's the reader's proof the refresh was non-destructive. Always include it.
