# Creating a ticket

Use this flow when there's **no existing ticket** — the user gave no ticket
number, or explicitly asked to create/write/file one. You're making it from
scratch.

1. **Gather intent.** Get clear on who the ticket is for, what they need, why,
   and the scope and constraints — enough to write a complete ticket. Ask if
   something critical is missing; don't invent scope.
2. **Draft the ticket** — user story → requirements → acceptance criteria. One
   ticket per unit of work; if the request is really several units, draft
   several — each standing on its own, with no cross-references between them.
3. **Strip what won't survive.** Check the draft against the self-contained bar
   in [`../SKILL.md`](../SKILL.md): nothing the reader can't reach, no
   conversational framing, no ticket keys, no names that can be reassigned, no
   status.
4. **Write each ticket out** — see [`publish.md`](publish.md): a Markdown file
   under `.claude/docs/tickets/` by default, or the tracker if the user asked
   for one.
5. **Report back** where each ticket landed — the file path, or the key and
   link.
