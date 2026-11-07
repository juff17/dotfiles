# CI, pre-commit, dependency updates

Always ask the user whether they want GitHub Actions or GitLab CI. CI runs the
same commands as the local `check` target, so a green `make check` means a
green pipeline.

`<latest>` means look the version up when writing (the action's or image's
releases page). Never fill it in from memory. Pin actions to a major tag
(`@v5`) at minimum; pin to a commit SHA if the user wants supply-chain
hardening.

Every pipeline does the following:

| Concern | GitHub Actions | GitLab CI |
|---|---|---|
| Run on PRs/MRs and the default branch, not twice for the same commit | `on: pull_request` + `push: branches: [main]` | `workflow: rules` below |
| Cancel outdated runs | `concurrency` with `cancel-in-progress` for PRs | `interruptible: true` + `workflow: auto_cancel` |
| Dependency cache keyed on the lockfile | `setup-uv` `enable-cache`, `setup-node` `cache: pnpm` | `cache: key: files: [<lockfile>]` |
| Least privilege | `permissions: contents: read` | Default job token |
| Lockfile must match manifest | `uv sync --locked`, `pnpm install --frozen-lockfile` | Same |

## GitHub Actions: Python

```yaml
# .github/workflows/ci.yml
name: ci

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

permissions:
  contents: read

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<latest>
      - uses: astral-sh/setup-uv@<latest>
        with:
          enable-cache: true
      - run: uv sync --locked
      - run: uv run ruff check .
      - run: uv run ruff format --check .
      - run: uv run pyright

  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        python-version: ["3.12", "3.13"]   # library: every supported version; app: only the deployed one
    steps:
      - uses: actions/checkout@<latest>
      - uses: astral-sh/setup-uv@<latest>
        with:
          enable-cache: true
          python-version: ${{ matrix.python-version }}
      - run: uv sync --locked
      - run: uv run pytest --cov
```

## GitHub Actions: TypeScript

```yaml
# .github/workflows/ci.yml
name: ci

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<latest>
      - uses: pnpm/action-setup@<latest>     # reads the version from packageManager
      - uses: actions/setup-node@<latest>
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format:check
      - run: pnpm typecheck
      - run: pnpm test
```

- `pnpm/action-setup` must run before `setup-node`, or the pnpm cache step
  fails.
- For a library supporting several Node versions, add a matrix on
  `node-version` and drop `node-version-file`.
- With Biome, replace the lint and format steps with `pnpm biome ci .`.

## GitLab CI: Python

```yaml
# .gitlab-ci.yml
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS
      when: never                      # branch has an open MR; the MR pipeline covers it
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  auto_cancel:
    on_new_commit: interruptible

default:
  interruptible: true

stages: [check, test]

variables:
  UV_CACHE_DIR: .uv-cache
  UV_LINK_MODE: copy
  PYTHON: "3.13"

.uv:
  image: ghcr.io/astral-sh/uv:<latest>-python$PYTHON-bookworm-slim
  cache:
    key:
      files: [uv.lock]
    paths: [.uv-cache]
  before_script:
    - uv sync --locked
  after_script:
    - uv cache prune --ci

lint:
  extends: .uv
  stage: check
  script:
    - uv run ruff check .
    - uv run ruff format --check .
    - uv run pyright

test:
  extends: .uv
  stage: test
  parallel:
    matrix:
      - PYTHON: ["3.12", "3.13"]       # library: every supported version; app: only the deployed one
  script:
    - uv run pytest --cov
```

- `uv cache prune --ci` drops downloaded wheels and keeps only what is
  expensive to rebuild, so the cache stays small.
- The pyright PyPI package downloads Node on first run. If runners have no
  internet access, use mypy or an image with Node installed.

## GitLab CI: TypeScript

```yaml
# .gitlab-ci.yml
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS
      when: never
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  auto_cancel:
    on_new_commit: interruptible

default:
  interruptible: true

stages: [check]

.pnpm:
  image: node:<current LTS major>-slim
  cache:
    key:
      files: [pnpm-lock.yaml]
    paths: [.pnpm-store]
  before_script:
    - npm install --global corepack@<latest>
    - corepack enable                  # uses the pnpm version in packageManager
    - pnpm config set store-dir .pnpm-store
    - pnpm install --frozen-lockfile

lint:
  extends: .pnpm
  stage: check
  script:
    - pnpm lint
    - pnpm format:check

typecheck:
  extends: .pnpm
  stage: check
  script:
    - pnpm typecheck

test:
  extends: .pnpm
  stage: check
  script:
    - pnpm test
```

Corepack is installed from npm because newer Node releases no longer ship it.

## Pre-commit hooks

Hooks run only fast checks (format and lint on staged files). Type checks and
tests stay in CI and `make check`.

**Python:** the `pre-commit` tool.

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: <latest, matching the ruff version in uv.lock>
    hooks:
      - id: ruff-check
        args: [--fix]
      - id: ruff-format
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: <latest>
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-added-large-files
```

Install with `uv tool install pre-commit && pre-commit install`. Run
`pre-commit autoupdate` to fill in current `rev` values. Add `pre-commit
install` to the Makefile's `setup` target.

**TypeScript:** husky and lint-staged.

`pnpm add -D husky lint-staged`, then `pnpm exec husky init`. Replace the
generated `.husky/pre-commit` contents with `pnpm exec lint-staged`. In
`package.json`:

```json
"lint-staged": {
  "*.{ts,tsx,js,jsx}": ["eslint --fix", "prettier --write"],
  "*.{json,md,yml,yaml,css}": ["prettier --write"]
}
```

With Biome: `"*.{ts,tsx,js,jsx,json}": ["biome check --write --no-errors-on-unmatched"]`.

## Dependency updates

**Renovate** (recommended; works on GitHub and GitLab):

`renovate.json`:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", "group:allNonMajor"],
  "lockFileMaintenance": { "enabled": true },
  "schedule": ["before 6am on monday"]
}
```

- `group:allNonMajor` puts all minor and patch updates in one weekly PR;
  majors arrive one per PR.
- On GitHub, install the Renovate GitHub App. On GitLab, run Renovate from a
  scheduled pipeline using the `renovate-bot/renovate-runner` project; it
  needs a bot token, which the user must create.
- Turn on automerge only if CI is a required check, and only after asking.

**Dependabot** (GitHub only, no app to install):

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: uv          # or npm (also covers pnpm lockfiles)
    directory: /
    schedule:
      interval: weekly
    groups:
      minor-and-patch:
        update-types: [minor, patch]
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

## Shared files

```ini
# .editorconfig
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.py]
indent_size = 4

[Makefile]
indent_style = tab

[*.md]
trim_trailing_whitespace = false
```

## What to tell the user after setup

- Secrets or tokens to add in the CI settings (registry tokens, the
  Renovate bot token on GitLab).
- Which jobs to mark as required checks or protected-branch rules.
- To watch the first pipeline for cache hits and the expected job list.
