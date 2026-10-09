---
name: create-spec
description: >
  Create and update a technical spec: the epic-level design for how a PRD or
  feature gets built. Covers the overview and goals, API design as a separate
  OpenAPI file, the data model with column tables and allowed values, diagrams
  of every key flow, naming and types, and the build broken into stages. Use
  when the user wants to write a spec, TRD, or design doc, plan out an epic,
  design an API or schema, turn a PRD into a technical plan, or update an
  existing spec.
license: MIT
---

A spec is the **technical design** for building a PRD (product requirements
document) or feature. The PRD says *what* we're building and why. The spec says
*how*: the API, the data, the flows, and the order the work gets built in.

A spec is a **plan**, and every stage and ticket downstream gets built from it.
That makes assumptions expensive. A wrong guess about scope, a requirement, a
constraint, or a decision carries into everything that follows. So when
something material is unknown, undecided, or ambiguous, **ask the user. Don't
assume.**

Resolve these in conversation *before* drafting. They are decisions where the
user's intent matters and you can't settle them by reading the codebase:

- **the approach**, when there's a real fork (build vs. integrate, batch vs.
  streaming, sync vs. async) and the trade-offs cut different ways;
- **scope edges**: what's explicitly a non-goal, and what ships first;
- **cross-cutting expectations**: scale targets, the auth and permissions
  model, data retention or PII handling, what to log and monitor, any
  backwards-compatibility or migration constraint;
- **the scale estimate** in brownfield work (see
  [`references/context.md`](references/context.md));
- **assumptions you'd otherwise guess**: raise them as questions instead.

Anything material left undecided when the spec is written is a defect in the
spec. Either ask, or list it under an **Open questions** heading so nobody
mistakes it for a decision.

## Design rules

Read these before designing anything. They hold for every spec:

| Reference | Read it for |
|---|---|
| [`references/principles.md`](references/principles.md) | How simple to start, what to leave out, how to leave room to grow |
| [`references/context.md`](references/context.md) | Greenfield vs brownfield, and estimating scale from infra and config |
| [`references/api.md`](references/api.md) | Endpoint count, naming, errors, pagination, idempotency, the OpenAPI file |
| [`references/data.md`](references/data.md) | ER diagram, column tables with allowed values, state diagrams, migrations |
| [`references/flows.md`](references/flows.md) | Sequence diagrams, flowcharts, failure paths |
| [`references/types-naming.md`](references/types-naming.md) | Glossary, one name per concept, enums, module shape, contract first |

Skip a reference when its topic isn't in the work. A spec with no API change
has no `openapi.yaml`; a spec with no data change has no data section.

## The right level of detail

Be exact about the **contracts** and stay high level about the **code**.

Exact:
- **API**: every new or changed endpoint in `openapi.yaml`, with request and
  response schemas, error responses, and enum values.
- **Data**: every new or changed table, with each column's type, nullability,
  default, allowed values, and meaning.
- **Flows**: the steps, the actors, and what happens when a step fails.
- **Rules**: gating logic, state changes, and step-by-step processes that are
  core to the feature, in plain language or a flowchart.

High level:
- Describe how the system behaves and how the work breaks apart. Don't specify
  functions, files, or line-by-line detail. A spec stops at the point where a
  competent engineer could take a stage and **split it into tickets** on their
  own.

Do not:
- paste or invent source code, or pseudo-code for anything but a genuinely
  novel algorithm;
- add per-function implementation detail that a ticket would own;
- add raw data, or a list padded to look thorough rather than to inform.

Do not simply restate the PRD or user prompt. Reframe the relevant parts from a
technical point of view. An engineer reading the spec should understand what
we're building and how without reading the PRD.

## Show before telling

Diagrams and tables first, words second. Use prose only for what a diagram or
table can't show (a reason, a trade-off, a constraint).

- **Flows**: a sequence diagram per key flow, a flowchart per decision rule.
- **Data**: a Mermaid ER diagram plus one column table per entity, and a state
  diagram for every status column.
- **API**: the OpenAPI file holds the detail. In the spec, list the endpoints in
  a short table and refer to each by `METHOD /path` (e.g.
  `POST /v1/payments`). Never repeat schemas in prose.

