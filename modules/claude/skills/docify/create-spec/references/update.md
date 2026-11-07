# Updating a spec

Use this flow when the user points at an **existing spec** (a Markdown file, a
page reference, or a document to revise). A spec evolves over its life: stages
get completed and the plan shifts, so most updates are small and targeted, not
rewrites.

1. **Read the spec first.** That means `spec.md` and `openapi.yaml` under
   `.claude/docs/specs/<slug>/`, or the doc store page if that's where it lives
   (see [`publish.md`](publish.md)). Read the current content before touching
   anything. Never overwrite blind. Older documents may be TRDs at
   `.claude/docs/trds/<slug>.md` with inline OpenAPI; update those in place and
   don't move them unless the user asks.
2. **If it's blank or empty**, switch to [`create.md`](create.md).
3. **Change only what needs changing.** Preserve completed stages and the
   settled plan unless the user is explicitly revising them. Anything you add
   carries none of the conversation that prompted it (see
   [`../SKILL.md`](../SKILL.md)). An update is the easiest place for "as we
   discussed" to slip in.
4. **Contract changes go to the contract first.** An API change is made in
   `openapi.yaml` before the spec's endpoint table and flows. A data change is
   made in the column table and ER diagram before anything that refers to it.
5. **Propagate consequences.** If the overview, a contract, or an early stage
   shifts, revisit the later stages, flows, state diagrams, and glossary so the
   spec stays consistent. Don't leave stale sections behind. Re-run the checks
   in [`create.md`](create.md) step 6.
6. **Tell the user exactly what you changed and why**: which sections or
   stages moved, and what you deliberately left alone. Report where it lives
   (the file paths, or the page link).
