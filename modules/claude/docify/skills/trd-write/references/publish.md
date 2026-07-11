# Publishing a TRD

This file is the provider-agnostic mechanics of getting
the document into whatever doc store is connected — Confluence, Notion, Google
Docs, Coda, and the like. The steps are the same everywhere; only the small
**quirks table** at the bottom differs by provider.

## Pick the provider

Detect it from the connected MCPs rather than asking by default:

- **Discover** which doc-store tools are connected — try `ToolSearch` for
  `"create page"`, `"create document"`, `"create file"`.
- **One clear match** (only one doc store connected) → use it, no question.
- **Several connected** (e.g. Confluence *and* Notion) → ask which one, **once
  per session**, and reuse that choice.
- **None connected** → tell the user and offer the Markdown fallback:
  > I don't see a doc-store MCP (Confluence, Notion, Google Docs…) connected, so
  > I can't publish this TRD directly. I can write it as a Markdown file instead
  > — want that, or would you rather connect one first?

Skip detection only if the user already named a provider.

## Create a page

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

## Update a page

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

## Provider quirks

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