## Leave the conversation out

The spec is read by engineers who were never in the conversation that produced
it, often months later. Nothing in it should read as the second half of a
dialogue: no "as requested", "as we discussed", "you mentioned", "per the
thread above", and no requirement phrased as an answer to something the user
said.

Language the user reached for while steering you (a rough analogy, a
placeholder name, a throwaway example) is not project vocabulary. Use what the
domain and the existing code call the thing, and record it in the glossary.

## Scope

Before designing, gather what exists:

- What exists today, and what can be reused?
- Greenfield or brownfield? What scale does the current system run at? See
  [`references/context.md`](references/context.md).
- New API contracts or extend existing ones? See
  [`references/api.md`](references/api.md).
- Existing database? Use it, and prefer the smallest change. See
  [`references/data.md`](references/data.md).

## What a good spec covers

A reasonable default order. Include what serves the epic and skip what doesn't.
Open choices are resolved with the user before drafting; the spec records the
resulting plan, not the deliberation.

1. **What we are building.** The problem and the solution in a few sentences.
   A reader should know at a glance what this is.
2. **Goals and non-goals.** Goals are a short list of what the work achieves.
   Non-goals are things that could reasonably be goals and are explicitly
   chosen not to be. They stop "but shouldn't it also..." before it starts and
   mark the epic's edges for whoever writes tickets.
3. **Context and scale.** Greenfield or brownfield, the scale estimate and its
   source, and the constraints that follow from it. A few bullets.
4. **Glossary.** Domain terms this spec introduces or relies on, one name per
   concept. See [`references/types-naming.md`](references/types-naming.md).
5. **Architecture.** One diagram of the parts and how they connect. Add a
   second, focused diagram only if one would get crowded.
6. **API.** An endpoint table (`METHOD /path`, purpose, new or changed) and a
   link to `openapi.yaml`. Note any design choice a reader would question, such
   as one combined polling endpoint.
7. **Data.** ER diagram, column tables, state diagrams, migration notes.
8. **Flows.** Sequence diagrams and flowcharts for the key flows, including
   failure paths.
9. **Testing approach.** What gets tested at which level (unit, integration,
   contract, end to end), and which risky behaviors each stage must prove.
10. **Stages.** The build broken into stages, in the order they can be built.
    Each stage says what it delivers and what it depends on. Mark stages that
    can run in parallel.
11. **Open questions.** Anything still undecided, with who decides.

## Keep it lean

Match depth to the size of the work. The detail lives in `openapi.yaml` and the
column tables, so the spec's body stays short: **one to three pages** of
readable content is a good default. A tightly scoped change (a new status type,
a metrics panel over existing data) can be shorter. A net-new system earns
more. Don't pad a small spec or cram a large one. Ship it **timely rather than
polished**: plain language, short sentences, no walls of text.

## A living document

A spec isn't frozen when it's written. Give it a single named **owner** and a
**status** (Draft, In review, Approved, In progress, Shipped), and expect it to
change as plans meet reality. Keep it current in place. An out-of-date spec
that still reads as authoritative is worse than none, because people stop
trusting it. Once the work has shipped, the spec describes how the system
actually works and is the entry point for the next person.

## Title convention

`Spec: <epic name>`, e.g. `Spec: Vendor invoice ingestion`. If other specs or
TRDs are visible where this one will live, match their naming pattern instead.

## Providers and flows

The rules above define what a spec says, regardless of where it lives. Where it
lands is a separate step:
[`references/publish.md`](references/publish.md) writes
`.claude/docs/specs/<slug>/spec.md` and `.claude/docs/specs/<slug>/openapi.yaml`
by **default**, and publishes to a connected doc-store MCP (Confluence, Notion,
Google Docs, ...) only when the user asks for one.

Those files are agent working notes, not repo documentation. If the repo
gitignores `.claude/`, say so when you write one: the spec won't travel with
the code, and a doc store is the better home for it.

- **Creating** from scratch (no existing document, or the user asks to write or
  plan one): follow [`references/create.md`](references/create.md).
- **Updating** an existing spec the user points at: follow
  [`references/update.md`](references/update.md). It's the more cautious flow,
  built for a document that evolves stage by stage.
