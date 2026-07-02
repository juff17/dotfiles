---
name: comment-cleaner
argument-hint: branch | full
description: >-
  Find and clean up AI-generated, low-value comments and narration
  that restates the code instead of explaining why. Branch-only or full-repo sweep.
  Use when the user wants to audit, review, or clean up AI
  comments, "comment cruft", leaked ticket references, or bloated comments.".
---

# comment-cleaner

Finds two kinds of comment problems, in any supported language:

1. **Leakage** — artifacts of the prompt/ticket that drove the work, with no
   business in committed source: acceptance-criteria tags (`AC#4`), `Step 1:`
   narration, a ticket treated as the spec (`confirm against APP-1234`), comments
   that address the reader (`you may want to…`, `feel free to…`), and agent/assistant
   tool markers (`// ponytail:`, `# caveman:`, `AI-generated`)
2. **Low-value narration** — comments that restate *what* the next line does
   instead of explaining *why*. A comment that re-says the code is noise; one
   that captures non-obvious intent, a constraint, a trade-off, or a gotcha is valuable.
   Non obvious means that a experience developer could not quickly understand something by reading the code.

**Languages:** TS/JS(X), CSS/SCSS/Sass/Less, PHP, Python, Go, Shell, Terraform/HCL, YAML.

## Workflow

### 1. Run the scanner

From the **root of the repo being scanned**, write the findings to your scratchpad:

```bash
python3 <this-skill-dir>/scripts/scan.py <branch|full> --out <your-tmp-dir>/comment-cleaner-<repo>
```

- `branch` (default) — only comments on lines changed on the current branch; the right scope for a pre-PR check.
- `full` — the whole repo.

It writes `<out>.json` (`leaks` / `reviews` / `denseFiles`) and prints a
`FLAGGED: N` total. The scanner is an **extractor, not a judge**: it does NOT
pre-filter narration. It emits **every** line comment as a `reviews` entry, each
tagged with a confidence `hint` and an `overlap` score:

- `hint: high` — the word-overlap / verb heuristics fired; likely a
  code-restating comment and your first place to look.
- `hint: low` — everything else; surfaced so nothing is silently dropped, but
  most will be legitimate keeps.

Leaks are still high-confidence. The WHAT-vs-WHY call in steps 2–4 is the
judgment the scanner deliberately leaves to you. That JSON is your working data.

### 2. Present the findings

`reviews` is the full line-comment inventory, so it's normally large — never dump
it. Work by confidence:

- **Leaks + `hint: high`** are the likely cuts and what you present. If their
  combined count is small (< ~20), list them inline: comment, the code line above
  it, and your keep/cut call (per "Applying judgment" below). Only list real
  findings — drop anything you judge legitimate, don't pad. The `.json` carries
  each code line, so you rarely need to reopen files. If it's larger, don't dump:
  summarize the dominant patterns, worst-offender files, and dense files, and
  offer inline detail for a subset (e.g. "just the leaks").
- **`hint: low`** is the long tail — comments the heuristics didn't flag,
  surfaced only so the LLM (you) can catch semantic restatement the regex can't
  model. Don't list it in chat; note the count and that most are expected keeps.
  Judge it during cleanup, not in a pre-triage.
- **No leaks and no `hint: high`** → tell the user it's clean. Done.

### 3. Offer to clean up

End by asking whether they want you to clean the comments up — e.g.
"Want me to clean these up?" Default to **report-only**; only edit on an explicit
yes. If there were zero findings, skip the offer.

### 4. Clean up (only if they say yes)

Work from the `.json`. Edit the comments in place with the smallest change that
removes the noise — **never touch the surrounding code**:

- **Leaks** → remove the leaked artifact. Strip an `(AC#4)` tag or a `Step N:` /
  leading `N.` prefix while keeping any real explanation; delete reader-addressed
  and "implement this" comments outright.
- **Review candidates** → apply WHAT-vs-WHY: delete pure narration / code-restating
  comments; **keep** the ones that explain a why; rewrite a WHAT-comment into a
  WHY-comment only where a genuine why exists (otherwise just delete it).

If the user scoped it ("just the leaks", "leave the ticket refs"), honor that.
When done, re-run the scanner to confirm and report a short summary of what you
changed (files touched, comments removed/rewritten/kept). Expect the re-scan to
still list `hint: low` entries — those are the comments you judged legitimate and
kept, not a failure. Confirm success by `leaks: 0` and the `hint: high` count
dropping to just the ones you deliberately kept, not by `FLAGGED: 0`.

## Applying judgment to review candidates

For each review candidate, ask: **does the comment tell me something the code
doesn't?**

- **Cut** when it restates the code:
  `// Create the optimistic comment` over `const optimisticComment = {…}`;
  `// Loop through the items` over `items.forEach(…)`.
- **Keep** when it explains intent / constraint / gotcha / cross-system fact:
  `// SampleField uses soft-delete, so this only nulls the FK on a hard delete`;
  `// Chunk into batches of 20 to avoid overloading the comment service`.

Watch the **false-positive traps** (full list in `references/patterns.md`):
doc-comments (JSDoc, PHP docblocks, Python docstrings, Go doc comments) get a pass
on narration. Decorative section dividers and intentional walkthroughs (usage
examples, migrations) are not leaks.

For the full signal catalog, precision notes, and worked keep-vs-cut examples,
read `references/patterns.md`.
