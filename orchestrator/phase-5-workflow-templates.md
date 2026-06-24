# Phase 5 — Workflow templates

> Generalise the hardcoded single pipeline into a declarative, selectable template engine and add the non-ticket workflows (`trd-review`, `doc-gen`).

## Value & rationale

P2+P3 hardcoded **one** pipeline: GOAL.md → implement → pr-review-toolkit → ponytail → GOAL-conformance →
push/MR → Greptile triage → decision-log. That pipeline is really an *ordered list of stages with
deterministic gates between them*. This phase extracts that shape into a **template** so the same engine can
run other workflows — the architecture already names three (`ticket-impl`, `trd-review`, `doc-gen`) and
states "TRD/doc templates reuse the same engine with different stages … selected at intake".

Why now (Stage A, before Jira/scheduler): we want the template abstraction proven on **one task at a time,
manually selected**, while the pipeline is still the only moving part. P6 later *derives* the template from
Jira issue type; doing the engine first means P6 only has to add a mapping, not a refactor. Doing it after P4
means the rebase-babysitting flow (which is template-independent — it operates on an existing MR) is already
in place and is *not* disturbed by this refactor.

The hard rules and the deterministic side-effect boundary must survive the refactor unchanged: every
template still stops at "ready for human", every state-mutating git/glab action stays in the orchestrator's
deterministic gates, and GOAL.md + decision-log stay generic across all templates.

## Dependencies (Depends on / Enables)

