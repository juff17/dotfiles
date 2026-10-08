---
name: explain-visual
description: >
  Explain code, a commit, a diff, or a PR to a visual learner — rendered diagrams
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
- **Always draw at least one diagram, and one per flow the change touches.** Mermaid,
  in a ```mermaid fence — VS Code's preview renders it. Never skip it; a small change
  gets a small diagram.
- **Never hand-draw ASCII diagrams.** Not as a fallback, not for "spatial" things, not
  ever. Box art is the wall of characters this skill exists to prevent. Mermaid has a
  shape for every case (`references/diagrams.md`); before/after values go in a markdown
  table.
- **Define jargon inline, on first use.** `idempotency key (a token that makes a
  retry safe)`, `backpressure (slowing the producer when the queue fills)`. No
  exceptions for "obvious" terms — the reader may not share your context.
- **Snippets: max 3, max ~8 lines each.** Only where the code itself is the point.
  Never paste a file. Never paste a diff hunk verbatim.
- **Don't inventory files.** Group the boring ones into one bullet: `+ 6 test
  files, 2 configs — nothing surprising`.
- **Lead with the "why".** What broke / what was missing comes before what changed.

## Code references — how to link without making a mess

The doc is read in **VS Code's markdown preview**, so a ref must be a real markdown
link. A bare `path:line` in backticks is clickable in the Claude Code *terminal* but is
**inert text in the preview** — it looks like a link and does nothing.

**The format:**

```
— [notification.service.ts:16](/apps/api/src/modules/notification/notification.service.ts#L16)
```

- **Link text** = `filename:line`. Short. This is all the reader sees.
- **Href** = path from the **workspace root**, with a leading `/`, plus `#L<line>`.
  VS Code resolves `/` against the repo root, so no `../../` chains from
  `.claude/explained/`. Line ranges: `#L120-L160`.
- The long path lives in the href, where the preview hides it. **This is what keeps
  refs from becoming clutter** — a 60-char monorepo path renders as 24 visible chars.

Four rules keep refs invisible until wanted:

1. **Trailing, never inline.** The ref goes at the **end** of the line, after an em-dash.
   It must never interrupt the sentence — the reader's eye should stop at the period
   and skip it entirely.
   - ✅ `Balance is only written here; everything else reads a cache — [wallet.ts:88](/src/wallet.ts#L88)`
   - ❌ `Balance is only written in [wallet.ts:88](/src/wallet.ts#L88) and everything else reads a cache.`
2. **One ref per line.** Two or more is clutter. If a claim spans files, ref the one
   the reader should open *first*.
3. **On the detail line, not the headline.** In a bullet + sub-bullet pair, the headline
   stays clean prose; the ref rides on the sub-bullet as evidence.
4. **Never in `TL;DR`, `The shape`, or `Ask me about`.** Those are for skimming and
   orienting. A link in a diagram or a summary is pure noise.

Repeating the same ref across sections is **fine and expected** — you can't know which
one the reader will click. `Follow the path` step 4 and a `Watch out` finding may both
point at the same guard. Link it in both.

**Line numbers are pinned to the commit you read.** Verify them by opening the file —
never guess. Say in one line at the top of the doc which commit/ref it was written
against, so a reader on a moved branch knows why a link lands off by a few lines.

**In the chat summary** (not the doc), use bare `path/to/file.ts:16` — *that* is what
the Claude Code terminal makes clickable. Two surfaces, two conventions.

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

**Diagram every flow the change touches — one diagram each.** Do not cram two flows
into one picture, and do not silently cover only the biggest one.

First, **count the flows.** A flow is a distinct **entry point**: an endpoint, a cron, a
queue consumer, a user action, a boot hook. "Page load populates the badge" and "clicking
the tab clears it" are *two* flows, not one.

Then:

- **1–2 flows** → one diagram each. No map needed.
- **3+ systems touched** → open with a **system map** (`references/diagrams.md`), then one
  diagram per flow underneath. The map is the reader's index: the whole board, with the
  parts this change lit up. Without it, a multi-diagram doc has no entry point.
- **Up to ~8 flows** → still one diagram each, each under its own `###` sub-heading named
  for the flow (`### Resolving a poll`). Small and separate beats big and merged.
- **More than ~8** → say so plainly, give the system map, and ask which ones they want:
  `This touches 11 flows. Here's the map — which should I go deep on?` Do **not** silently
  truncate, and do not emit 11 diagrams.

Rules for every diagram:

- **All diagrams are mermaid.** Never ASCII. See `references/diagrams.md` for the recipes.
- Pick the diagram type that matches the flow — a state machine and a sequence can live in
  the same doc if that's what the change is.
- **Mark the change on the diagram itself.** `*` new, `~` changed, `x` removed. Caption
  each with the legend line.
- **≤15 nodes.** A diagram that needs more is two diagrams.
- 1–2 caption bullets under a diagram, only if the picture needs them.

### 3. `## The pieces`
- One bullet per moving part — a component, not a file.
- Sub-bullet: what it does now, in one line — **ending in a `path:line` ref**.
- Sub-bullet: what changed, in one line, only if it changed.
- Cap at **7 top-level bullets**. More than that means you're listing, not
  explaining — group them.

Ref the line where the piece **does its job**, not line 1 of the file. Point at the
method, not the `class` declaration.

```
- **TokenStore** — the only thing that talks to the auth server.
  - Refreshes on 401, then replays the request once — [token-store.ts:64](/src/auth/token-store.ts#L64-L91)
  - Now caches the token in memory; was hitting the network per call — [token-store.ts:30](/src/auth/token-store.ts#L30)
```

### 4. `## Follow the path`

**One trace per flow you diagrammed** — same flows, same names, same order, each under
its own `###` sub-heading. The diagram shows the shape; the trace walks it with real
values. A multi-system change has more than one path worth walking, and a single global
trace either skips flows or turns into a 20-step monster.

If you diagrammed 4 flows, write 4 traces. If a flow is genuinely trivial (one hop, no
decision), say so in a line and skip its trace rather than padding it.

- Numbered steps, one line each, max ~8 steps **per trace**.
- Use a real example with real values. Pick values from *this* codebase's domain:
  - ✅ `a 12 MB PDF is uploaded →` … `→ resized to 2 MB, cached for 1h`
  - ❌ `the user submits input →` … `→ the system processes it`
- This is where the reader "gets it". Make it concrete or don't bother.
- **Ref the steps where something happens that they'd want to see.** Not every step —
  a numbered list with a path on all 8 lines is unreadable. Ref the 3–4 steps that
  carry a decision, a transform, or a surprise. Skip the obvious hops.

```
3. The retry wrapper sees a 429 and sleeps 2^n seconds — [retry.ts:41](/src/http/retry.ts#L41)
4. On the 5th failure it gives up and returns null (it does NOT throw) — [retry.ts:58](/src/http/retry.ts#L58)
5. The caller treats null as "empty result" and caches it for an hour.
```

### 5. `## Read this, skip that`

The reader's attention is the scarcest thing you are spending. **Spend it on the
load-bearing code and explicitly give them permission to ignore the rest.**

- **Read** — 2–4 bullets, max. Each is a markdown link + *why it earns the click*:
  `- [poll.service.ts:416](/apps/api/src/poll.service.ts#L416-L480) — the deleted payout block.`
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
  dump, no hedging, **no path** — the headline must be readable at a glance.
- **Line 2 (sub-bullet) — the consequence, concretely.** Who feels it, when, how bad.
  End with the `path:line` ref — the pointer is evidence, and it belongs last.

```
- ⚠️ The cache is never invalidated on write.
  - `save()` updates the row but not the cached copy, so readers serve the old value
    for the full 1h TTL. An edit looks like it silently failed — [store.js:142](/src/store.js#L142)
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
| A function / small diff | One diagram, one trace, skip "The pieces". Keep it to a screen. |
| A commit / feature | All seven sections. One diagram + trace per flow. Default mode. |
| A multi-system epic | Lead with the **system map**, then a diagram + trace per flow (~8 max). Group "The pieces" by subsystem, not by file. |
| More than ~8 flows | Map + the flow list, then **ask which to go deep on**. Never truncate silently. |

## Output & rendering

**The doc is a file, not a chat message.** Write the seven sections to
`.claude/explained/<slug>.md` (create the folder if it doesn't exist — it lives in
whatever repo you're working in). `<slug>` names the thing explained:
`auth-refresh-commit`, `pr-482`, `wallet-ts`.

Then open it:

```bash
code -r .claude/explained/<slug>.md
```

Tell the reader to hit **`Ctrl+Shift+V`** (`Cmd+Shift+V` on macOS) for the preview —
VS Code's markdown preview renders ```mermaid fences directly, so the diagrams draw
themselves. There is no CLI flag to open straight into preview; the keystroke is the
last step and it belongs to them.

**Write mermaid so it renders.** You don't get to see the output, so don't get clever:

- Quote any label with spaces or punctuation — `B["retry (2^n) *"]`, not `B[retry (2^n) *]`.
- Parentheses, colons, and `>` inside an unquoted label are the usual syntax break.
- Keep it to one diagram type per fence. No nested subgraph acrobatics.
- If a diagram needs more than ~15 nodes, that's two diagrams, not one big one.
- **`flowchart LR` past ~5 nodes becomes an unreadable ribbon** — the reader scrolls
  sideways to follow their own diagram. Default to `flowchart TD`, and keep labels short
  so the boxes don't stretch.

**There is no ASCII fallback.** If mermaid feels wrong for something, you picked the
wrong mermaid shape — a moved quantity is an `xychart-beta`, a before/after is a
markdown table (`references/diagrams.md`). Never reach for box art.

In chat, don't paste the doc. Give the TL;DR bullets and the ⚠️ lines from
**Watch out** — what matters if they never open the file — then the path to it.

## Anti-patterns — what failure looks like

- ❌ A tidy paragraph "to give context first". **Delete it.**
- ❌ "Let's walk through the changes file by file." That's an inventory, not an
  explanation.
- ❌ Restating the diff in English: `changed maxRetries from 3 to 10`. Say what it
  *means*: `a failing request now hammers the API for 40s instead of 6 before giving up`.
- ❌ Diagram that's just boxes named after files. Diagram the **flow of data or
  control**, not the directory tree.
- ❌ **Hand-drawn ASCII box art.** There is no case for it. Mermaid renders; ASCII is the
  wall of characters you were hired to prevent.
- ❌ **Cramming three flows into one diagram** so you can keep the count at one. Three
  flows get three diagrams. Merged flows are how a picture becomes a puzzle.
- ❌ **A multi-diagram doc with no system map.** Diagram 4 of 6 with no index is worse
  than one diagram — the reader can't tell where they are.
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
- ❌ **Paths mid-sentence.** `The guard in src/a/b/c/deep/thing.ts:88 fires when…` — the
  reader now has to parse a path to finish a sentence. Move it to the end of the line.
- ❌ **A path on every line.** Refs are an escape hatch, not decoration. If the prose
  only makes sense once you click, the prose is the thing that's broken.
- ❌ **Refs pointing at the top of a file.** `foo.ts:1` says "go read a file" — which is
  what the reader came to you to avoid. Point at the line that proves the claim.
