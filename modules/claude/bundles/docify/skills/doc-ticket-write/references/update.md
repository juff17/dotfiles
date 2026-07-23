# Updating a ticket

Use this flow when the user gives an **existing ticket number** or asks to
update/change it. The ticket already exists, so tread carefully.

1. **Fetch the ticket first** — see [`publish.md`](publish.md) for the provider
   mechanics — read its current contents before touching anything. Never
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
   moved, and what you deliberately left alone. Report the ticket's link.
