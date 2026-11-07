# Python

Defaults: uv, ruff (lint and format), pyright or mypy (strict), pytest.
`<latest>` means look the version up when writing. Never fill it in from
memory.

## Start the project

- New library or CLI: `uv init --package <name>`. It writes the `src/`
  layout and the `[build-system]` table for the current uv, so don't write
  that table by hand.
- New app that is never installed as a package (a script collection, a
  notebook repo): `uv init --app <name>`.
- Dev tools: `uv add --dev ruff pyright pytest pytest-cov` (or `mypy` in place
  of `pyright`). This adds them to `[dependency-groups]` and pins them in
  `uv.lock`.
- Pin the Python version: `uv python pin <version>` writes `.python-version`.

## pyproject.toml

Merge these tables into the generated file.

```toml
[project]
name = "my-project"
version = "0.1.0"
description = "One line from the interview."
readme = "README.md"
requires-python = ">=3.12"
dependencies = []

[project.scripts]                 # CLI only
my-project = "my_project.cli:main"

[dependency-groups]
dev = ["pyright", "pytest", "pytest-cov", "ruff"]   # versions added by uv add

[tool.ruff]
line-length = 100                 # target-version is read from requires-python

[tool.ruff.lint]
select = [
  "E", "W",   # pycodestyle
  "F",        # pyflakes
  "I",        # import sorting
  "B",        # bugbear: likely bugs
  "UP",       # pyupgrade: modern syntax for the target version
  "SIM",      # simplifications
  "RUF",      # ruff's own rules
  "PT",       # pytest style
]

[tool.pyright]
include = ["src", "tests"]
typeCheckingMode = "strict"
venvPath = "."
venv = ".venv"

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = ["-ra", "--strict-markers", "--strict-config"]
```

If the user picked mypy instead of pyright, replace `[tool.pyright]` with:

```toml
[tool.mypy]
strict = true
files = ["src", "tests"]
```

## Makefile

```make
.PHONY: setup lint format typecheck test check

setup:
	uv sync

lint:
	uv run ruff check .
	uv run ruff format --check .

format:
	uv run ruff check --fix .
	uv run ruff format .

typecheck:
	uv run pyright

test:
	uv run pytest

check: lint typecheck test
```

`uv sync` installs the `dev` group by default. Recipe lines must start with a
tab, not spaces.

## A first test

A new repo needs one real test so `make test` proves something:

```python
# tests/test_core.py
from my_project.core import add


def test_add() -> None:
    assert add(2, 3) == 5
```

## .gitignore

```
.venv/
__pycache__/
*.py[cod]
.pytest_cache/
.ruff_cache/
.mypy_cache/
.coverage
htmlcov/
dist/
build/
.env
```

## Baselines for an existing repo

| Tool | How to baseline existing violations |
|---|---|
| ruff | `uv run ruff check --add-noqa .` adds a `# noqa: <code>` comment to each existing violation. New code is checked in full. For a whole legacy folder, use `[tool.ruff.lint.per-file-ignores]` instead. |
| pyright | Keep `typeCheckingMode = "standard"` for the whole repo and list strict paths in `strict = ["src/my_project/new_module"]`. Grow the list over time. |
| mypy | Keep `strict = true` and relax legacy modules with `[[tool.mypy.overrides]]`, `module = ["my_project.legacy.*"]`, `ignore_errors = true`. Remove entries as modules are fixed. |
| pytest | Nothing to baseline. If existing tests fail, report them; don't skip them silently. |

Report the counts (for example, "312 ruff violations marked noqa in 41
files") so the user knows the size of the backlog.
