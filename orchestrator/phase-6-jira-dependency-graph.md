# Phase 6 — Jira sync & dependency graph
> Make Jira the source of truth for the dependency DAG and intake derivation, producing populated `Task` records ready to run.

## Value & rationale
This is the first phase of Stage B ("many tasks, with dependencies"). Stage A proved one pipeline end-to-end; before we can schedule *many* tasks we need to know how they relate. Jira already encodes that relationship — engineers maintain "is blocked by" links as part of normal planning. Reusing it means the operator never hand-maintains a parallel dependency list, and the DAG stays in sync with how the team actually thinks about the work.

This phase **builds the graph and the derivations**; it does not act on them. The deliverable is a set of `Task` records (keyed by `jiraKey`) with `dependsOn`, `baseBranch`, `workflow`, and `contextGroup` populated, plus a deterministic, tested mapping from `fields.issuelinks` to DAG edges. P7 consumes this graph to dispatch, stack branches, and release dependents.

Doing it deterministically (orchestrator builds the DAG from JSON) keeps graph logic auditable and unit-testable. The LLM is used only for the *fetch* (it holds the Jira auth); the *interpretation* is plain code. This matches the core principle: **the agent fetches, the orchestrator decides.**

## Dependencies (Depends on / Enables)
- **Depends on: P5** — the workflow-template engine. P6 derives *which* template id (`ticket-impl` / `trd-review` / `doc-gen`) a task gets; those templates must already exist to map onto. Also depends on the `Task` data model and SQLite state store established in earlier phases.
- **Enables: P7** — scheduler, concurrency & branch-stacking. P7 reads `dependsOn`, `baseBranch`, and `status` from the records this phase populates, and acts on the release/reconcile guardrails defined here.

## In scope
- Fetch `fields.issuelinks` (and `issuetype`, `components`, `labels`, `status`, plus repo-mapping fields) for a set of issues **via Claude's existing authenticated connection** — a thin `claude -p` / Jira MCP call that returns **JSON only**.
- **Deterministic DAG construction** from that JSON in the orchestrator: parse links, build nodes and `dependsOn` edges.
- Map **"is blocked by" → `dependsOn`**, handling the `inwardIssue` vs `outwardIssue` direction footgun, with a dedicated unit test.
- **Derivation:** issue type → `workflow` template id; component/labels → `contextGroup`.
- **`baseBranch` resolution:** same-repo blocker → blocker's branch; cross-repo blocker → `main` (ordering-only).
- **Cycle detection** via topological sort — flag cycles, never deadlock.
- **Correctness guardrails** encoded as task metadata/state so P7 can honour them: release on MR *merge* not Jira status; unmanaged/external blockers → release on link-clear/manual; re-poll + reconcile each tick.
- Output: populated `Task` records persisted to the SQLite state store, ready for P7 to run.

