---
name: explain-visual
description: >
  Explain code, a commit, a diff, or a PR to a visual learner — ASCII diagrams
  and short bullets instead of dense prose. Use whenever the user wants to
  understand code they didn't write: "explain this commit", "explain the
  changes", "walk me through this file", "what does this do", "help me
  understand what you just wrote", "explain this PR".
license: MIT
---

# explain-visual — explain code to someone who thinks in pictures

The reader is a working engineer. They are **not** slow — they are *visual*, and
they drown in walls of prose. They want the shape of the thing first, then the
parts, and they will ask for the granular bits themselves.

Your job is **selection, not compression**. Cutting words from a bloated
explanation still leaves a bloated explanation. Instead: decide what actually
matters, show it as a picture, and leave the rest for follow-ups.

## The prime directive

> **If the reader has to re-read a line, you failed.**

## Hard rules — non-negotiable

- **No paragraphs.** Ever. Bullets and sub-bullets only.
- **One idea per bullet.** Max ~15 words. If it needs a comma splice, split it.
- **Max 2 levels of nesting.** A third level means you went too deep — cut it or
  save it for the Ask-me-about section.
- **Always draw at least one diagram.** ASCII, in a fenced code block. Never skip
  it, even for a small change — a small change gets a small diagram.
- **Define jargon inline, on first use.** `idempotency key (a token that makes a
  retry safe)`, `backpressure (slowing the producer when the queue fills)`. No
  exceptions for "obvious" terms — the reader may not share your context.
- **Snippets: max 3, max ~8 lines each.** Only where the code itself is the point.
  Never paste a file. Never paste a diff hunk verbatim.
- **Don't inventory files.** Group the boring ones into one bullet: `+ 6 test
  files, 2 configs — nothing surprising`.
- **Lead with the "why".** What broke / what was missing comes before what changed.

## Output shape

Use these exact seven sections, in order. Skip a section only if it is genuinely
empty (rare).

The sections are a funnel: **what it is** (1–2) → **how it works** (3–4) → **where
to look** (5) → **what's broken** (6) → **what's left** (7). Every section earns its
place by answering a question the last one raised.

### 1. `## TL;DR`
- 2–4 bullets. Plain language. Zero jargon.
- Bullet one = **the problem**. Bullet two = **the fix**.
- A teammate should be able to stop reading here and still be correct.
- If you found something in **Watch out** that could bite in production, add one
  bullet here: `- ⚠️ <the thing>` — and say it flatly.

### 2. `## The shape`
- One ASCII diagram in a fenced block.
- Pick the diagram that matches the change — see `references/diagrams.md`.
- **Mark the change on the diagram itself.** New things get `*`, changed things
  get `~`, deleted things get `x`. Add a one-line legend.
- Follow with 1–2 bullets max, only if the picture needs a caption.

### 3. `## The pieces`
- One bullet per moving part — a component, not a file.
- Sub-bullet: what it does now, in one line.
- Sub-bullet: what changed, in one line, only if it changed.
- Cap at **7 top-level bullets**. More than that means you're listing, not
  explaining — group them.

### 4. `## Follow the path`
- **One** concrete trace through the change, start to finish.
- Numbered steps, one line each, max ~8 steps.
- Use a real example with real values. Pick values from *this* codebase's domain:
  - ✅ `a 12 MB PDF is uploaded →` … `→ resized to 2 MB, cached for 1h`
  - ❌ `the user submits input →` … `→ the system processes it`
- This is where the reader "gets it". Make it concrete or don't bother.

### 5. `## Read this, skip that`

The reader's attention is the scarcest thing you are spending. **Spend it on the
load-bearing code and explicitly give them permission to ignore the rest.**

- **Read** — 2–4 bullets, max. Each is `path/to/file:120-160` + *why it earns the click*.
  - Pick the code where the **decisions** live: the formula, the state transition,
    the guard/condition, the retry, the concurrency-sensitive bit.
  - Say what to look for once they're there: `this is the only place the token is
    refreshed — everything else reads a cached copy`.
- **Skip** — one bullet. Group all of it. Name it so they trust the grouping.
  - Typical skippables: DI/module wiring, imports, type/DTO/schema declarations,
    mechanical call-site renames, generated migrations, boilerplate CRUD,
    test scaffolding, lockfiles, snapshots.
  - `Skip: the 4 wiring files + the 2 type declarations — no logic in them.`

A change can touch 40 files and have **two** that matter. Say which two.
If the reader opens a file you sent them to and finds boilerplate, you have
spent their trust for nothing.

### 6. `## Watch out`
- Things that look **wrong, risky, or surprising**. Not questions — findings.
- **Cap at 5.** Ranked by blast radius: production impact first, cleanup last.
  More than 5 and you're dumping, not prioritising — the rest go to "Ask me about".
- Omit the section **only** if you genuinely found nothing. Say nothing rather
  than manufacture filler.

**Every finding obeys the same readability rules as the rest of the doc.** An audit
that reads like a wall of text is just a wall of text. Exactly two lines each:

- **Line 1 — the finding, in plain language.** What is broken. No jargon, no code
  dump, no hedging.
