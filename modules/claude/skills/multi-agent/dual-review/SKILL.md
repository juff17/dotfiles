---
name: dual-review
description: >-
  Check a finished document with two independent reviewers that use the same
  rubric and must both pass it. Issues get fixed and re-checked by fresh
  reviewers, at most 2 rounds, then the rest goes to the user. For documents
  with no test to check them: specs, TRDs, tickets, READMEs, system overviews,
  anything quoting APIs, file paths, versions, or numbers. Use when the user
  asks to double-check, verify, or dual-review a doc, or before publishing a
  spec or ticket. Not for code (use /code-review and tests).
license: MIT
---

# Dual review

One reviewer misses things for the same reasons the writer did. Two reviewers
that can't see each other miss less, so **both must pass**. If only one of
them flags an issue, treat the issue as real.

## When to use

| Use it | Don't |
|---|---|
| Specs, tickets, READMEs, system-overview pages, release notes | Code: `/code-review`, tests and linters already check it |
| Docs that quote APIs, paths, config keys, versions, or numbers | Drafts you're still shaping |
| Before publishing to a tracker or doc store | Anything a build, lint, or test already verifies |

## Workflow

### 1. Build the rubric

Every criterion needs an objective pass/fail condition. Start from this base
and add the rules of the skill that wrote the doc (read its SKILL.md and turn
its "do" and "don't" rules into criteria):

| Criterion | Fails when |
|---|---|
| Accurate | A file, function, endpoint, config key, column, version, or command doesn't exist or doesn't behave as stated. Reviewers check against the repo |
| Complete | A requirement from the source (PRD, ticket, request) is missing |
| Consistent | Two parts disagree: a name, a type, a status value, a number |
| Decided | Something is left vague ("handle errors appropriately", "fast") without a stated rule or an Open questions entry |
| Self-contained | A line only makes sense to someone who saw the conversation |
| Format | Breaks the writing skill's own format rules |

Show the rubric to the user only if you added criteria they didn't ask for.

### 2. Launch two reviewers in parallel

One message, two `Agent` calls, identical prompts. Each gets the source
material, the doc, the rubric, and read access to the repo. Neither sees the
other's review or this conversation.

```text
You are an independent reviewer. No one else's review is visible to you.

Source material (what the doc must satisfy):
<PRD, ticket, request, or "the repo at <path>">

Document under review:
<path or full text>

Rubric:
<criteria with fail conditions>

For each criterion, check the document and return PASS or FAIL. For every
FAIL, quote the exact line and say what is wrong. Verify claims about code by
reading the code; don't trust the doc.

Return:
- verdict: PASS or FAIL (FAIL if any criterion fails)
- issues: [{criterion, quote, problem, fix}]  (blocking)
- suggestions: [...]  (optional, non-blocking)

Your job is to find problems, not to approve. Don't flag style preferences
that no criterion covers.
```

### 3. Gate

- **Both PASS:** done.
- **Otherwise:** merge both issue lists and remove duplicates. Keep issues
  only one reviewer found.

### 4. Fix and re-check

- **You** fix the issues (reviewers never edit). Change only the flagged lines;
  no rewrites or extra improvements.
- Launch **two new reviewers** with the fixed doc. Never reuse a reviewer: it
  will tend to approve the fixes it asked for.
- **Stop after 2 rounds.** If issues remain, hand them to the user with the
  quotes and your proposed fixes.

## Report

- **Result:** passed in round N, or N issues left for the user.
- **Fixed:** one bullet per issue fixed, with the line it changed.
- **Left for you:** remaining issues and why they weren't fixed (a reviewer
  disagreement, a decision only the user can make).
- **Suggestions** worth a look, if any. Don't apply them unasked.
