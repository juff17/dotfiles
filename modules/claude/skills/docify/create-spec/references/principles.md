# Design principles

These rules decide how big the design is. Apply them before api.md, data.md,
and flows.md, and check the finished spec against them.

## Start simple

- **A complex system that works grew from a simple system that worked.** A
  complex system designed from scratch rarely works and can't be patched into
  working (Gall's law). In greenfield work, the MVP must be the simplest system
  that delivers the goals.
- **Complexity doesn't come from one thing. It comes from many small things.**
  An extra endpoint, an optional field, a config flag, a second queue, a
  status nobody reads. Each looks cheap alone. Challenge every one of them.
- **The default answer to "should we add X?" is no**, unless a goal or a
  confirmed constraint needs it.

## Build considering the future, not for it

Two rules that pull in opposite directions. The spec must satisfy both.

| Don't build it today | But don't block it |
|---|---|
| Features, endpoints, columns, or config no goal uses yet | Choices that make the likely next step a rewrite |
| A second implementation "in case" (a plugin system with one plugin) | IDs, enums, and payloads that can't grow (a boolean that will need a third state; an integer ID exposed where it may need to become a UUID) |
| Multi-region, sharding, or caching before scale calls for it | Coupling the data model to one tenant, one currency, or one locale when the PRD hints at more |
| Abstractions with one caller | Breaking changes to a public contract when an additive change works |

How to check a choice:
- **Is it used by a goal in this spec?** If not, cut it.
- **If we needed it next quarter, what would we change?** If the answer is a
  migration of live data or a breaking API change, adjust the design now in
  the cheapest way (a status enum instead of a boolean, a nullable column,
  an object instead of a bare string in a response). Don't build the feature.
- **Record what was deferred** as a non-goal, so the next spec knows the door
  was left open on purpose.

## Scale to the real user base

- Design for the scale the system has (brownfield) or will have at launch
  (greenfield), not for an imagined peak. See [`context.md`](context.md) for
  how to estimate it.
- Greenfield: scale is rarely the constraint. Optimize for simplicity and
  speed of change.
- Brownfield: scale is a real constraint. A design that adds a query per row,
  a fan-out per request, or a lock on a hot table must say why it's safe at
  the estimated load.

## Prefer visuals over prose

- Bullets, tables, and diagrams first. Prose only for a reason, a trade-off, or
  a constraint a visual can't carry.
- One diagram per idea. Two focused diagrams beat one crowded one.

## Check the finished spec

- [ ] Every endpoint, table, column, status value, and stage traces to a goal.
- [ ] Nothing exists only "for later".
- [ ] The likely next feature doesn't need a breaking change or a data rewrite.
- [ ] Deferred items are listed as non-goals.
- [ ] Scale claims cite their source (see [`context.md`](context.md)).