- **Line 2 (sub-bullet) — the consequence, concretely.** Who feels it, when, how bad.
  Include `file.ts:line` here, not in line 1 — the pointer is evidence, not the point.

```
- ⚠️ The cache is never invalidated on write.
  - `save()` updates the row but not the cached copy (store.js:142). Readers keep
    serving the old value for the full 1h TTL — an edit looks like it silently failed.
```

Not this — same finding, reader gone:

```
- The updateRecord/patchRecord/mergeRecord calls added in store.js are invoked without a
  corresponding invalidate() on the cache layer which, given that the read path in
  fetchRecord consults the cache before the datastore and the TTL is configured at 3600
  seconds in config/cache.yml, means that any mutation performed through... [reader gone]
```

**Scope honestly.** This is what you tripped over while reading — it is **not** an
audit. Close the section with one line so the reader calibrates:

> Found while reading, not a full audit — run `/code-review` for real coverage.

**State findings as statements, not questions.** These two say the same thing;
only one gets acted on:

| ❌ Buried as a question | ✅ Stated as a finding |
|---|---|
| `Existing rows get the new default — intentional?` | `Existing rows changed behaviour on deploy. The migration adds the column with a default but never backfills, so every record written under the old code silently switched to the new setting the moment this shipped.` |

Rule of thumb: **if a senior engineer would leave it as a PR comment, it belongs
here — not in "Ask me about".**

Reader-facing honesty beats politeness. You are explaining code the reader has to
own. Hiding a landmine to keep the tone light is the worst thing you can do to them.

### 7. `## Ask me about`
- 3–5 bullets. Each names a granular thing you deliberately skipped.
- Phrase as a question the reader might have.
- This is a **promise, not a summary** — it tells them the detail exists and is
  one question away.
- **Detail you skipped for brevity — never a risk you softened.** Risks go in
  **Watch out**. If a bullet here would make the reader change the code, it is in
  the wrong section.

## Before you write

1. **Read enough to be right.** Get the diff / the file. Skim adjacent code so
   the trace in section 4 is real, not plausible.
2. **Find the one sentence.** "This makes X work when Y." If you can't say it, you
   don't understand it yet — go read more.
3. **Pick the diagram type first** (`references/diagrams.md`), then write around it.
4. **Ruthlessly drop.** Ask of every bullet: *would the reader act differently
   without this?* No → cut it, and offer it in "Ask me about".
5. **Verify before you assert.** Short format tempts you to state things crisply
   that you only half-checked. A confident wrong bullet is worse than a paragraph.
   Especially: *migrations* (does it actually backfill, or just default?), *defaults*
   (what was the old value?), *dead code* (grep before calling it unused).
   Brevity is a style, never an excuse to skip reading.
6. **Count by reading, never by multiplying.** `4 types × 4 modes = 16` is a guess
   dressed as a fact — one of those combinations is usually special-cased. Grep the
   enum, read the constructor, count what the code actually builds. This is the single
   most common way a crisp-sounding bullet turns out to be wrong.

## Scaling to size

| Change size | What to do |
|---|---|
| A function / small diff | One diagram, skip "The pieces", keep it to a screen. |
| A commit / feature | All seven sections. Default mode. |
| A 30+ file epic | Diagram the **flow**, not the files. Group by subsystem. Offer to go per-subsystem next. |

## Escalating to real diagrams

The terminal can't render Mermaid. ASCII always works — that's the default.

**Offer** (don't assume) an Artifact when the change is genuinely big or spatial —
lots of moving parts, state machines, data models:

> Want this as a visual page with proper rendered diagrams? I can publish it.

If they say yes, build an HTML artifact: real Mermaid-style rendered diagrams,
colour-coded new/changed/removed, the same bullets. Load the `artifact-design`
skill first.

## Anti-patterns — what failure looks like

- ❌ A tidy paragraph "to give context first". **Delete it.**
- ❌ "Let's walk through the changes file by file." That's an inventory, not an
  explanation.
- ❌ Restating the diff in English: `changed maxRetries from 3 to 10`. Say what it
  *means*: `a failing request now hammers the API for 40s instead of 6 before giving up`.
- ❌ Diagram that's just boxes named after files. Diagram the **flow of data or
  control**, not the directory tree.
- ❌ Hedging: "this appears to possibly handle...". Go read the code and be sure.
- ❌ Dumping every edge case. Pick the main path; the edge cases go in "Ask me about".
- ❌ **Softening a real bug into a polite question.** `Is that intentional?` is how a
  production incident gets read as a design note. State it. Rank it. Own it.
- ❌ Trading accuracy for brevity. Short and wrong is the one failure mode worse
  than long and right.
- ❌ **An audit that's an info dump.** 9 unranked findings in dense prose is the wall
  of text you were hired to prevent. Rank, cap at 5, two lines each.
- ❌ **Sending the reader into boilerplate.** Pointing at wiring, imports, or type
  declarations wastes the one thing they gave you: attention. Point at the decision —
  the formula, the guard, the race, the retry.
- ❌ **Examples borrowed from another codebase.** Every number, name, and trace must
  come from the code in front of you. A generic `foo/bar` walkthrough teaches nothing.
