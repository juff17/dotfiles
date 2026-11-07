# claude module

Coding-agent tooling (skills, slash commands, subagents, hooks, and Claude Code
settings), organized by **category**. `./install.sh claude` from the dotfiles
root installs Claude Code and then runs `./setup` here, which puts every tool in
the right place for whichever agent(s) you have installed.

## Layout

```
modules/claude/
  install.sh            # dotfiles install step: Claude Code, then ./setup
  setup                 # links the folders below into each agent
  lib/
    link.sh             # symlink-or-copy helper
    targets.sh          # the only vendor-specific file: vendor -> install dirs
  skills/
    <category>/<name>/SKILL.md
  commands/
    <category>/<name>.md
  agents/
    <category>/<name>.md
  hooks/
    <category>/<name>.sh     # -> ~/.claude/hooks/<name>.sh
  mods/
    <category>/<name>/       # -> ~/.claude/mods/<name>, loaded via CLAUDE_CODE_PLUGIN_DIRS
  config/
    <category>/<file>        # -> ~/.claude/<file> (settings.json, statusline)
  tests/
    test_<tool>.py           # not installed; setup only links the folders above
  evals/
    triggers/<skill>.json    # not installed; trigger cases for each skill
```

Tools are grouped by type first, then by **category**: `docify` (document
writing), `review`, `daily-prep` (standup prep), `general`,
`shortcuts` (short-circuit guidance prompts), and `core` (settings and hooks). A category is a
source-organization and install-selection concept only — at install time skills
and agents flatten into the agent's own directories, so **their names must be
globally unique across categories.** Commands are the exception: they are
namespaced by category, so `commands/shortcuts/discuss.md` installs as
`/shortcuts:discuss`.

## Tests

Tests for the tools' scripts live in `tests/`, one `test_<tool>.py` per tool.
They use only Python's built-in `unittest`, so there is nothing to install,
and they never call a real GitHub or GitLab:

```sh
python3 -m unittest discover -s tests
```

CI runs them on every push to main and every PR (`.github/workflows/tests.yml`
at the dotfiles root).

## Trigger evals

`evals/run_triggers.py` checks that each skill's description makes it fire on
the prompts it should, and not on near-misses. `evals/triggers/<skill>.json` is
a list of `{"query", "should_trigger"}` cases: six that should fire it and four
that share its words but want something else (`system-overview` runs only
from its slash command, so it has near-misses only). Queries never start with
`/`: `claude -p` runs a slash command itself, so no Skill call would show. Each query goes to `claude -p`
with every installed skill loaded, so the skills compete as they do in real
use, and the run stops at the first tool call. A failed case names the skill
that fired instead, so a collision between two skills shows up as one.

```sh
python3 evals/run_triggers.py                # every skill, about 3 minutes
python3 evals/run_triggers.py todo gitlink   # just these
python3 evals/run_triggers.py -j 6 --runs 3  # 6 at once, majority of 3 runs
```

Runs use your Claude login and count against its usage, so they are not in CI.
Hooks are off and nothing is saved, so runs don't show in the agent hub. Each
run's full results go to `evals/results/` (git-ignored). Re-run a skill's
cases after changing its description, and add a case for each miss you see in
real use. A new skill needs a case file: `tests/test_run_triggers.py` fails
without one.

## Install

```sh
./setup                   # every category into every detected agent
./setup --host claude     # only Claude Code
./setup --category docify # only the docify category
./setup --dry-run         # show what would happen, change nothing
./setup --uninstall       # remove everything setup installed
./setup --copy            # copy instead of symlink (Windows / forced)
./setup --force           # also replace items setup did not install
```

Setup only replaces or removes what it installed (a symlink into this repo, or
a copy recorded in the git-ignored `.installed` file). If something else
already has a tool's name, setup skips it with a warning. Installs whose
source was renamed or deleted are removed on each run.

Installs are **symlinks** on macOS/Linux, so edits here are live and
`git pull` updates every machine. Re-run `./setup` only after adding or
removing tools, or on a fresh machine. It is idempotent.

**Run setup from the main dotfiles checkout, never from a worktree.** The
links point back into the folder setup ran from, so a worktree's links break
once it is removed. `./install.sh --links` doesn't run setup (it also installs
plugins and npm packages); run `modules/claude/setup` yourself after adding or
removing a tool.

`config/core/keybindings.json` turns off Claude's `alt+t` (thinking on or off),
which the Ghostty layout uses for Todo.

## Claude Code settings and plugins

`config/core/settings.json` installs as `~/.claude/settings.json` and registers
the hooks in `hooks/core/` by their installed path (`$HOME/.claude/hooks/...`).

Third-party pieces are downloaded rather than linked, so `./setup` installs
them for Claude after linking, skipping what is already there:

- **Marketplaces** listed in `extraKnownMarketplaces`, via `claude plugin marketplace add`.
- **Plugins** turned on in `enabledPlugins`, via `claude plugin install <id> --scope user`.
- **Mod packages**: `npm ci` in each mod with a `package-lock.json`, when
  `node_modules` is missing or older than the lockfile. Puppeteer's Chrome
  download is skipped; diagram-pane renders with `/usr/bin/google-chrome`.

To add a plugin, add it to `enabledPlugins` (and its marketplace to
`extraKnownMarketplaces`) and re-run `./setup`. A failed install is reported
with the command to retry. `--uninstall` leaves plugins and `node_modules` in
place. This step needs the `claude` CLI, `python3`, and `npm` on `PATH`.

Claude sends no desktop notifications. What needs you (a permission prompt, a
question, a finished agent, a failed pipeline) shows in the Agents panel
widget from the `ghostty` module, which reads every session itself; no
hook is needed. pr-babysit's `notify.sh` adds what only it knows (a fix ready
to push, a finished rebase) to that tray as a note.

## Vendor support

| Type     | Claude | Codex | OpenCode |
|----------|:------:|:-----:|:--------:|
| skills   |   ✅   |  ✅   |    ✅    |
| commands |   ✅   |  —    |    —     |
| agents   |   ✅   |  —    |    —     |
| hooks    |   ✅   |  —    |    —     |
| config   |   ✅   |  —    |    —     |

Skills are the portable backbone. Commands and agents are Claude-first today;
other vendors are wired for skills only and silently skip the rest. Add a vendor
by editing `lib/targets.sh` — nothing else changes.

## Adding a tool

1. Drop it under its type and category: `skills/general/my-skill/SKILL.md`,
   `commands/general/my-cmd.md`, or `agents/general/my-agent.md`.
2. `./setup` (or `./setup --dry-run` first).

Need a new category? Make a folder under `skills/`, `commands/`, or `agents/` —
`setup` discovers it automatically.
