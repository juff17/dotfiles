# The tour

The tour is the click-through half of the explanation: a CodeTour file
(`vsls-contrib.codetour` extension) that opens each step at its real file and
line in VS Code, with a short note beside the code. The doc shows the shape;
the tour walks the reader through the lines in order.

## Where it comes from

Build the tour from the doc, not from a second read of the code:

1. **First step:** the entry point of the first flow, as a file step. Its
   description is the doc's TL;DR problem and fix bullets.
2. **Then each `Follow the path` trace, in order.** Every trace step that has a
   ref becomes a tour step. Title it with the flow name and step
   (`Resolving a poll 3: payout guard`). The description is the trace line plus
   why it matters, from `The pieces` or `Read this` if they say more.
3. **`Watch out` findings** go into the tour at the step where they happen, not
   at the end. Prefix the title with `⚠️`.
4. **Last step:** a content step with the `Ask me about` bullets, and the path
   to the doc.

Steps without a ref in the doc don't become tour steps. If a flow's trace was
skipped as trivial, skip it in the tour too. A tour over ~15 steps means the
doc is too big: split it by flow, one tour per flow.

## File

Write `.tours/<slug>.tour`, the same `<slug>` as the doc. CodeTour finds tours
in `.tours/` automatically. If the repo doesn't track `.tours/`, say so; the
tour then stays local, like `.claude/explained/`.

```json
{
  "$schema": "https://aka.ms/codetour-schema",
  "title": "Poll resolution change",
  "description": "Walks the two flows this commit changes. Doc: .claude/explained/poll-resolve-commit.md",
  "ref": "<commit hash the doc was written against>",
  "steps": []
}
```

## The `ref` field

`ref` pins the tour to a commit. Set it to the **commit hash** the doc was
written against, the same one named at the top of the doc. When `ref` isn't
what the reader has checked out, CodeTour opens files **from that revision in
git, not from disk**. A file missing from that revision fails with "file not
found" while the step text still shows, which is easy to misread.

- Never use the base branch of a PR: the PR's new files don't exist there.
- If the doc covers uncommitted work, leave `ref` out so CodeTour reads from
  disk.

## Step types

Default to file + line. Use the others when they fit:

```jsonc
{ "file": "src/auth/middleware.ts", "line": 42, "title": "Auth gate", "description": "…" }

// a block matters more than a line (same as an #L120-L160 ref in the doc)
{ "file": "src/core/pipeline.ts",
  "selection": { "start": { "line": 15, "character": 0 }, "end": { "line": 34, "character": 0 } },
  "title": "Request pipeline", "description": "…" }

// orient the reader to a module
{ "directory": "src/services", "title": "Service layer", "description": "…" }

// content-only: the closing step, never the first
{ "title": "Ask me about", "description": "…" }
```

## Step descriptions

- Two to four sentences, same voice as the doc: plain words, jargon defined on
  first use, the "why" before the "what".
- Name the concrete code ("retries 5 times, then returns null and the caller
  caches it"), not the category ("handles errors").
- No refs inside descriptions. The step itself is the ref.

## Validate

Before reporting the tour path, run:

```sh
python3 <this-skill-dir>/scripts/validate.py .tours/<slug>.tour
```

It checks every file, directory, line, and selection against the tour's `ref`
(or the files on disk if there is none), and that the first step is anchored.
Fix everything it reports.
