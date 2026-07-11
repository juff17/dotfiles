---
name: doc-trd-write
description: >
  Create and update a Technical Requirements Document (TRD) — the epic-level
  technical plan for how a PRD gets built: an overview of why, then the
  implementation broken into stages. Use when the user wants to write a TRD,
  plan out an epic, spec a feature technically, turn a PRD into a technical
  plan, or update an existing TRD.
license: MIT
---

A TRD is the **high-level technical plan** for building a PRD (product
requirements document). The PRD says *what* we're building and why; the TRD
answers *how*.

A TRD is a **plan**, and every stage and ticket downstream gets built from it.
That makes assumptions expensive: a wrong guess about scope, a requirement, a
constraint, or a decision propagates into everything that follows. So when
something material is unknown, undecided, or ambiguous, **ask the user — don't
assume.**

Resolve these in conversation *before* drafting — they're decisions where the
user's intent matters and you can't settle them by reading the codebase:

- **the approach**, when there's a real fork — build vs. integrate, batch vs.
  streaming, sync vs. async — and the trade-offs cut different ways;
- **scope edges** — what's explicitly a non-goal, and what ships first;
- **cross-cutting expectations** — performance or scale targets, the
  auth/permissions model, data retention or PII handling, what to log and
  monitor, any backwards-compatibility or migration constraint;
- **assumptions you'd otherwise guess** — raise them as questions instead.

## The right level of detail

The document should be written at the level of *what the stages are and why* — 
not *how the code will look*. Describe how the system will behave and how the 
work breaks apart - don't specify functions, files, corner cases, or line-by-line detail.
A TRD stops at the point where a competent engineer could take a stage and
**split it into tickets** on their own.

Do Not:

- **paste or invent source code**, or pseudo-code for anything but a
  genuinely novel algorithm.
- **per-function or per-case implementation detail** that a ticket would own.
- **raw data**, or a bullet list padded to look thorough rather than to inform.

You Can:
- **draft database schema** in tables and diagrams
- **OpenAPI specs** to define how API endpoints will behave - use standard formatting
- **define processes** in plain English that contain core functionality of the feature we are adding, such as gating logic or step by step processes 

Do not simply restate the PRD or user prompt, you need to reframe the relevant parts from a technical perspective. The technical explanations should capture what it is we are building and how we are building it, engineers reading the TRD should be able to understand without relying on the PRD.

## Show Before Telling
Use diagrams first, words second. For API contracts, database schema, and complex flows use diagrams, tables and other visuals. For complex flows and processes consider adding additional details in text that cannot be easily inferred from the visuals. For API contracts and database schema, refer to them by name in future descriptions (e.g. `POST /v1/payments/<uuid>`).

- **Process and flow charts** for the key flows and how the stages connect.
- **Database schema** — the tables, their columns, and relationships, as an
  entity-relationship diagram and/or table definitions. (Note we don't need to explain how queries or joins work - this can be inferred from the diagrams)
- **OpenAPI schema** for any endpoints, instead of prose describing them.

Diagrams and visuals help explain far more than words alone can. Words can help to explain the parts of the diagram that are not easily visualized or add additional details when necessary.

## Scope
Before writing the TRD or planning you need to gather information:
- What exists today?
- What can I reuse?
- Is this greenfield or brownfield work?
- Do I need new API contracts or can I extend existing?
  - Are the changes we are making transformative in that they could change the existing behavior of heavily baked in endpoints? - If yes, lean towards net new.
  - Are the changes we are making additive to existing endpoints, such that extending the input or output would suffice? - If yes, lean towards extending.
  - Are the changes unrelated to existing endpoints? - If yes, lean towards net new.
- Is there a database? If yes, use the existing database.
  - Prefer minimal changes when possible such as adding to existing tables
  - Create a new table if it the minimal change or introduces less complexity

Once you have explored the codebase and have an understanding of what exists today, begin drafting the TRD.

## What a Good TRD Covers

These are the things a strong TRD does — not a template to fill in. Include what
serves the epic and skip what doesn't; the order below is a reasonable default,
not a mandate.

Open choices get resolved *with the user in conversation* before drafting (see
the top of this skill). The TRD records the resulting plan, not the deliberation
that produced it.

**Start with what we are building** Open with the problem and what we're building, based on the PRD and original provided context.
This should be a few sentences at most, a reader should be able to see and quickly know what this is building. 

**State Goals.** Goals are a short list of what the
work is trying to achieve. Non-goals are the high-leverage part: not negated
goals like "it shouldn't crash," but *things that could reasonably be goals and
are explicitly chosen not to be.* They're the cheapest scope control there is —
they kill "but shouldn't it also…" before it starts and tell whoever writes the
tickets where the epic's edges are.

**Lay out the stages.** Break the work into meaningful stages that can be easily followed and understood. 
Sequence them so the plan is buildable — organize the document to include things that need to be built first appear in order.
When things can be built in parallel, the ordering should be to help the reader understand and follow the plan.

## Keep it lean

Match the TRD's depth to the size of the work — length follows scope, not a
fixed count. **One to three pages** is a good default for most changes, and a
tightly-scoped one (a new status type, a metrics panel over data you already
have) can be shorter still. A net-new system like a document-processing pipeline
earns more — it has more stages, contracts, and alternatives to weigh, can be longer. Don't pad
a small one to look thorough or cram a large one. Ship it **timely rather than polished**,
and write it to be read: plain language, short sentences, no walls of text.

## A living document

A TRD isn't frozen when it's written. Give it a single named **owner** and a
**status**, and expect it to change as plans meet reality — a stage completes, a
guess turns out wrong, a constraint surfaces. Keep it current in place; an
out-of-date TRD that still reads as authoritative is worse than none, because
people stop trusting it. Once the work has shipped, the document stops predicting
and starts describing how the system actually works — the entry point for the
next person who has to understand it.

## Title Convention

`TRD: <epic name>` — e.g. `TRD: Vendor invoice ingestion`. Match an existing
naming pattern if other TRDs are visible where this one will live, rather than
inventing a new one.

## Providers and Flows

The *authoring rules* above define what a TRD should say, regardless of where it
lives. Publishing is a separate step:
[`references/publish.md`](references/publish.md) detects the connected doc-store
MCP (Confluence, Notion, Google Docs, …), publishes the page there, and falls
back to writing a Markdown file if none is connected. Follow it for the doc-store
mechanics.

- **Creating** from scratch (no existing document, or the user asks to write or
  plan one): follow [`references/create.md`](references/create.md).
- **Updating** — the user points at an existing TRD to revise. Follow
  [`references/update.md`](references/update.md) — it's the more cautious flow,
  built for a document that evolves stage by stage.
