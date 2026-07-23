---
name: doc-ticket-write
description: >
  Create and update engineering tickets — a user story, then requirements, then
  acceptance criteria, written for the engineer who'll build it. Use when the
  user wants to write, create, or file a ticket, or to update or edit an
  existing one.
license: MIT
---

A ticket is a single, self-contained **unit of work** — small enough that an
engineer can hold it in their head. It might be one slice of a larger feature
or stand on its own. Tickets are consumed by software engineers, often
asynchronously — the person who reads it can't lean over and ask what you meant.
So a good ticket carries enough intent, context, and a clear definition of done
that an engineer can start without a meeting, while still leaving room for their
judgement on *how* to build it.

Right-size the ticket to the work. A small change gets a short ticket — don't
pad it to look thorough. Some work genuinely needs a long ticket, but that's the
exception, not the default: a wall of text is a cost to the reader, and the aim
is the least a competent engineer needs to do the job well.

Every ticket has the same three parts, in this order:

1. **User story** — who wants this, and why.
2. **Requirements** — what it takes to do it well.
3. **Acceptance criteria** — how we'll know it's done.

## The Template

```markdown
## User Story

As a <role>, I want <capability>, so that <benefit>.

## Requirements

- <what needs to be true; scope, constraints, technical context>
- <dependencies, links to the epic/feature, TRD, or designs (if any)>

## Acceptance Criteria

- [ ] <verifiable pass/fail condition>
- [ ] <verifiable pass/fail condition>

<!-- only for the occasional criterion that's really about behaviour, in place
     of a checkbox — use sparingly: -->
- **Given** <context>, **when** <action>, **then** <observable result>.
```

## The User Story

One sentence, at the very top:

> As a `<role>`, I want `<capability>`, so that `<benefit>`.

Each clause earns its place:

- **role** — *who* the work is for. A real user, an admin, an operator, a
  downstream service. Naming the role stops the ticket from drifting into
  "build this thing" with no one it serves.
- **capability** — *what* they want to be able to do. Describe the need, not
  the implementation.
- **benefit** — *why* it's worth doing. The ticket should deliver something meaningful,
  and the "so that" is where you say what. If you can't finish the sentence, question 
  whether the ticket is worth its own slot.

Most work fits this form even when it isn't a shiny user feature. For a bug,
frame it around who's hurt and what should happen instead ("As a checkout user,
I want the total to include tax, so that I'm not overcharged"), and put the
observed-vs-expected detail and repro steps in the requirements.

## Requirements

The engineer builds this without you next to them, so write down what they'd
otherwise have to stop and ask. Give them what they need to build the right
thing — and no more:

- **Scope** — what the ticket covers. Note something as *not* included only when
  a reader would otherwise reasonably assume it is; don't catalogue everything
  the ticket isn't.
- **Constraints** — hard requirements the solution must satisfy (performance
  budgets, auth rules, data formats, backward compatibility).
- **Context** — the background an engineer needs: which system, why now, what's
  changed. Link the epic/feature, TRD, designs, or related tickets rather than
  re-explaining them.
- **Dependencies** — anything that must land first, or that this blocks.

Say *what* must be true and *why*, plus any hard constraints — but stop short of
dictating *how*. Spelling out every implementation detail turns the ticket into
a contract and throws away the judgement of the person building it. Give enough
that they could size the work before starting; if they couldn't, it's either
under-specified or too big — add detail or split it. And if there's a genuine
open question or blocker that you can't resolve, surface it to the user (ask
them directly) do not paper over it or silently spin it off into another ticket.

The *how* you leave open is the code-level implementation — which classes,
functions, and data structures the engineer chooses. That's different from a
decision the user has **already made**. When the user hands you a specific
process, ordering, business rule, or gate — a fixed design — that decision *is*
a requirement: record it faithfully, in the detail they gave, and don't trim,
generalize, or drop parts of it for the sake of brevity. Preserving those
explicit rules is not the same as over-specifying; you're capturing a *what*
that's been settled, while still leaving the *how* of building it to the
engineer.

