---
name: council
description: >-
  Get four independent views on a hard decision before choosing: Claude as
  Architect plus three fresh subagents (Skeptic, Pragmatist, Critic) that see
  only the question, not the conversation. Reports each position, the
  strongest dissent, and a recommendation. Use for decisions that are hard to
  undo, trade-offs with no clear winner, go/no-go calls, or when the user asks
  for a council, second opinions, dissent, or "poke holes in this". Not for
  code review, factual questions, or plain implementation work.
license: MIT
---

# Council

Four voices weigh in on one decision. Three run as fresh subagents that get
**only the question and a short context, never the conversation**. That is
the point of the skill: a conversation that has already leaned toward one
option pulls every later opinion toward it, and fresh subagents don't carry
that lean.

## When to use

| Use it | Use something else |
|---|---|
| A decision with 2+ credible paths and no clear winner | Factual questions: answer directly |
| Hard-to-undo choices: data model, public API, vendor, architecture | Checking a finished doc for errors: `dual-review` |
| Go/no-go and scope calls: ship now or hold, cut or keep | Reviewing code: `/code-review` |
| The chat has settled on one option and you want it challenged | Obvious tasks: just do them |

## Voices

| Voice | Who | Focus |
|---|---|---|
| Architect | You, in the main conversation | Correctness, maintainability, long-term effects |
| Skeptic | Fresh subagent | Challenges the question itself, offers the simplest option that could work |
| Pragmatist | Fresh subagent | Speed of shipping, user impact, day-to-day operations |
| Critic | Fresh subagent | Edge cases, downside risk, how the plan fails |

## Workflow

### 1. State the decision

Reduce it to one question with:
- what is being decided, and the options on the table;
- the constraints that matter (deadline, team size, scale, existing systems);
- what success looks like.

If the question is vague, ask the user one clarifying question first.

### 2. Gather only the needed context

- For a codebase decision: the few files, snippets, metrics, or ticket text
  that change the answer. Keep it short.
- For a strategy decision: skip code unless it changes the answer.
- Leave out the user's stated preference and your own lean. Present the
  options neutrally.

### 3. Write the Architect position first

Before launching anyone, write down (keep it, don't show it yet):
- your position;
- the three strongest reasons for it;
- the main risk in your preferred path.

This keeps the synthesis from simply adopting whatever the subagents say.

### 4. Launch the three voices in parallel

One message, three `Agent` calls, no conversation history. Prompt:

```text
You are the <ROLE> on a four-voice decision council. <ROLE FOCUS>

Question:
<the decision question and options>

Context:
<only the relevant snippets or constraints>

Respond with:
1. Position: 1-2 sentences.
2. Reasoning: 3 short bullets.
3. Risk: the biggest risk in your own recommendation.
4. Blind spot: one thing the other voices are likely to miss.

Be direct. No hedging. Under 300 words.
```

Role focus lines:
- **Skeptic:** "Challenge how the question is framed, question its
  assumptions, and propose the simplest option that could work, including
  doing nothing."
- **Pragmatist:** "Optimize for shipping soon, user impact, and what the team
  can actually run and maintain."
- **Critic:** "Find the downside risks, edge cases, and the most likely way
  each option fails."

### 5. Synthesize

You are both a voice and the judge, so:
- don't dismiss another voice without saying why;
- if a voice changed your recommendation, say so;
- always report the strongest dissent, even if you reject it;
- if two voices agree against your position, treat that as a real signal and
  address it directly.

### 6. Report

```markdown
## Council: <short decision title>

| Voice | Position | Why |
|---|---|---|
| Architect | <1-2 sentences> | <1 line> |
| Skeptic | ... | ... |
| Pragmatist | ... | ... |
| Critic | ... | ... |

- **Agreement:** <where they align>
- **Strongest dissent:** <the most important disagreement>
- **Premise check:** <did the Skeptic challenge the question itself, and does it hold?>
- **Recommendation:** <the path, and what would change it>
```

## Follow-up rounds

One round is the default. For another round, keep the new question narrow and
include the previous verdict only if the voices need it. Give the Skeptic as
little of the previous round as possible.

If the outcome is a lasting architecture decision, offer to record it in the
relevant spec (`create-spec`). Don't save every council result.

## Don't

- Pass the conversation or your own lean to the subagents.
- Use it for code review or implementation planning.
- Hide disagreement in the summary to make the answer look clean.
