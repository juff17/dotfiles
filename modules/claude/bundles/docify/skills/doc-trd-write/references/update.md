# Updating a TRD

Use this flow when the user points at an **existing TRD** — a Markdown file, a
page reference, or a document to revise. It already exists, so tread carefully.
A TRD also evolves over its life: stages get completed and the plan shifts as
reality lands, so most updates are surgical, not rewrites.

1. **Read the TRD first** — a file under `.claude/docs/trds/`, or the doc store
   if that's where it lives; see [`publish.md`](publish.md) for the mechanics of
   each. Read its current content before touching anything. Never overwrite
   blind.
2. **If it's blank/empty**, switch to [`create.md`](create.md).
3. **Change only what needs changing.** Preserve completed stages and the
   settled plan unless the user is explicitly revising them — a minimal,
   intentional edit, not a rewrite. Anything you add carries none of the
   conversation that prompted it (see [`../SKILL.md`](../SKILL.md)) — an update
   is the easiest place for "as we discussed" to slip in.
4. **Propagate consequences.** A change rarely stays in one place: if the
   overview or an early stage shifts, revisit the later stages and any diagrams
   or specs so the plan stays consistent, and don't leave stale sections
   behind.
5. **Tell the user exactly what you changed and why** — which stages or sections
   moved, and what you deliberately left alone. Report where it lives — the
   file path, or the page link.
