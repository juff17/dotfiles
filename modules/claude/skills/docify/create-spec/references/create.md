# Creating a spec

Use this flow when there's **no existing spec**: the user gave no page or
document to revise, or explicitly asked to write, spec, or plan one.

1. **Gather intent. Ask, don't assume.** Read the PRD or description the user
   gave and get clear on what's being built and why, plus any technical
   direction already decided. Whenever something material is missing,
   undecided, or ambiguous (scope, a requirement, a constraint, a key
   decision), ask the user rather than inventing scope or guessing.
2. **Survey the code and infra.** Work out what already exists versus what's
   net new. Decide greenfield or brownfield, and in brownfield estimate scale
   from infra and config (see [`context.md`](context.md)). Confirm the estimate
   with the user before designing around it.
3. **Read the design rules** that apply: [`principles.md`](principles.md)
   always, then [`api.md`](api.md), [`data.md`](data.md),
   [`flows.md`](flows.md), and [`types-naming.md`](types-naming.md) for the
   parts the work touches.
4. **Design the contracts first.** Write `openapi.yaml` and the data model
   before the stages. Stages are easier to cut once the contracts are fixed,
   and gaps in the contracts show up as open questions early.
5. **Draft the spec**: overview, goals, context, glossary, architecture, API
   table, data, flows, testing, stages, open questions (see
   [`../SKILL.md`](../SKILL.md)). One spec per epic. If the request is really
   several epics, say so rather than forcing them into one document.
6. **Check it.**
   - Every endpoint in the spec's API table exists in `openapi.yaml`, and the
     reverse.
   - Every status column has a state diagram, and every enum value has a
     meaning.
   - Every term in the glossary is used with one name across API, data, and
     prose.
   - Lint `openapi.yaml` if a linter is available (see [`api.md`](api.md)).
7. **Strip the conversation.** Read the draft as an engineer who never saw the
   prompt (see [`../SKILL.md`](../SKILL.md)). Cut framing like "as requested"
   or "as we discussed", and replace placeholder terms with what the domain and
   the code call the thing.
8. **Write it out.** See [`publish.md`](publish.md): files under
   `.claude/docs/specs/<slug>/` by default, or the doc store if the user asked
   for one.
9. **Report back** where it landed (the file paths, or the page title and
   link) and list any open questions.
