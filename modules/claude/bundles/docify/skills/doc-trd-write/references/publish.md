# Writing a TRD out

Authoring rules live in [`../SKILL.md`](../SKILL.md); this file is only about
where the finished TRD lands.

## Pick the destination

**The default is a Markdown file in the repo.** With no signal either way, write
the file — don't detect MCPs, don't ask which doc store to use.

Use a doc store only when the user asks for one: they name a provider ("put this
in Confluence"), say to publish it, or hand you an existing page to revise. Then
follow [To a doc store](#to-a-doc-store).

## To a Markdown file

1. **Path** — `.claude/docs/trds/<slug>.md`, relative to the repo root, where
   `<slug>` is the kebab-cased epic name: `TRD: Vendor invoice ingestion` →
   `.claude/docs/trds/vendor-invoice-ingestion.md`. Create the directory if it
   isn't there. If the repo already keeps TRDs somewhere else, follow that
   instead of this convention.
2. **Body** — the title as an H1 (`# TRD: <epic name>`), then the epic overview
   and the staged plan as plain Markdown.
3. **One file per epic.** If the request is really several epics, say so rather
   than forcing them into one file.
4. **Never clobber.** If the path already exists, read it before writing. Same
   epic → that's an update, switch to [`update.md`](update.md). Different epic →
   pick a distinct slug.
5. **Diagrams and specs** go in as fenced blocks — ` ```mermaid ` and
   ` ```yaml ` for OpenAPI. Both render in a Markdown file, so nothing has to be
   dropped or attached as an image here.
6. **Report** the file path.

## To a doc store

### Pick the provider

If the user named one, use it. Otherwise detect it from the connected MCPs:

- **Discover** which doc-store tools are connected — try `ToolSearch` for
  `"create page"`, `"create document"`, `"create file"`.
- **One clear match** (only one doc store connected) → use it, no question.
- **Several connected** (e.g. Confluence *and* Notion) → ask which one, **once
  per session**, and reuse that choice.
- **None connected** → say so and write the Markdown file instead:
  > I don't see a doc-store MCP (Confluence, Notion, Google Docs…) connected, so
  > I can't publish this directly — I've written it to
  > `.claude/docs/trds/<slug>.md` instead. Connect a doc store and I can publish
  > it properly.

### Create a page

1. **Discover the tools by capability, not by name.** Tool names vary by server
   (`createConfluencePage`, `notion-create-pages`, `create_file`,
   `coda_create_page`). Find the create / get / update / search tools with
   `ToolSearch` and read their input schemas — the schema is the source of truth
   for required fields. Don't hardcode a name or a field list.
2. **Resolve the container.** Every store needs one location id before you can
   create — a Confluence space, a Notion parent page/database, a Google Drive
   folder, a Coda doc. If the user didn't name one, look it up with the
   provider's list/search tool or ask - don't guess a key. Resolve a parent page
   too if the team keeps a TRD index.
3. **Create with title + Markdown body.** Title: `TRD: <epic name>` (match the
   team's existing pattern if TRDs are already visible). Pass the rendered TRD as
   a Markdown string — every store in the quirks table accepts Markdown and
   converts it, except where noted. You do **not** need to pass a version number;
   the servers handle versioning internally.
4. **Diagrams and specs.** Emit Mermaid diagrams and OpenAPI as fenced code
   blocks. This renders on most stores — but check the quirks table: on some
   (Confluence via the official Rovo server) diagram macros are **stripped**, and
   you must fall back to an attached image. Don't silently drop a diagram the
   plan calls for — surface it if the connected tool can't render one.
5. **Report** the created page's title and link.

### Update a page

1. **Fetch first** with the get tool — never overwrite blind. A TRD evolves stage
   by stage, so preserve completed-stage content unless the user is explicitly
   revising it.
2. **Change only what changed**, in place. Don't append a running changelog
   unless the user asks for one.
3. **Re-render** any section whose content shifted (per the SKILL.md rules)
   before writing back, so nothing stale is left behind.
4. **Report** what changed and the link.

See [`update.md`](update.md) for the full cautious update flow; the above is just
its publishing half.

### Provider quirks

Everything above is shared. These are the only per-provider differences — add a
row when you wire up a new store:

| Provider | Container | Body | Diagrams |
|---|---|---|---|
| Confluence — Rovo MCP | space (+ opt. parent) | Markdown | ⚠️ storage macros stripped; attach Mermaid as an image |
| Confluence — community `mcp-atlassian` | `space_key` (+ opt. parent) | Markdown (default); `storage` for macros | `storage` mode passes `ac:structured-macro` through |
| Notion | parent page or database id | Markdown | ` ```mermaid ` fenced block renders natively |
| Google Docs (Drive) | folder (`parentId`) | Markdown → auto-converts to a Doc | not rendered — attach/inline as an image |
| Coda | `docId` (+ opt. `parentPageId`) | Markdown | inline Markdown image only; no upload |
| SharePoint / OneNote | site / notebook | **HTML or web-part JSON — not Markdown** | bespoke; out of scope unless needed |

Version numbers are handled internally by every MCP above — never pass one.
