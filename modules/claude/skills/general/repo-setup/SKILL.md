---
name: repo-setup
description: >
  Set up or improve a repository's foundations: project layout, package
  manager, linter, formatter, type checker, test runner, pre-commit hooks,
  CI/CD pipeline (GitHub Actions or GitLab CI), dependency updates, a
  Makefile or justfile, .editorconfig, .gitignore, and the README. Interviews
  the user first, then scaffolds a new repo or fills the gaps in an existing
  one. Use when the user wants to start a new project, scaffold a repo, add
  CI, add linting or type checking, set up pre-commit, pick a repo layout, or
  write, create, update or restructure a README.
license: MIT
---

# Repo setup

Covers Python and TypeScript (including NestJS and frontend apps). For other
languages, follow the same steps but say the reference files don't cover
them.

## Pick the path

| Path | When | Steps |
|---|---|---|
| **New repo** | Empty or near-empty directory, or the user asks to start a project | Interview → plan → scaffold → verify |
| **Existing repo** | The repo has code and the user wants CI, linting, type checks, or other tooling added or fixed | Detect → interview on the gaps → plan → add → verify |
| **README only** | The user asks only to write, update or restructure a README | Follow [references/readme.md](references/readme.md). No interview beyond what the README needs. |

## 1. Detect (existing repo)

Find the facts yourself before asking anything. Never ask the user for
something you can read from the repo. Record:

- Languages, runtime versions, and the package manager (from lockfiles:
  `uv.lock`, `poetry.lock`, `pnpm-lock.yaml`, `package-lock.json`,
  `yarn.lock`, `bun.lockb`).
- Lint, format, type check and test tools already configured
  (`pyproject.toml`, `ruff.toml`, `mypy.ini`, `eslint.config.*`,
  `.eslintrc*`, `biome.json`, `.prettierrc*`, `tsconfig*.json`,
  `vitest.config.*`, `jest.config.*`).
- CI files (`.github/workflows/`, `.gitlab-ci.yml`), pre-commit config,
  Renovate or Dependabot config, Makefile or justfile, `.editorconfig`,
  `.gitignore`, README, LICENSE.
- The git remote host, as a hint for the CI question (still ask it).

**Never swap a tool the repo already uses.** If it uses mypy, add to mypy;
don't move it to pyright. Suggest a swap only when the existing tool is
broken or unmaintained, and only as a question.

## 2. Interview

Ask before writing anything. Settle every decision that changes the output.
The question bank and the round format are in
[references/interview.md](references/interview.md).

- Work in rounds: a few related questions per round, each with a
  recommended answer, worded so "yes" accepts it.
- Use AskUserQuestion when it is available; otherwise use the text format in
  the reference file.
- A question that depends on an answer you don't have yet goes in a later
  round.
- **Always ask the CI provider** (GitHub Actions or GitLab CI). Never assume
  it, even when the remote suggests one.
- For an existing repo, only ask about the gaps found in step 1.
- Stop when no open decision would change a file you write. Then show the
  plan (step 3) and wait for confirmation.

## 3. Plan

Show a short table of every file you will create or change, one line each,
and the commands the Makefile or justfile will expose. Wait for the user to
confirm.

## 4. Write

| Topic | Reference |
|---|---|
| Directory layout | [references/layouts.md](references/layouts.md) |
| Python tooling configs | [references/python.md](references/python.md) |
| TypeScript tooling configs | [references/typescript.md](references/typescript.md) |
| CI, pre-commit, Renovate | [references/ci.md](references/ci.md) |
| README | [references/readme.md](references/readme.md) |

Rules for every file:

- **Look up current versions when writing.** Check the registry
  (`npm view <pkg> version`, `uv pip index versions <pkg>` or PyPI, the
  GitHub releases page for actions and pre-commit hooks) and use what it
  returns. Never write a version from memory. The versions in the reference
  files are placeholders (`<latest>`), not values.
- **One place for commands.** A Makefile or justfile (the user picks) with
  `setup`, `lint`, `format`, `typecheck`, `test`, and `check` (runs all
  checks). CI and pre-commit call the same tools with the same flags, so a
  green local `check` means green CI.
- **Strict from the start in a new repo.** Strict type checking, the
  recommended lint rule sets, formatter enforced in CI.
- **Baseline in an existing repo.** New strict rules must not fail on old
  code all at once. Use the tool's baseline or per-file ignore mechanism
  (listed in each language reference), so new code meets the rules and old
  code is fixed over time. Tell the user how many existing violations were
  baselined.
- Add `.editorconfig` and a `.gitignore` for the language and editor.
- Write a `CLAUDE.md` only if the user said yes in the interview. Keep it to
  the commands and the conventions an agent can't infer from the code.
- Add a LICENSE file only for the license the user picked.

## 5. Verify

Run, once, locally: install, then lint, type check, and test (the `check`
target). A new repo needs at least one passing test so the test step proves
something. Fix failures in files you wrote. For failures in existing code,
baseline them (step 4) or report them; don't rewrite the user's code to make
checks pass.

You can't run CI from here. Say so, and tell the user what to check on the
first pipeline run (cache hits, the job list).

## 6. Report

- Files created or changed.
- Commands to run (`make check` or `just check`).
- Anything baselined, skipped, or left for the user (secrets to add in CI
  settings, branch protection, a logo or video placeholder in the README).
