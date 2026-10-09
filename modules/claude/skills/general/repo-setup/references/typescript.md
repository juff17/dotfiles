# TypeScript

Defaults: pnpm, `tsc --noEmit` with `strict`, Vitest, and either
ESLint + typescript-eslint + Prettier or Biome. `<latest>` means look the
version up when writing. Never fill it in from memory.

## Start the project

| Kind | Start from |
|---|---|
| Library or CLI | `pnpm init`, then add the files below |
| Vite frontend | `pnpm create vite <name> --template react-ts`, then tighten its tsconfig and lint config with the settings below |
| Next.js | `pnpm create next-app <name> --ts`, then tighten as above |
| NestJS | `pnpm dlx @nestjs/cli new <name> --package-manager pnpm --strict` |
| Monorepo | Root `package.json` and `pnpm-workspace.yaml` (see [layouts.md](layouts.md)), then each app from its own starter |

Generators write configs that match their current version. Keep their
structure and change only the settings below; don't replace a generated file
with a template from memory.

Dev tools: `pnpm add -D typescript vitest @vitest/coverage-v8` plus the lint
tools for the chosen option below.

**TypeScript 7 and typescript-eslint.** TypeScript 7.0 ships no compiler API,
and typescript-eslint fails on it ("typescript-eslint does not support TS
7.0"). Check `npm view typescript version` and typescript-eslint's support
issue when writing. While the gap remains, install the TypeScript 6 API under
the `typescript` name and TypeScript 7 under an alias, as the
[TypeScript 7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60)
recommends:

```json
"devDependencies": {
  "@typescript/native": "npm:typescript@^<latest 7>",
  "typescript": "npm:@typescript/typescript6@^<latest 6>"
}
```

`tsc` then runs TypeScript 7 and typescript-eslint uses the 6.0 API. Biome
doesn't use the TypeScript API, so it needs no alias.

## package.json

```json
{
  "name": "my-lib",
  "version": "0.1.0",
  "type": "module",
  "packageManager": "pnpm@<latest>",
  "engines": { "node": ">=<current LTS major>" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "check": "pnpm lint && pnpm format:check && pnpm typecheck && pnpm test"
  }
}
```

- `packageManager` lets CI and corepack use the same pnpm version as you.
- Add `.nvmrc` with the Node major version; CI reads it.
- With Biome, replace `lint`, `format` and `format:check` with
  `biome check .`, `biome check --write .`, and `biome ci .`.

## tsconfig.json (library, CLI, or Node service)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test", "*.config.ts"]
}
```

`*.config.ts` must be included, or ESLint's type-aware rules fail on
`vitest.config.ts` with "was not found by the project service".

```json
// tsconfig.build.json: emits only src/
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["**/*.test.ts"]
}
```

- **Vite or Next.js:** keep the generator's `module`, `moduleResolution`
  (`Bundler`) and `jsx` settings. Add `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, and `noFallthroughCasesInSwitch` if missing.
- **NestJS:** keep `experimentalDecorators`, `emitDecoratorMetadata`, and
  the CommonJS module settings it generates. `--strict` turns on the strict
  flags. Don't add `verbatimModuleSyntax`; it conflicts with Nest's CommonJS
  output.

## Option A: ESLint + typescript-eslint + Prettier

`pnpm add -D eslint @eslint/js typescript-eslint prettier eslint-config-prettier`

```js
// eslint.config.js
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist/", "coverage/"] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] },
  prettier, // last: turns off rules that fight the formatter
);
```

`.prettierrc` is `{}`, which means Prettier's defaults. Add options only if
the user asks for them.

Add a `.prettierignore` with `dist`, `coverage`, and `pnpm-lock.yaml`.

For React, add `eslint-plugin-react-hooks` (and Next.js's own config for
Next). Use the plugin's current flat config export; check its README.

## Option B: Biome

`pnpm add -D --save-exact @biomejs/biome`, then `pnpm biome init`. `init`
writes a `biome.json` with the right `$schema` for the installed version.
Then set:

- `vcs.enabled: true`, `vcs.clientKind: "git"`, `vcs.useIgnoreFile: true`
  (Biome skips gitignored files).
- Keep the recommended rule preset `init` writes (current versions use
  `"rules": { "preset": "recommended" }`; don't rewrite it to an older key).
- `formatter.indentStyle: "space"`.

Biome does not run type-aware rules as deeply as typescript-eslint's
`strictTypeChecked`. Mention this when the user picks it.

## vitest.config.ts

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    coverage: { provider: "v8", reporter: ["text", "lcov"] },
  },
});
```

A new repo needs one real test so `pnpm test` proves something:

```ts
// test/add.test.ts
import { describe, expect, it } from "vitest";
import { add } from "../src/add.js";

describe("add", () => {
  it("adds two numbers", () => {
    expect(add(2, 3)).toBe(5);
  });
});
```

With `NodeNext`, relative imports need the `.js` extension, even from `.ts`
files.

## Makefile

```make
.PHONY: setup lint format typecheck test check

setup:
	pnpm install

lint:
	pnpm lint
	pnpm format:check

format:
	pnpm format

typecheck:
	pnpm typecheck

test:
	pnpm test

check: lint typecheck test
```

## .gitignore

```
node_modules/
dist/
coverage/
*.tsbuildinfo
.env
.env.*
!.env.example
.next/
```

Drop `.next/` unless the project uses Next.js.

## Baselines for an existing repo

| Tool | How to baseline existing violations |
|---|---|
| ESLint | Since ESLint 9.24: `pnpm eslint . --suppress-all` writes `eslint-suppressions.json`. New violations still fail; `--prune-suppressions` removes entries once fixed. On older ESLint, upgrade first or use `overrides` for legacy folders. |
| Biome | Relax rules for legacy paths with `overrides` in `biome.json` (`includes` plus a `linter.rules` block). Remove entries as folders are fixed. |
| tsc strict | No built-in baseline. Turn on one strict flag at a time and fix, or for a large repo use `typescript-strict-plugin` (check its README) to mark existing files as exempt while new files are strict. |
| Prettier | Run `pnpm format` once in its own commit so the formatting change is separate from logic changes. Add that commit to `.git-blame-ignore-revs`. |

Report the counts so the user knows the size of the backlog.
