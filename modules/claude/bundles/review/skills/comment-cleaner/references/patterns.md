# Signal Catalog — AI / low-value comment patterns

The script does the pattern-matching; this file explains the *why* behind each
signal, so you can judge the review candidates it deliberately leaves undecided.

---

## The two principles

These outrank any individual pattern:

1. **WHAT vs WHY.** A comment that restates what the code does is noise. A comment
   that explains *why* — intent, a constraint, a trade-off, a non-obvious
   consequence, a cross-system fact — earns its place. **Length is not the test —
   value is.** A 150-char comment explaining a soft-delete edge case is good; a
   5-word comment mirroring the next line is bad. Length cuts both ways, though: a
   long comment is not good *because* it's long. Verbose narration you could have
   gotten just as easily by reading the code is the worst bloat — it costs the most
   to read and tells you nothing the code didn't.
2. **Density over presence.** Most single narration comments are individually
   defensible (a human might write them too). The real tell is a *file full of
   them*, or the *same generic boilerplate repeated across sibling files* (e.g.
   `// Define the shape of the context` / `// Create the context with a default
   value` appearing verbatim in every context file). Judge files, not just lines.

---

## Tier 1 — high-confidence leaks

Artifacts of the prompt/ticket that drove the work. Almost always remove or rewrite.

### Acceptance-criteria references — `AC#N`
An `AC` followed by a number — `AC#5`, `AC4`, `AC #2` — or the literal "acceptance
criteria". Near-zero false positives.
```
// 3. Find-or-create the single seed evaluation_run for this sample (AC#5).
/** … non-production env (`NODE_ENV !== 'production'`) — AC#2, no flag bypass … */
```
The comment body is often useful; the defect is just the `(AC#N)` tag.
**Fix:** strip the tag, keep the explanation.

### Numbered step narration — `Step N:` and `N.`
A comment that *begins* with `Step` + a number, or with a bare number-and-dot like
`1. ` / `2. ` at the start of the line. Humans rarely number inline steps; AI does:
```
// Step 1: Get file metadata for annotation
// Step 2: Create finding with annotation
```
**Judge what the steps add.** Always weigh whether the numbering meaningfully helps
a future developer understand the code.

### Ticket as source-of-truth
The scanner only flags tickets from the projects configured in
`KNOWN_TICKET_PREFIXES` (`scan.py`), so every ticket finding is a real ticket —
your only call is leak vs. benign reference.

It's a **leak** when the phrasing treats the ticket as the authority for the
implementation:
```
// shapes are provisional — reconcile against the full graph spec on APP-16789
/** Provisional — confirm against APP-16789. */
// Document Relationship Graph — read API (APP-16789 contract)
```
Phrasing like *confirm/reconcile against*, *per the*, *tracked in*, *implements the
ticket* is the tell. Without it, the ticket is a benign reference — Tier 2, usually keep.

### Reader-addressed / conversational
The comment talks to the prompt's reader, not a future maintainer:
```
// Remove the loading entry or mark as error if you want
// In production, you might want to stream directly to your AI service
// You can also temporarily make the annotation visible if needed
```
**Exclude** commented-out third-party config snippets (e.g. copied Sentry setup) —
those carry vendor docs.

### Placeholder / "implement this" leftovers
```
// In real implementation, this would:
// TODO: implement the actual logic
```
Phrasings like "in a/the real implementation…", "implement this / the actual…", or
a `TODO` to "implement" something.

### Agent / assistant tool markers
A comment that *starts* with an agent/tool name and a colon — the convention those
tools use to tag their own output — or an explicit "AI-generated" attribution:
```
// ponytail: switch to pixels later
# caveman: terse note
/* AI-generated layout helper */
```
Anchored to the comment start, so prose like "ask claude:" and the CSS `cursor:`
property don't trip it. The note after the marker may be a real *why* — keep that
part if so; the defect is the marker tag itself.
**Fix:** strip the marker (and the whole comment if nothing of value remains).

### Design-doc / Figma references
`figma.com`, `atlassian.net/wiki`, `confluence` — see Tier 2; the script flags
these as review (a wiki/TRD pointer can be a legitimate, if borderline, breadcrumb).

---

## Tier 2 — review candidates (need judgment)

The script emits these **with the next line of code** so you can apply WHAT-vs-WHY.

### Narration that restates the next line
AI narrates each line. Detected two ways: a leading narration verb
(`Define/Create/Set/Get/Store/Update/Check if/Return/Handle/Map/Filter/…` + an
article), or high word-overlap between the comment and the next code line.
```
// Create the optimistic comment      →  const optimisticComment = {…}     ← cut
// Update the annotations              →  setAnnotations(next)              ← cut
// Define the shape of the context     →  interface FooContextType {        ← cut
// Check if document is already cached  →  if (cache.has(key)) {            ← borderline; cut if obvious
```
Per-comment this is a *weak* signal — confirm with the code line, and weight up
when the file is narration-dense.

### "This function/component does X"
```
// This function creates visitors and accounts in Pendo   ← cut (name already says it)
// This is critical because some code uses id, others commentId  ← KEEP (explains why)
// This ensures comments appear even if annotation processing fails  ← KEEP (consequence)
```
"This <verb>s the <noun>" mirroring the symbol name → cut. "This is critical
because…" / "This ensures … even if…" → keep.

### Numbered-step prefix `N.` outside sequential files
A bare `// 1.` / `// 2.` in regular code (not a migration/example) — often the same
step-narration tell, but sometimes a genuine enumerated list. Judge by content.

---

## Tier 3 — weak signals (never flag alone)

High false-positive rate; use only to *boost* a comment already flagged above, or
to assess file-level density. The script does **not** report these as findings.

| Signal | Why it's weak |
|--------|---------------|
| `we` / `let's` narration | Usually legit ("we need viewport coords for PSPDFKit"). |
| `for now` / `temporary` / `placeholder` | "placeholder" is often a domain word. |
| `NOTE:` / `IMPORTANT:` | Frequently introduce genuinely useful facts. |
| `if needed` / `if necessary` | Short, legit. |
| `e.g.` / `for example` | Overwhelmingly legitimate. |
| `used to` / `no longer` | "is **used to** X" is purpose, not history. |

---

## False-positive traps

Most traps are flagged inline with their signal above — migration/`*.example.*`
numbering, commented-out vendor config, domain words like `placeholder`. One isn't
tied to a single signal:

- **Doc-comment convention:** `/** Returns the parsed value */` (JSDoc), PHP
  docblocks and Python docstrings legitimately describe an API; the script exempts
  them from narration flagging — don't manually re-flag them. Go doc comments look
  like plain `//` lines, so they aren't auto-exempt — keep the idiomatic ones
  (`// Name verbs…`) when you see them in review.

Whenever a candidate sits in one of these traps, lean toward **keep** unless the
code line confirms it's genuinely redundant.

---

## What good comments look like

Model the "keep" set on these — they explain something the code cannot show:
```
// SampleField uses soft-delete (deletedAt); this only nulls sampleFieldId on a hard delete.
// Chunk into batches of 20 and run up to 5 dismiss calls in parallel to avoid overloading the DB.
// Keep the sidebar highlight in sync with the URL so it updates when navigating to a Comments-only request.
/** With includeRaw: true, withStructuredOutput swallows schema-validation failures: parsed resolves to null. */
// NOTE: the `label` column was removed; the display label now comes from the linked SampleField.
```
Common trait: they encode a **constraint, trade-off, gotcha, or cross-system fact**.