## Out of scope (deferred to …)
- **The dispatch loop, concurrency cap, branch-stacking *execution*, and auto-release *execution* → P7.** This phase computes `dependsOn`/`baseBranch` and the release rules; P7 acts on them (rebase, dispatch-on-merged, file-overlap detection).
- **Scheduled/continuous polling cadence as a running loop → P7** (P6 provides a re-poll + reconcile *function*; wiring it into the dispatch tick is P7's job). P6 is runnable manually / by script.
- **Reliability (crash-recovery, retry/timeout, breakers) → P8.**
- **Dashboard, notifications, audit UI → P9.**
- **Writing back to Jira** — out of scope entirely; Jira access is read-only here (matches D2 / hard rules).

## Design (fetch-via-Claude→JSON→deterministic DAG; direction handling; derivation; baseBranch resolution; guardrails; cycle detection)

### 1. Fetch via Claude → JSON (auth boundary)
The orchestrator does **not** hold a Jira token (D2). It shells out to a thin headless call that uses Claude's already-authenticated Jira connection (Jira MCP). The prompt instructs Claude to fetch the requested issues and **emit only JSON** matching a fixed schema — no prose, no judgement.

```
claude -p --output-format json \
  "Using the Jira MCP tools, fetch these issues: PROJ-1, PROJ-2, PROJ-3.
   For each, return ONLY a JSON array of objects with fields:
   { key, issuetype.name, status.name, components[].name, labels[],
     <repo-mapping-field>, issuelinks[] }
   where each issuelink has { type.name, type.inward, type.outward,
     inwardIssue.key?, outwardIssue.key? }.
   Output JSON only — no explanation."
```

The orchestrator parses stdout, validates against the expected schema, and **rejects/aborts on malformed JSON** rather than guessing. Untrusted-input rule still applies: issue text is data, never instructions (relevant when derivation reads labels/components). Everything after this fetch is deterministic code.

### 2. issuelinks → DAG, and the inward/outward footgun
Jira's "Blocks" link type is **directional** and the JSON exposes it from the perspective of the issue you fetched:
- `type.outward = "blocks"`, `type.inward = "is blocked by"`.
- A link object on issue *A* carries **either** an `outwardIssue` **or** an `inwardIssue`, never both.
- If A's link has `inwardIssue = B` with `type.inward = "is blocked by"`, that means **A is blocked by B** → edge `A.dependsOn += B`.
- If A's link has `outwardIssue = C` with `type.outward = "blocks"`, that means **A blocks C** → from A's view this is *not* a dependsOn for A (it's `C.dependsOn += A`; we only add the edge from the blocked side to avoid double-counting).

**The footgun:** it is tempting to read `outwardIssue` as "the thing this depends on" — it is the opposite. We canonicalise on the **inward "is blocked by"** direction only:

```
for issue in issues:
  for link in issue.issuelinks:
    if link.type.name == "Blocks" and link.inwardIssue and
       link.type.inward == "is blocked by":
        addEdge(dependent = issue.key, blocker = link.inwardIssue.key)
    # outwardIssue ("blocks") is ignored here — captured from the blocker's side
```

Because we only ingest the inward side, the same dependency is recorded exactly once regardless of which of the two issues we happened to fetch (as long as both are in the fetch set, or the blocker is referenced). Blockers referenced but not in the fetch set are recorded as **unmanaged/external** (see guardrails).

A **unit test asserts the direction**: given a fixture where PROJ-2 "is blocked by" PROJ-1, assert `task(PROJ-2).dependsOn == [PROJ-1]` and `task(PROJ-1).dependsOn == []`. A second fixture with the link expressed from the *outward* side (PROJ-1 "blocks" PROJ-2) must yield the **same** graph — this is the regression guard against an inverted reading.

### 3. Derivation (intake)
Deterministic lookups against per-repo/project config (the mapping confirmed in onboarding step 5):
- **`workflow`** ← `issuetype.name` (e.g. `Story`/`Task`/`Bug` → `ticket-impl`; `TRD` → `trd-review`; `Documentation` → `doc-gen`). Templates must exist from P5; an unmapped issue type → flag `needs-human`, do not silently default.
- **`contextGroup`** ← `components[]` first, falling back to `labels[]` (e.g. component `payments` → `cg:payments`). Drives the `/cg` repo set the worker loads.
- **`repo`** ← repo-mapping field/component → `glab` project. Needed because branch-stacking only applies *within* the same repo.

### 4. baseBranch resolution
Per task, after edges are built:
```
baseBranch(task):
  blockers = task.dependsOn
  same_repo_blockers = [b for b in blockers if task.repo == b.repo]
  if same_repo_blockers:
      # branch-stack: branch off the (single) same-repo blocker's branch
      return blocker.branch   # blocker's working branch, resolved by P7 at dispatch
  else:
      return "main"           # cross-repo or no blocker → ordering only
```
- **Same-repo blocker** → `baseBranch` = that blocker's branch (D-config default branch name aside, this is the blocker's *feature* branch). This is the branch-stacking target; P7 does the actual rebase on blocker merge.
- **Cross-repo blocker** → `baseBranch = main`; the dependency is **ordering-only** (don't dispatch until merged) — there is no shared branch to stack on.
- If multiple same-repo blockers exist, flag for `needs-human` (P7 can't stack on two branches at once) — record but don't guess.
- At P6 build time the blocker's branch may not exist yet; store the *intent* (stack-on-blocker vs main) and let P7 resolve the concrete branch name at dispatch. P6 records `baseBranch = "main"` or a sentinel referencing the blocker key; P7 finalises.

### 5. Correctness guardrails (encoded, acted on by P7)
1. **Release on MR *merge*, not Jira status (D5).** A task with `dependsOn` is `blocked` until the blocker's **MR is merged**. P6 marks the dependency type; it never reads Jira workflow state as a release signal.
2. **Branch-stack only within same repo** — encoded in §4; cross-repo = ordering only.
3. **Unmanaged/external blockers** (blocker has no agent-owned MR — e.g. not in our task set, or a non-code ticket) → cannot release on merge; mark `release: link-clear-or-manual` so P7 releases when the Jira link clears or on operator override.
4. **Re-poll + reconcile each tick.** P6 exposes a `reconcile(existingTasks, freshFetch)` function: a **new** blocker appearing after a task already branched off `main` → flag/pause; a **removed** blocker → mark for rebase back onto `main`; recompute the DAG and re-run cycle detection every time. Idempotent — re-running on unchanged input is a no-op.

### 6. Cycle detection
After building edges, run a **topological sort** (Kahn's algorithm or DFS with colour marking). If no valid ordering exists, a cycle is present:
- **Flag the offending issues** (`status = needs-human`, record the cycle path, e.g. `PROJ-1 → PROJ-2 → PROJ-1`) and **do not** add them to the runnable set.
- **Never deadlock** — the rest of the (acyclic) graph still produces valid tasks; only the cycle members are held.
- Cycle detection re-runs on every reconcile, so a later link edit that breaks the cycle clears the flag.

## Implementation steps (ordered)
1. Define the JSON contract (TypeScript types) for the Jira fetch response: `JiraIssue`, `JiraIssueLink`, with optional `inwardIssue`/`outwardIssue`.
2. Implement `fetchIssues(keys): Promise<JiraIssue[]>` — builds the `claude -p` prompt, invokes the CLI, parses + schema-validates the JSON, aborts on malformed output.
3. Implement `buildEdges(issues): Map<jiraKey, dependsOn[]>` — the inward-only "is blocked by" mapping; record referenced-but-not-fetched blockers as unmanaged.
4. Implement `deriveIntake(issue)` → `{ workflow, contextGroup, repo }` from issue type / component / labels via config; flag unmapped.
5. Implement `resolveBaseBranch(task, tasksByKey)` per §4 (same-repo vs cross-repo; multi-blocker flag).
6. Implement `detectCycles(edges)` → topological sort; return ordering or the cycle path(s).
7. Implement `buildGraph(keys)` orchestration: fetch → buildEdges → derive → resolveBaseBranch → detectCycles → assemble `Task[]`.
8. Implement `reconcile(existingTasks, keys)` — re-fetch, rebuild, diff against persisted tasks; flag new/removed blockers; re-run cycle detection; idempotent.
9. Persist resulting `Task` records to SQLite (status `queued` / `blocked` / `needs-human` as computed); upsert keyed by `jiraKey`.
10. Build the manual `build-graph` script (print + persist) — see *How to run it*.
11. Write unit tests (direction footgun both ways, cycle, cross-repo, unmanaged blocker, derivation, reconcile add/remove).

## How to run it (manual / script) — build+print the DAG for a set of issues
A standalone script (no scheduler, no dispatch) so the operator can inspect the graph by hand:

```
# fetch + build + print (does not dispatch anything)
orchestrator build-graph PROJ-1 PROJ-2 PROJ-3 --print
```
Output: an adjacency listing + a topological order (or a clearly-flagged cycle), plus the derived fields per task:
```
PROJ-1  type=Story    wf=ticket-impl  cg=payments  repo=billing  base=main          deps=[]            status=queued
PROJ-2  type=Story    wf=ticket-impl  cg=payments  repo=billing  base=PROJ-1.branch deps=[PROJ-1]      status=blocked
PROJ-3  type=Bug      wf=ticket-impl  cg=search     repo=search   base=main          deps=[PROJ-1]*     status=blocked   (*cross-repo: ordering only)
topo order: PROJ-1, PROJ-2, PROJ-3
```
Add `--persist` to write the records to SQLite (default for the real path; `--print` alone is dry-run). A cycle prints `CYCLE: PROJ-1 → PROJ-2 → PROJ-1 (flagged needs-human, excluded from runnable set)` and exits non-zero for that subset while still printing the valid remainder.

## Testing & battle-testing (real issues with blocks links; edge cases)
**Unit tests (fixtures, no live Jira):**
- **Direction footgun (both orientations):** "is blocked by" inward fixture and the equivalent "blocks" outward fixture both produce the *same* DAG. Asserts `dependsOn` points at the blocker, never inverted.
- **Cycle:** A↔B and a 3-node cycle → detected, flagged, path reported, rest of graph still valid.
- **Cross-repo blocker:** blocker in a different repo → `baseBranch = main`, dependency ordering-only.
- **Same-repo blocker:** `baseBranch` = blocker's branch (stack intent recorded).
- **Multi same-repo blocker:** flagged `needs-human`.
- **Unmanaged/external blocker:** referenced-but-not-fetched / non-code ticket → `release: link-clear-or-manual`.
- **Derivation:** issue type → workflow, component/label → context group; unmapped type → flagged.
- **Reconcile:** new blocker added after branch-off-main → flag/pause; blocker removed → mark rebase-to-main; unchanged input → no-op (idempotent).
- **Malformed fetch JSON:** abort, do not partial-build.

**Battle-testing (real Jira via Claude auth):** pick a real set of issues that genuinely carry "blocks"/"is blocked by" links and run `build-graph --print`; verify the printed DAG matches the Jira UI's link panel by eye. Deliberately invert a test link in Jira and re-run to confirm direction holds. Add a temporary cyclic link pair to confirm it's flagged not hung, then remove it and confirm reconcile clears the flag.

## Exit criteria (done when)
- `build-graph <keys>` fetches via Claude's Jira auth, returns JSON, and the orchestrator builds the DAG **deterministically** from it.
- "is blocked by" maps to `dependsOn` with **correct direction**, proven by a passing both-orientations unit test.
- `workflow`, `contextGroup`, `repo`, and `baseBranch` are derived/resolved per the rules above (same-repo → blocker branch; cross-repo → main).
- Cycles are detected via topological sort, flagged (not deadlocked), with the path reported; the acyclic remainder still builds.
- The release guardrails (merge-not-status; unmanaged → link-clear/manual) are encoded on the task records; `reconcile` handles added/removed blockers idempotently.
- Populated `Task` records are persisted to SQLite, ready for P7 — with **no** dispatch/scheduling/branch-stacking execution in this phase.

## Risks & mitigations
- **Inverted inward/outward reading** (the classic footgun) → canonicalise on the inward "is blocked by" side only; both-orientation unit test as a permanent regression guard.
- **Jira fetch returns prose / malformed JSON** (LLM drift) → strict schema validation, JSON-only prompt, abort-not-guess; keep the fetch prompt minimal and deterministic.
- **Custom Jira configs** — non-default link type names or localised "is blocked by" strings → make the link-type/direction strings config-driven, not hardcoded; verify against the target Jira during onboarding step 5.
- **Releasing on Jira status instead of merge** → guardrail #1 explicitly forbids reading workflow state as a release signal (D5); only MR-merge or link-clear releases.
- **Blocker branch not yet existing at build time** → P6 records stack *intent*; P7 resolves the concrete branch at dispatch — avoids storing a stale/empty branch name.
- **Stale graph** (links change while tasks are queued) → `reconcile` re-fetches and recomputes every tick (wired into P7's loop), re-running cycle detection so edits are picked up.
- **Multiple same-repo blockers** (no single stack target) → flag `needs-human` rather than guessing a base branch.