- **Depends on:** P3 (the full review pipeline = the reference template `ticket-impl`), and P4 (rebase
  babysitting — unchanged by this phase, but must keep working against any template's MR).
- **Enables:** P6 (Jira sync derives `workflow` = template id from issue type; this phase gives it a
  registry to select from). Indirectly enables P7/P9 which treat "current stage" uniformly across templates.

## In scope

- Refactor the P2+P3 pipeline into a **template**: an ordered list of stages, each one of four kinds —
  `agent-run | skill | reviewer | gate` (deterministic).
- A **template registry** (id → `WorkflowTemplate`) and an **explicit per-task selector** (operator passes
  the template id; no Jira/auto-derivation yet).
- A generic **engine** that walks a template's stages, interleaving deterministic gates, persisting the
  current stage to SQLite, and producing the decision-log + final summary the same way for every template.
- Ship three templates **as data**: `ticket-impl` (exactly the P3 pipeline, re-expressed), `trd-review`,
  and `doc-gen` (draft → critique → revise).
- Keep GOAL.md/artifacts and the **human-only-merge** rule holding for all templates.

## Out of scope (deferred to …)

- **Jira-driven template selection** → P6 (derives `workflow` from issue type/component/labels).
- **Scheduler / concurrency / running many templates at once** → P7.
- **Reliability** beyond the per-stage persistence that already exists (retry/timeout/circuit-breaker
  thresholds, crash-recovery reconciliation tuning) → P8.
- **UI / notifications / dashboard rendering of templates** → P9.
- New reviewers, new MCP, new sandbox work, or any change to the rebase flow (P4). This phase **re-expresses
  existing behaviour**; it does not introduce new capabilities or tools.

## Design

### Stage schema (TS)

A stage is a discriminated union on `kind`. The four kinds map exactly onto roles that already exist in the
architecture: an **agent run** (implement, triage, draft, revise), a **skill** invocation (a Claude Code
skill as a workflow step), a **reviewer** (advisory pass that returns `{findings | clean | error}` and is
triaged `address | skip | pushback`), and a **gate** (the deterministic 🔒 orchestrator step).

```ts
// Deterministic side-effects the orchestrator may perform at a gate. Closed set — no template
// can introduce a new side-effect, and none of these is `merge` (human-only-merge, hard rule).
type GateAction =
  | "commit"          // git add -A && commit -m <msg>; no-op on clean tree (idempotent)
  | "push"            // git push (force-with-lease only in the P4 rebase flow, not here)
  | "open-or-reuse-mr"// glab mr create, or reuse existing MR on the branch
  | "post-replies"    // post agent's triage replies (incl. pushback) to MR comments
  | "render-summary"  // render decision-log → human summary, post to MR, notify
  | "verify"          // run per-repo verify/build command (D-config); failure routes back to agent

type Stage =
  | { kind: "agent-run"; name: string; prompt: string; freshAgent?: boolean }
  // freshAgent:true => NOT the implementer session (e.g. GOAL-conformance, TRD critique)
  | { kind: "skill"; name: string; skill: string; args?: string }
  | { kind: "reviewer"; name: string; reviewer: ReviewerId; injectGoal?: boolean }
  // reviewer returns {findings|clean|error}; main agent triages address|skip|pushback per finding
  | { kind: "gate"; name: string; actions: GateAction[]; commitMessage?: string }

type ReviewerId = "pr-review-toolkit" | "ponytail" | "goal-conformance" | "greptile"
```

```ts
type WorkflowTemplate = {
  id: string                  // "ticket-impl" | "trd-review" | "doc-gen"
  taskType: Task["type"]      // "ticket" | "trd" | "doc" — must match Task.type
  description: string
  stages: Stage[]             // ordered; engine walks them in order
}
```

`Stage` deliberately mirrors `Task.stages[]` in the architecture's data model
(`{ name; agent?; skill?; status }`) — the template is the *definition*, `Task.stages` is the *runtime
instance* (each gets a `status` as the engine advances).

### Registry & selector

```ts
const TEMPLATES: Record<string, WorkflowTemplate> = {
  "ticket-impl": ticketImpl,
  "trd-review":  trdReview,
  "doc-gen":     docGen,
}

function selectTemplate(id: string): WorkflowTemplate {
  const t = TEMPLATES[id]
  if (!t) throw new Error(`unknown workflow template: ${id} (have: ${Object.keys(TEMPLATES).join(", ")})`)
  return t
}
```

Selection is **explicit per task**: the operator passes `--template <id>` (see *How to run it*). The id is
persisted on the task as `workflow` (the field already in the `Task` model). No auto-derivation — that is P6.

### The three templates (as data)

**`ticket-impl`** — the P3 pipeline, re-expressed verbatim (same stages, same gates, same order):

```ts
const ticketImpl: WorkflowTemplate = {
  id: "ticket-impl", taskType: "ticket",
  description: "Implement a ticket → reviewed MR, ready for human merge.",
  stages: [
    { kind: "agent-run", name: "write-goal",  prompt: "Write GOAL.md (incl. acceptance criteria)…" },
    { kind: "agent-run", name: "implement",   prompt: "Implement until done; re-read GOAL.md…" },
    { kind: "gate",      name: "commit-impl", actions: ["commit"], commitMessage: "feat: <goal>" },
    { kind: "reviewer",  name: "pr-review",   reviewer: "pr-review-toolkit" },
    { kind: "gate",      name: "commit-prt",  actions: ["commit"], commitMessage: "address pr-review-toolkit" },
    { kind: "reviewer",  name: "ponytail",    reviewer: "ponytail", injectGoal: true },
    { kind: "gate",      name: "commit-pony", actions: ["commit"], commitMessage: "address ponytail" },
    { kind: "agent-run", name: "goal-check",  prompt: "Read GOAL.md + diff; report unmet criteria.", freshAgent: true },
    { kind: "gate",      name: "push-mr",     actions: ["push", "open-or-reuse-mr"] },
    { kind: "reviewer",  name: "greptile",    reviewer: "greptile" },          // polls MR for comments
    { kind: "gate",      name: "address-rev", actions: ["post-replies", "commit", "push"], commitMessage: "address review comments" },
    { kind: "gate",      name: "summary",     actions: ["render-summary"] },   // → ready for human
  ],
}
```

**`trd-review`** — review a technical-requirements doc (no code MR; advisory passes against a written doc).
Stages: write GOAL.md (what "good" means) → fresh-agent critique → revise → conformance recheck → summary.
It still produces a decision-log and stops at "ready for human"; the "MR" gate is replaced by a
`render-summary` gate (and, if the TRD lives in the repo, a `commit`+`push`+`open-or-reuse-mr`).

```ts
const trdReview: WorkflowTemplate = {
  id: "trd-review", taskType: "trd",
  description: "Critique & strengthen a TRD; produce a reviewed doc + decision-log.",
  stages: [
    { kind: "agent-run", name: "write-goal", prompt: "Write GOAL.md: what a strong TRD must cover." },
    { kind: "agent-run", name: "critique",   prompt: "Critique the TRD against GOAL.md; list gaps.", freshAgent: true },
    { kind: "agent-run", name: "revise",     prompt: "Revise the TRD addressing each critique point." },
    { kind: "gate",      name: "commit-trd", actions: ["commit"], commitMessage: "trd: critique & revise" },
    { kind: "agent-run", name: "goal-check", prompt: "Read GOAL.md + revised TRD; report unmet points.", freshAgent: true },
    { kind: "gate",      name: "push-mr",    actions: ["push", "open-or-reuse-mr"] },
    { kind: "gate",      name: "summary",    actions: ["render-summary"] },
  ],
}
```

**`doc-gen`** — draft → critique → revise, the architecture's named example.

```ts
const docGen: WorkflowTemplate = {
  id: "doc-gen", taskType: "doc",
  description: "Generate a doc: draft → critique → revise → reviewed output.",
  stages: [
    { kind: "agent-run", name: "write-goal", prompt: "Write GOAL.md: audience, scope, acceptance criteria." },
    { kind: "agent-run", name: "draft",      prompt: "Draft the document against GOAL.md." },
    { kind: "agent-run", name: "critique",   prompt: "Critique the draft against GOAL.md.", freshAgent: true },
    { kind: "agent-run", name: "revise",     prompt: "Revise the draft addressing the critique." },
    { kind: "gate",      name: "commit-doc", actions: ["commit"], commitMessage: "doc: draft & revise" },
    { kind: "agent-run", name: "goal-check", prompt: "Read GOAL.md + doc; report unmet criteria.", freshAgent: true },
    { kind: "gate",      name: "push-mr",    actions: ["push", "open-or-reuse-mr"] },
    { kind: "gate",      name: "summary",    actions: ["render-summary"] },
  ],
}
```

### Engine execution

The engine is a generic stage walker — it replaces the hardcoded P3 sequence with a loop over
`template.stages`, but every stage's *behaviour* is the existing P2/P3 code, now dispatched by `kind`:

```
for each stage in template.stages (resuming from task.stage on restart):
  persist task.stage = stage.name   // SQLite, before doing work (crash-recovery checkpoint)
  switch stage.kind:
    agent-run → run claude -p (fresh session if freshAgent else resume task.sessionId);
                inject GOAL.md + decision-log; re-capture sessionId afterward.
    skill     → invoke the named skill as a workflow step (agent-side, no side-effects).
    reviewer  → run the reviewer (subagent/plugin/poll-MR for greptile); record {findings|clean|error};
                ORCHESTRATOR appends raw findings to decision-log.jsonl; agent annotates each
                {address|skip|pushback}+reason. clean → advance+log. error → retry once → needs-human.
    gate      → run actions IN ORDER, each idempotent (commit no-ops on clean tree;
                open-or-reuse-mr checks glab mr list --source-branch first; replies de-duped by id).
                verify failure → route back to the preceding agent stage.
  mark stage status done; advance.
final stage's render-summary → post summary to MR + notify → task.status = needs-human (ready for human).
```

### How gates stay deterministic across templates

The generalisation does **not** loosen the side-effect boundary — it tightens it into a typed contract:

- **`GateAction` is a closed enum.** A template is data; it can only *order* gate actions, never define a
  new one. There is no `merge` action — the human-only-merge hard rule is enforced by the type, not by
  convention. The engine never runs `glab mr merge` for any template.
- **Only `kind: "gate"` stages may perform side-effects.** `agent-run`/`skill`/`reviewer` stages run under
  the worker deny-list (no `git`/`glab` mutations); the orchestrator executes gate actions as itself,
  outside the worker. This is exactly the P2/P3 boundary, now uniform across templates.
- **Decision-log integrity is engine-level, not template-level.** The orchestrator appends raw reviewer
  findings; the agent only annotates. `render-summary` is the same gate action for every template, so the
  human-facing summary (every skip/pushback as a required read; each GOAL.md criterion met/unmet) is
  identical in shape regardless of workflow.
- **GOAL.md + the artifact set are written by the first agent stage of every template** and injected into
  every later stage by the engine — they are not template-specific fields. Artifacts remain git-ignored
  (handled by the SessionStart hook from P0/README §4).

## Implementation steps (ordered)

1. **Define the schema** (`Stage`, `GateAction`, `ReviewerId`, `WorkflowTemplate`) in a new
   `src/templates/types.ts`. No behaviour yet.
2. **Extract the gate executor** from P3: a single `runGate(task, actions, msg)` that dispatches each
   `GateAction` to the existing P1/P2/P3 functions (`commit`, `push`, `openOrReuseMr`, `postReplies`,
   `renderSummary`, `verify`). Pure refactor — no new side-effects.
3. **Extract the stage dispatchers** for `agent-run`, `skill`, `reviewer` from P3 into functions keyed by
   `kind`, preserving fresh-vs-resume session handling and the reviewer `{findings|clean|error}` contract.
4. **Write the generic engine** (`runTemplate(task, template)`) — the stage-walker loop above, persisting
   `task.stage` per stage and resuming from it on restart.
5. **Express `ticket-impl` as data** and switch P3's entry point to `runTemplate(task, TEMPLATES["ticket-impl"])`.
   Assert byte-for-byte-equivalent behaviour against P3 (same commits, same MR, same decision-log).
6. **Add the registry + `selectTemplate`** and wire `--template <id>` into the run script (default
   `ticket-impl` so existing P3 usage is unchanged).
7. **Author `trd-review` and `doc-gen`** as data, reusing the same stage kinds.
8. **Validation pass:** on load, assert each template's `taskType` matches its tasks, the last stage is a
   `render-summary` gate (every template ends ready-for-human), and no template references an unknown
   `ReviewerId`/`GateAction`.

## How to run it (manual / script) — selecting a template per task

```sh
# ticket-impl (default — identical to P3)
./run-task --repo my-repo --template ticket-impl --brief "Implement X (acceptance: …)"

# trd-review on a doc-bearing repo/branch
./run-task --repo my-repo --template trd-review --brief "Review docs/trd/payments.md"

# doc-gen
./run-task --repo my-repo --template doc-gen --brief "Write the onboarding guide (audience: new hires)"

# list available templates
./run-task --list-templates
```

`--template` sets `Task.workflow`; the engine loads `selectTemplate(workflow)` and runs it. Everything
else (worktree creation, deny-list, artifact ignoring) is the existing Stage-A machinery. Selection is
manual in this phase; P6 will set `workflow` automatically from the Jira issue type instead.

## Testing & battle-testing

- **Equivalence (regression):** run `ticket-impl` on the *same* real ticket used to battle-test P3; assert
  the produced commits, MR, decision-log, and summary are equivalent. Proves the refactor changed nothing.
- **`trd-review` on a real TRD:** point it at an actual TRD in a repo; confirm critique→revise→conformance
  runs, the decision-log captures critique points, and it stops at `needs-human` with a posted summary —
  never merges.
- **`doc-gen` on a real doc request:** confirm draft→critique→revise produces a doc, GOAL.md drives the
  conformance check, and the output is an MR ready for human.
- **Edge — a stage that errors:** force a reviewer to crash/timeout/return unparseable output → assert it
  records `error`, retries once, then routes to `needs-human` (never silently treated as `clean`). Force a
  gate `verify` failure → assert it routes back to the preceding agent stage, not forward.
- **Edge — template with no reviews** (e.g. `doc-gen` has no `reviewer` stages, only a fresh-agent
  conformance check): assert the engine still runs end-to-end, the decision-log is created (criteria
  met/unmet only, zero reviewer findings), and the summary renders — i.e. a review-free template is valid.
- **Edge — unknown template id:** `selectTemplate("nope")` throws with the list of valid ids; the run
  script surfaces it cleanly without creating a worktree.
- **Hard-rule check (all three):** grep the orchestrator's executed-action audit log for `mr merge` across
  every template run → must be empty. Confirm no template can encode a `merge` (no such `GateAction`).
- **Crash-recovery:** kill the orchestrator mid-template; on restart, assert it resumes from the persisted
  `task.stage` (last completed gate), for each template.

## Exit criteria (done when)

- The pipeline is driven by `runTemplate(task, template)`; the hardcoded P3 sequence is gone, replaced by
  `ticket-impl` expressed as data, with proven equivalence to P3.
- All three templates (`ticket-impl`, `trd-review`, `doc-gen`) are registered, selectable via
  `--template`, and each runs end-to-end on a real example to a `needs-human` "ready" state.
- `GateAction` is a closed set with no `merge`; every template ends in a `render-summary` gate; GOAL.md +
  decision-log are produced uniformly by all templates.
- The error-path, no-review, and unknown-template edge cases behave as specified, and no template run ever
  executes `glab mr merge`.

## Risks & mitigations

- **Refactor silently changes `ticket-impl` behaviour** → the equivalence regression test (step 5 / first
  battle-test) gates the refactor; do P5 strictly after P3 is battle-tested so there is a known-good baseline.
- **A template author encodes a side-effect outside a gate** (or invents a merge) → impossible by
  construction: only `kind:"gate"` runs `GateAction`s, and `GateAction` is a closed enum without `merge`.
  The load-time validation (step 8) also rejects malformed templates.
- **Over-generalisation** (engine grows config knobs for hypothetical workflows) → scope is fixed to the
  four stage kinds and three named templates from the architecture; no new kinds/actions without a
  decision. This phase re-expresses existing behaviour, it does not add capability.
- **Non-ticket templates lack the same review depth as `ticket-impl`** (`trd-review`/`doc-gen` rely on
  fresh-agent critique/conformance rather than plugin reviewers) → acceptable and intentional; they still
  stop at `needs-human`, so the human is the final reviewer for every template (D4). Adding code-style
  reviewers to doc workflows is out of scope.
- **P4 rebase flow regresses** because templates changed the stage names it keys on → P4 operates on an
  existing MR via `detailed_merge_status`, independent of which template produced it; add a check that the
  rebase flow runs against an MR opened by each template.