## Acceptance Criteria

The definition of done — the checks that confirm the work is complete. Each
criterion must be **observable and unambiguous**: someone other than the author
should be able to check it and get the same yes/no.

- **Default to a checklist** of pass/fail conditions. Clear, scannable, easy to
  tick off during review.
- **Use Given/When/Then** for the occasional criterion
  that's really about *behaviour* — *Given* some context, *When* an action
  happens, *Then* an observable consequence follows. Reach for it only when a
  plain checklist item can't capture what needs to happen; most criteria don't
  need it.

Cover the important edge cases and failure paths, not just the happy path — but
don't pad the list; keep it to what actually gates "done".

## The INVEST bar

Before handing a ticket off, sanity-check it against INVEST:

- **I**ndependent — a self-contained unit of work; can be scheduled without
  being tangled behind other tickets where possible.
- **N**egotiable — captures intent, leaves the *how* open.
- **V**aluable — the "so that" is real and worth a slot.
- **E**stimable — an engineer could size it.
- **S**mall — doable in a sprint or a few days. If it's too big, split it
  **vertically** — a thin slice through every layer that still delivers value —
  never horizontally by layer (a "just the database" ticket delivers nothing on
  its own).
- **T**estable — the acceptance criteria make done verifiable.

## Title Convention

`[<repo_name>] <short description>` — e.g. `[payments-api] Add tax to checkout
total`. The repo name scopes the ticket at a glance; the description is a
concise imperative summary.

## Providers and Flows

The *authoring rules* above define what a ticket should say, regardless of where
it's filed. Publishing is a separate step:
[`references/publish.md`](references/publish.md) detects the connected
issue-tracker MCP (Jira, Linear, GitHub, …), files the ticket there, and falls
back to writing a Markdown file if none is connected. Follow it for the tracker
mechanics.

- **Creating** from scratch (no ticket number given, or the user asks to make or create
  one): follow [`references/create.md`](references/create.md).
- **Updating** — the user asks to update or edit a ticket. Expect them to give a
  ticket number; the exception is a ticket you just created this session, which
  you can assume is the one they mean. Follow
  [`references/update.md`](references/update.md) — it's the more cautious flow.

## Example

Title: `[ingest-api] De-duplicate and validate incoming vendor invoices`

```markdown
## User Story

As an accounts-payable clerk, I want incoming vendor invoices validated and
de-duplicated before they reach my queue, so that I never pay the same invoice
twice or chase malformed ones by hand.

## Requirements

- The pipeline runs in this fixed order (already decided — keep the order and
  every gate):
  1. Parse each invoice into a normalized record: vendor, invoice number,
     amount, and line items.
  2. Reject any record missing a vendor, invoice number, or amount, or where the
     line items don't sum to the amount.
  3. Reject any record whose (vendor, invoice number) has already been seen in
     the last 90 days.
  4. Write the survivors to the accounts-payable queue.
- Every rejected record goes to the dead-letter table tagged with the gate that
  failed — nothing is dropped silently.
- Must process a 500-invoice batch within 30 seconds.
- Consumes the vendor feed from ING-88 and writes to the existing accounts-payable queue.

## Acceptance Criteria

- [ ] A valid, non-duplicate invoice reaches the accounts-payable queue with every field
      populated.
- [ ] An invoice missing a vendor, invoice number, or amount is rejected and
      written to the dead-letter table with the failing gate recorded.
- [ ] An invoice whose line items don't sum to its amount is rejected.
- [ ] A 500-invoice batch completes within 30 seconds.
- **Given** a (vendor, invoice number) already seen in the last 90 days,
  **when** another invoice with that same pair arrives, **then** it's rejected
  as a duplicate and the original stays in the queue.
```
