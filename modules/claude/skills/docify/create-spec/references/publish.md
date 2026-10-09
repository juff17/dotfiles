# Writing a spec out

Authoring rules live in [`../SKILL.md`](../SKILL.md). This file is only about
where the finished spec lands.

## Pick the destination

**The default is Markdown and YAML files in the repo.** With no signal either
way, write the files. Don't detect MCPs, and don't ask which doc store to use.

Use a doc store only when the user asks for one: they name a provider ("put
this in Confluence"), say to publish it, or hand you an existing page to
revise. Then follow [To a doc store](#to-a-doc-store).

## To files in the repo

1. **Folder**: `.claude/docs/specs/<slug>/`, relative to the repo root, where
   `<slug>` is the kebab-cased epic name: `Spec: Vendor invoice ingestion` →
   `.claude/docs/specs/vendor-invoice-ingestion/`. Create it if it isn't
   there. If the repo already keeps specs or TRDs somewhere else, follow that
   instead.
2. **Files**:

   | File | Contents |
   |---|---|
   | `spec.md` | The title as an H1 (`# Spec: <epic name>`), then the spec body |
   | `openapi.yaml` | The OpenAPI 3.1 document for every new or changed endpoint. Omit it when the work has no API change |

3. **Link them.** The spec's API section links to the file with a relative
   link, `[openapi.yaml](openapi.yaml)`, and refers to endpoints by
   `METHOD /path`.
4. **One folder per epic.** If the request is really several epics, say so
   rather than forcing them into one spec.
5. **Never clobber.** If the folder already exists, read it before writing.
   Same epic → that's an update; switch to [`update.md`](update.md).
   Different epic → pick a distinct slug.
6. **Diagrams** go in `spec.md` as ` ```mermaid ` fenced blocks. They render in
   Markdown, so nothing has to be attached as an image.
7. **Report** both file paths.

## To a doc store

### Pick the provider

If the user named one, use it. Otherwise detect it from the connected MCPs:

- **Discover** which doc-store tools are connected: try `ToolSearch` for
  `"create page"`, `"create document"`, `"create file"`.
- **One clear match** (only one doc store connected) → use it, no question.
- **Several connected** (e.g. Confluence *and* Notion) → ask which one,
  **once per session**, and reuse that choice.
- **None connected** → say so and write the files instead:
  > I don't see a doc-store MCP (Confluence, Notion, Google Docs...) connected,
  > so I can't publish this directly. I've written it to
  > `.claude/docs/specs/<slug>/` instead. Connect a doc store and I can publish
  > it.

### The OpenAPI file on a doc store

Doc stores hold one page, not a folder. Pick the first option that works:

1. If the repo has a home for API specs (an `openapi/` or `docs/api/` folder),
   write `openapi.yaml` there and link to it from the page.
2. Otherwise attach `openapi.yaml` to the page if the store supports
   attachments.
3. Otherwise put it in a ` ```yaml ` block in an appendix at the end of the
   page, so the readable body stays short.

Tell the user which option you used.

### Create a page

1. **Discover the tools by capability, not by name.** Tool names vary by server
   (`createConfluencePage`, `notion-create-pages`, `create_file`,
   `coda_create_page`). Find the create, get, update, and search tools with
   `ToolSearch` and read their input schemas. The schema is the source of truth
   for required fields. Don't hardcode a name or a field list.
2. **Resolve the container.** Every store needs one location id before you can
   create: a Confluence space, a Notion parent page or database, a Google Drive
   folder, a Coda doc. If the user didn't name one, look it up with the
   provider's list or search tool, or ask. Don't guess a key. Resolve a parent
   page too if the team keeps a spec index.
3. **Create with title and Markdown body.** Title: `Spec: <epic name>` (match
   the team's existing pattern if specs or TRDs are already visible). Pass the
   rendered spec as a Markdown string. Every store in the quirks table accepts
   Markdown except where noted. You do **not** need to pass a version number;
   the servers handle versioning internally.
4. **Diagrams.** Emit Mermaid diagrams as fenced code blocks. This renders on
   most stores, but check the quirks table: on some (Confluence via the
   official Rovo server) diagram macros are **stripped**, and you must fall
   back to an attached image. Don't silently drop a diagram the spec calls for.
   Tell the user if the connected tool can't render one.
5. **Report** the created page's title and link.

### Update a page

1. **Fetch first** with the get tool. Never overwrite blind. Preserve
   completed-stage content unless the user is explicitly revising it.
2. **Change only what changed**, in place. Don't append a running changelog
   unless the user asks for one.
3. **Re-render** any section whose content shifted (per the SKILL.md rules)
   before writing back, so nothing stale is left behind.
4. **Report** what changed and the link.

See [`update.md`](update.md) for the full update flow; the above is only its
publishing half.

### Provider quirks

Everything above is shared. These are the only per-provider differences. Add a
row when you wire up a new store:

| Provider | Container | Body | Diagrams |
|---|---|---|---|
| Confluence (Rovo MCP) | space (+ opt. parent) | Markdown | ⚠️ storage macros stripped; attach Mermaid as an image |
| Confluence (community `mcp-atlassian`) | `space_key` (+ opt. parent) | Markdown (default); `storage` for macros | `storage` mode passes `ac:structured-macro` through |
| Notion | parent page or database id | Markdown | ` ```mermaid ` fenced block renders natively |
| Google Docs (Drive) | folder (`parentId`) | Markdown, auto-converts to a Doc | not rendered; attach or inline as an image |
| Coda | `docId` (+ opt. `parentPageId`) | Markdown | inline Markdown image only; no upload |
| SharePoint / OneNote | site / notebook | **HTML or web-part JSON, not Markdown** | custom; out of scope unless needed |

Version numbers are handled internally by every MCP above. Never pass one.
