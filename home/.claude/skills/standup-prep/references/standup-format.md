# Standup update format

The final output. It is read **aloud at standup** — so it must be brief, scannable, and
plain. No preamble, no closing, no fluff. Three short sections, in this order. Each
bullet is one line. If a section is empty, keep the header and write `— none`.

```markdown
**Standup — <YYYY-MM-DD>**

**Yesterday**
- released APP-175232 — create new react controllers
- started APP-174214 — implement scaffolding for document search queues
- moved APP-17142 to review — implement document classification
- discussed new API contracts in #checkout-eng
- assisted John with local setup issues

**Today**
- continue APP-174214 — implement scaffolding for document search queues
- may start APP-17533 — wire up search result pagination
- will try to pick up a ticket for review
- follow up on the staging deploy I promised in #checkout-eng

**Blockers**
- APP-17890 blocked — waiting on infra access to the new cluster
```

## What goes in each section

### Yesterday (what I actually did)
Drawn from Jira movements + my public Slack messages. Lead with the most concrete work.
Use these verbs, matched to the transition:
- `released APP-… — <summary>` — I moved it to a released/done status.
- `reviewed APP-… — <summary>` — I reviewed it (moved it through/out of review).
- `moved APP-… to review — <summary>` — I sent my own work to review.
- `started APP-… — <summary>` — I created it or moved it into in-progress.
- `created APP-… — <summary>` — I opened the ticket.
- `opened MR for APP-… — <summary>` — only if an MR was clearly opened (from a Jira
  remote link or an explicit Slack message). Best-effort; omit if unsure.
- `discussed <topic> in #channel` — a substantive public thread I took part in.
- `assisted <person> with <thing>` — I helped someone in a public thread.

One line each. Drop trivia (acks, "lgtm", "thanks"). Aim for ~3–8 bullets total.

### Today (what I plan to do)
In priority order:
1. **In-progress tickets first.** If I have in-progress work, lead with `continue APP-…`.
   In-progress takes priority over To Do.
2. **To Do tickets** only as *potential* starts: `may start APP-…`. If I have any
   in-progress work, mention To Do items as "may start", not as commitments. If I have
   no in-progress work, To Do items become the real plan (`start APP-…`).
3. **Review pickup.** If there are unassigned tickets sitting in the review/MR-review
   column **whose developer is not me**, add one line: `will try to pick up a ticket for
   review`. (Never offer to review my own work — see the skill's developer check.)
4. **Promises from yesterday's Slack.** If I committed to something in a public message
   yesterday ("I'll send the doc", "I'll deploy to staging"), carry it as a follow-up.

### Blockers
Any ticket I moved **into** a blocked status yesterday, or that is currently sitting in a
blocked status assigned to me: `APP-… blocked — <reason if known>`. If none, `— none`.

## Tone & length
- Plain, first-person-implied (no "I" needed). Past tense for Yesterday, future for Today.
- Ticket key + short summary, nothing more. No links, no IDs beyond the ticket key.
- The whole thing should fit on one screen and read in under ~30 seconds.
