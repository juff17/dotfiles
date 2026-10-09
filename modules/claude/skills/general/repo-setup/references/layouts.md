# Layouts

Pick the smallest layout that fits. A repo can grow into a larger layout
later; moving files is cheap while the repo is small. Go and Rust layouts are
out of scope for this skill.

## Which one

| Project | Layout |
|---|---|
| Python library, CLI, or service | [Python `src/` layout](#python-src-layout) |
| TypeScript library or CLI, one package | [TypeScript single package](#typescript-single-package) |
| Several TypeScript apps or packages that share code | [pnpm workspaces monorepo](#typescript-monorepo-pnpm-workspaces) |
| NestJS API | [NestJS by feature module](#nestjs-by-feature-module) |
| Vite or Next.js frontend | [Frontend by feature](#frontend-by-feature) |

## Python src layout

```
my-project/
├── src/
│   └── my_project/
│       ├── __init__.py
│       ├── __main__.py      # only for a CLI: python -m my_project
│       ├── cli.py
│       └── core.py
├── tests/
│   ├── conftest.py
│   └── test_core.py
├── pyproject.toml
├── uv.lock
├── Makefile
├── .editorconfig
├── .gitignore
├── .pre-commit-config.yaml
└── README.md
```

- **Why `src/`:** tests run against the installed package, not the files in
  the working directory, so a missing file in the build fails in tests
  instead of after release.
- Tests live outside the package in `tests/`, mirroring the module names.
- For a service, group by feature inside the package (`orders/`, `billing/`),
  each with its routes, models, and logic, rather than one folder per
  technical layer.

## TypeScript single package

```
my-lib/
├── src/
│   ├── index.ts             # public exports only
│   └── parser.ts
├── test/                    # or *.test.ts beside the source; pick one
│   └── parser.test.ts
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── eslint.config.js         # or biome.json
├── vitest.config.ts
└── README.md
```

- `src/index.ts` is the public interface. Everything not exported from it
  is internal.
- Pick tests beside source (`parser.test.ts`) or a `test/` folder once, and
  keep it.

## TypeScript monorepo (pnpm workspaces)

```
my-monorepo/
├── apps/
│   ├── api/                 # NestJS
│   └── web/                 # Vite or Next.js
├── packages/
│   ├── shared-types/        # types shared by api and web
│   ├── eslint-config/       # shared lint config (if ESLint)
│   └── tsconfig/            # shared tsconfig bases
├── package.json             # root: dev tools and scripts that run across packages
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json
└── Makefile
```

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"
```

- Use only when there are two or more deployables that share code. One app
  with one library is still a single package.
- `apps/` hold deployables; `packages/` hold code other workspaces import.
  Apps never import from other apps.
- Internal packages are referenced with `"@my/shared-types": "workspace:*"`.
- Run a command across workspaces with `pnpm -r <script>` or
  `pnpm --filter <name> <script>`. Add Turborepo only when build times make
  caching worth it.

## NestJS by feature module

```
src/
├── main.ts
├── app.module.ts
├── common/                  # guards, filters, interceptors, pipes used everywhere
├── config/                  # typed config loading and validation
└── orders/                  # one folder per feature
    ├── orders.module.ts
    ├── orders.controller.ts
    ├── orders.service.ts
    ├── dto/
    │   └── create-order.dto.ts
    ├── entities/
    │   └── order.entity.ts
    └── orders.service.spec.ts
test/
└── orders.e2e-spec.ts       # end-to-end tests against the running app
```

- One Nest module per feature. A module exports only the services other
  modules need.
- `common/` holds only code used by several features. Code used by one
  feature stays in that feature's folder.

## Frontend by feature

```
src/
├── app/                     # Next.js routes (app router), or routes/ for Vite
├── features/
│   └── checkout/
│       ├── components/
│       ├── hooks/
│       ├── api.ts           # calls to the backend for this feature
│       └── index.ts         # what other features may import
├── components/              # shared, generic UI (Button, Modal)
├── lib/                     # shared non-UI helpers (fetch client, formatting)
└── main.tsx                 # Vite entry; not used with Next.js
```

- Group by feature, not by file type. A change to checkout touches one
  folder.
- Features import each other only through their `index.ts`.
- `components/` is for generic UI with no feature logic. When a component
  is used by one feature only, it lives in that feature.
