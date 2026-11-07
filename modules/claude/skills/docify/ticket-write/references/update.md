# Updating a ticket

Use this flow when the user points at an **existing ticket** — a Markdown file,
a ticket number, or an ask to update/change one. It already exists, so tread
carefully.

1. **Read the ticket first** — a file under `.claude/docs/tickets/`, or the
   tracker if that's where it lives; see [`publish.md`](publish.md) for the
   mechanics of each. Read its current contents before touching anything. Never
   overwrite blind.
2. **If the ticket is blank/empty**, switch to
   [`create.md`](create.md).
3. **Change only what needs changing.** Leave the rest exactly as written — a
   minimal, intentional edit, not a rewrite. Anything you add meets the same
   self-contained bar as a new ticket (see [`../SKILL.md`](../SKILL.md)); leave
   existing text that falls short of it alone unless the user asks.
4. **Propagate consequences.** A change rarely stays in one section: if the
   story or requirements shift, revisit the acceptance criteria so they stay
   consistent, and don't leave stale sections behind.
5. **Tell the user exactly what you changed and why** — which sections, what
   moved, and what you deliberately left alone. Report where it lives — the
   file path, or the ticket link.
