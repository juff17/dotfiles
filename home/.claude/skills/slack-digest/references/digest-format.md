# Digest format

The final canvas document the assembler writes to `digest.md`. Audience: whoever is
defined in `config.yaml` (`audience`) — assume high context, low time. This is a
**narrative** digest: a short org-wide synthesis up top, then one prose section per
group. It should read in ~5 minutes and tell the reader the *direction* of each
team, not just a list of items.

## Tone (applies to the whole document)
- Generally **positive or neutral** — never negative or alarmist.
- Always **professional**, never casual. No slang, no emoji except the section
  markers defined below.
- Report **outcomes, not deliberation** (the resolution, not "X said then Y said").

## Structure (in this order; omit any section that's empty)

```markdown
# Daily Slack Digest — <YYYY-MM-DD>

## Across the Organization
<3–5 sentence written synthesis tying the groups' work together: the overall
direction, how threads connect, what's converging. Optimistic-or-neutral.>

> **Action for everyone:**
> - <one announcement action or org-wide notice, one tight phrase>
> - <next one>
> - <...one bullet per item...>

## <Group name>
**Overview**
- <key point> · [thread](<link>)
- **Unaddressed:** <cross-team request (review/question/update) with no reply, age> · [thread](<link>)
- <long-running-thread update> · [thread](<link>)
- <cross-team-collaboration update> · [thread](<link>)

**Summary**
<A high-level, plain-language synthesis of the team's direction — NOT the Overview
bullets re-typed as a paragraph. Name the through-line and group related items; let the
Overview carry the full list. One paragraph (two only if truly justified). Lead with the
overall direction or what landed. **Bold** only the criticals (unaddressed cross-team
requests, finalizations/reversals). Cover follow-ups and long-running-thread updates;
keep precise technical terms in the Overview and use plainer language here. Put the
**open questions near the END**.>

<...repeat one section per group...>
```

### Overview vs. Summary — worked contrast

The two views do different jobs. The Overview is the scannable, precise list; the
Summary is the synthesis a busy reader gets if they read nothing else.

✅ **Good summary** (synthesizes — names the direction, groups items, plain language):

> The payments and web teams effectively **locked the checkout v2 contract** this week
> after a long design push, leaving just one open disagreement — how the API is
> versioned — for today's sync. The work is converging fast, but it's now **blocked on
> the web team**: two review requests have sat overnight and are holding up client
> generation. The launch date is the thing to watch — engineering says the marketing
> team's target is only safe if that last decision lands now.

❌ **Bad summary** (info-dump — one sentence per bullet, same order, no synthesis):

> The team froze the error contract as `{ error: { code, message, param?, retriable } }`
> over a closed enum. They decided on a shared `checkout_v2` flag ramping 5/25/100.
> Payments owns the OpenAPI spec. Compliance signed off on token-only confirm. ACH is
> fast-follow. PR #812 and PR #9925 need web review. Versioning goes to a sync.

The bad version is just the Overview re-typed — it drags technical specifics down from
the bullets and adds nothing. Write the good kind.

## Rules
- **H1** is `delivery.canvas_title` with the date substituted.
- **Across the Organization** comes first and is synthesis, not a list — draw it from each
  group's `headline`. State the through-line: what's converging, what direction the
  org is heading. Keep it to 3–5 sentences.
- **Action is never buried.** Every announcement action plus any org-wide notice
  goes in the "Action for everyone" blockquote. When there is **more than one** item,
  render them as a bulleted list inside the blockquote (one `> - ` bullet per item);
  with only a single item, keep it inline on the `> **Action for everyone:**` line.
  Omit the blockquote entirely if there are no announcement actions and no notices.
  Every `unaddressed_request` from a group appears as a **bolded** `**Unaddressed:**`
  bullet in that group's Overview *and* is named as a follow-up in its Summary. These
  require the reader to act — make them visible.
- **Overview = scannable bullets** (the headline items, links attached).
  **Summary = prose** (direction + scope, criticals bolded, open questions last) —
  one paragraph, two at most. At most one sentence per event; two only for a major
  topic (finalization of a long-running discussion; a major decision/change that
  needs detail to grasp; an important specific that can't be omitted).
- **The Summary synthesizes; it does not echo the Overview.** The two views are not
  "the same items, once as bullets and once as prose" — the Overview is the precise
  scannable list, and the Summary is a higher-level through-line that ties items
  together in plainer language. A critical item (an unaddressed request, a reversal)
  may appear in both, but the Summary must add synthesis, never re-list bullet by
  bullet. Do not repeat the same item across two different groups.
- **Be selective in the Overview.** Aim for ~5–7 bullets per group — only what a busy
  staff+/director reader would act on or change a plan over. Drop internal
  implementation choices with no cross-team or customer impact; "it's a decision" does
  not by itself earn a bullet. The summarizer ranks these, but hold the line at assembly.
- **Link every Overview bullet** to its permalink as `[thread](<link>)`. The Summary
  is clean prose — keep links in the Overview, not inline in the paragraph.
- **Omit empty sections** entirely — never write "none" or an empty header. If a
  group has no reportable activity, omit the whole group section.
- Markdown only (Slack canvas renders markdown). No HTML.
