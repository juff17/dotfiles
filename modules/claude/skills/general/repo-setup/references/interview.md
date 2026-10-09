# Interview

Settle every decision that changes a file before writing any file. Finding
facts is your job; making decisions is the user's.

## How to run it

- **Rounds.** Each round asks every question whose prerequisites are already
  settled. A question that depends on an answer still open goes in a later
  round (for example, ask the layout after the language and the monorepo
  question).
- **A recommended answer per question.** Word each question so "yes" accepts
  the recommendation. Base the recommendation on what step 1 found and on
  the defaults below.
- **AskUserQuestion when available.** Put the recommended option first and
  mark it "(Recommended)". At most 4 questions per call; a round with more
  questions takes more than one call.
- **Text format otherwise:**

  ```
  **Q1. <title>**: <question, with the choices>
  ➡️ Recommended: <answer>

  **Q2. <title>**: ...
  ```

- **Don't ask what you can look up.** Read the repo, lockfiles, remote,
  and existing configs first.
- **Don't ask what doesn't change the output.** If every answer leads to the
  same files, skip the question.
- **Done** when no open question would change a file. Then show the plan and
  wait for confirmation before writing.

## Question bank

Ask the ones that apply. In an existing repo, skip anything already decided
by the repo's own files.

### Round 1: what the project is

| Question | Recommended default |
|---|---|
| What does the project do, in one sentence? (Used for the README opening and package description.) | No default; ask |
| Kind of project: library, CLI, web API, web frontend, worker, full-stack app | Infer from the request |
| Language and runtime version | Current LTS or latest stable (look it up) |
| One package or a monorepo with several packages or apps? | Single package unless there are two or more deployables that share code |
| Is this personal, open source, or for a company? (Affects license, README tone, CI provider) | Ask |

### Round 2: layout and tooling

| Question | Python default | TypeScript default |
|---|---|---|
| Package manager | uv | pnpm |
| Layout (see [layouts.md](layouts.md)) | `src/` layout | Single package; pnpm workspaces if monorepo |
| Framework (if an API or frontend) | FastAPI for an API | NestJS for an API; Vite + React for an SPA; Next.js if it needs SSR |
| Linter and formatter | ruff (both) | ESLint + typescript-eslint + Prettier, or Biome (one tool, faster, fewer plugins) |
| Type checker | pyright (faster, stricter defaults); mypy if the team already uses it | `tsc --noEmit` with `strict` |
| Test framework | pytest | Vitest; Jest only if NestJS defaults are wanted |
| Command runner | Makefile (preinstalled almost everywhere) | Makefile, or `package.json` scripts plus a Makefile wrapper |

### Round 3: CI and automation

| Question | Recommended default |
|---|---|
| **CI provider: GitHub Actions or GitLab CI?** Always ask. | Match the remote host, but confirm |
| Which checks run in CI? | lint, format check, type check, test |
| Test against more than one runtime version? | Library: yes, a matrix of supported versions. App: no, the one deployed version |
| Pre-commit hooks? | Yes, for format and lint only (fast). Type check and tests stay in CI |
| Dependency updates: Renovate or Dependabot? | Renovate (works on both GitHub and GitLab); Dependabot if GitHub only and the user wants zero setup |
| Coverage report or threshold? | Report only, no threshold, for a new repo |

### Round 4: deploy and extras

| Question | Recommended default |
|---|---|
| Deploy target: none, package registry (PyPI, npm), container image, platform (Vercel, Fly, Cloud Run), Kubernetes | None for now; add a release job later |
| Dockerfile? | Only if the deploy target needs one |
| License | MIT for personal or open source; none (proprietary) for company code |
| README: full header with logo and badges, or minimal? | Full for open source; minimal for internal |
| Add a `CLAUDE.md` with the commands and conventions? | Yes |
| Branch protection or required checks to mention in the report? | Yes, list them for the user to enable |

## Existing repo extras

Ask these only when step 1 found the matching situation:

- Existing violations when strict rules are added: baseline them, or fix
  them now? Recommended: baseline, fix over time.
- Two tools doing the same job (for example ESLint and Biome both
  configured): which one stays? Recommended: the one CI runs today.
- CI exists but skips checks: add the missing jobs to the existing pipeline,
  or rewrite it? Recommended: add jobs, keep the existing structure.
