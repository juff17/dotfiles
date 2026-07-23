---
name: slack-digest
description: Produce the morning digest of what happened in Slack yesterday. Reads only the channels in config.yaml and surfaces decisions, pending decisions, open questions, unaddressed cross-team requests, and technology changes / updates. Use when the user asks for the Slack daily update / digest / "what happened yesterday".
---

# Slack Daily Digest

Build a high-signal digest of yesterday's Slack activity for the audience defined in
`config.yaml` (`audience`). Report **outcomes, not deliberation**.

You are the orchestrator. Scripts do the mechanical work; per-group **subagents** do
the heavy reading; you assemble and publish. Keep your own context thin.

## 1. Fetch (run first, every time)
1. `bash scripts/setup.sh` — installs Python deps (no-op if present).
2. `python3 .claude/skills/slack-digest/fetch.py` — pulls the configured channels and
   writes one file per group plus `_meta.json` into a scratch **work dir** (outside the
   repo, default `/tmp/slack-digest`). It prints `Work dir: <path>` — note that path;
   everything downstream lives there, not in the skill directory.

If `fetch.py` exits non-zero, stop and report the error — never fabricate a digest.

## 2. Summarize each group (fan out)
Read `_meta.json` in the work dir for the group manifest (file paths in it are
relative to that work dir) and the `audience` string. For **each** group listed, spawn
a `group-summarizer` subagent (Task/Agent tool) — all in one batch so they run in
parallel — telling each one **(a)** its file by absolute path and **(b)** the
`audience`, e.g. *"Summarize the group in `<work dir>/group-<slug>.json` for this
audience: <audience>."* The audience steers what each subagent treats as signal
(Sales, Product, Engineering, and Operations care about different things). Each returns
a JSON object with `headline`, `overview` bullets, a prose `summary`, and
`unaddressed_requests`.

Also handle `announcements` (if present in `_meta.json`): summarize
`<work dir>/announcements.json` into actions and notices — anything the reader must DO
(technology changes / updates, credential rotations, required migrations) plus any
company-wide notice (policy change, all-hands move). Announcements are typically
company-wide, not tied to one team. You can do this inline (it's small) rather than
spawning a subagent.

## 3. Assemble (narrative)
Read `references/digest-format.md` and build the digest from the per-group objects:
- Start with the H1 from `delivery.canvas_title`, substituting the digest date
  (`_meta.json` `generated_for`).
- Write **"## Across the Organization"** — a 3-5 sentence synthesis you author from the
  groups' `headline`s: the through-line, what's converging, the overall direction.
  Prose, not a list. Optimistic-or-neutral, professional.
- Add the **"Action for everyone"** blockquote with every announcement action + any
  company-wide notice. When there is more than one item, list them as bullets inside the
  blockquote (one `> - ` per item); a single item stays inline. Omit the blockquote if
  there are none.
- Emit one **"## <Group name>"** section per group, carrying its `overview` bullets and
  prose `summary` through as written (the subagent already synthesized them — don't
  re-expand the summary into a per-bullet walk). The summary is a high-level through-line,
  not a restatement of the Overview; the Overview should be ~5-7 high-impact bullets, not
  an exhaustive list. Ensure every `unaddressed_request` shows as a bolded Overview bullet
  and is named in the summary.
- Omit any group whose findings are empty. Do not repeat the same item across groups.
- Never surface read errors in the digest. Unreadable channels are recorded in
  `_meta.json` for the operator; the published report stays clean.
Write the result to `digest.md` in the **work dir** (the path `fetch.py` printed) —
never in the skill or repo directory. `publish.py` reads it from there by default.

## 4. Publish
Run `python3 .claude/skills/slack-digest/publish.py`. It overwrites the channel canvas
in `delivery.canvas_channel` with `digest.md` (erasing yesterday). If it exits
non-zero, report the error — do not claim the canvas was posted.

## Notes
- Never widen scope beyond the channels in `config.yaml`.
- Keep the whole digest skimmable in under ~5 minutes.
