# Phase docs

Detailed, implementation-ready plans for each phase of the agent orchestrator. The high-level design and
all cross-cutting decisions live in [`./agent-orchestrator-architecture.md`](./agent-orchestrator-architecture.md);
prerequisites/setup live in [`./orchestrator-setup.md`](./orchestrator-setup.md). **These phase docs assume
that context** and do not restate it. (The repo root [`../README.md`](../README.md) covers the dotfiles purpose.)

## Guiding principle
Build in small, independently testable increments. Each phase is usable on its own (manually triggered or
script-run) before the next exists. **One pipeline must be fully working and battle-tested before we add any
concurrency, scheduling, or UI.** We never build the whole system in one go.

## Stages & phases

**Stage A — one task, end-to-end, manually triggered** (prove the pipeline)
- [Phase 0 — Foundations & prerequisites](./phase-0-foundations.md)
- [Phase 1 — GitLab module](./phase-1-gitlab-module.md)
- [Phase 2 — Single-task pipeline: implement → MR](./phase-2-single-task-pipeline.md)
- [Phase 3 — Review pipeline](./phase-3-review-pipeline.md)
- [Phase 4 — Rebase babysitting](./phase-4-rebase-babysitting.md)
- [Phase 5 — Workflow templates](./phase-5-workflow-templates.md)

**Stage B — many tasks, with dependencies** (add automation)
- [Phase 6 — Jira sync & dependency graph](./phase-6-jira-dependency-graph.md)
- [Phase 7 — Scheduler, concurrency & branch-stacking](./phase-7-scheduler-concurrency.md)

**Stage C — manage at scale** (hardening + UX)
- [Phase 8 — Reliability & safety hardening](./phase-8-reliability-safety.md)
- [Phase 9 — Dashboard, notifications & audit](./phase-9-dashboard-notifications.md)

## Per-phase doc structure
Every phase doc follows the same template: **Value & rationale · Dependencies (depends on / enables) ·
In scope · Out of scope (deferred) · Design · Implementation steps · How to run it (manual/script) ·
Testing & battle-testing · Exit criteria · Risks & mitigations.**

## Hard rules (apply to every phase)
- **Only humans merge.** The orchestrator/agent never runs `glab mr merge`.
- **The agent decides; the orchestrator acts.** All state-mutating git/glab is deterministic, orchestrator-owned.
- **Workers have no credentials and a git/glab deny-list.** Real boundary hardened by Tier-1 sandbox (P8).
