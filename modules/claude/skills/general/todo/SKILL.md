---
name: todo
description: >-
  Add, file, list, finish or change items on the user's todo list, the one the
  Ghostty viewer's Todo mode shows across every repo. Use when the user runs
  /todo, or asks to add a todo, note something for later, "remind me to…",
  "put that on the list", asks what's on their todo list, or says a todo is
  done; and when the Todo pane sends a message to file. Only add items the
  user asked for; never add them unprompted.
---

# Todo

The list lives in one file shared by every repo. Change it only through
`~/.config/ghostty/bin/ghostty-todo`. When you add an item from here, the CLI
records the repo, branch, worktree, tmux tab and this Claude session itself,
so the user can jump back to this tab from the viewer later. Don't pass any of
that in.

## Writing an item

- **Title:** at most about 50 characters, saying what to do. For example
  "Add a test for the /settings hydration fix", not "Hydration".
- **Category:** pick one.
  - `bug`: something is broken.
  - `feature`: something new to build.
  - `follow-up`: unfinished or deferred work. This is the default.
  - `docs`: writing or updating docs.
  - `question`: something to decide or find out.
  - `other`: errands and busywork that fit none of the above, often outside
    any repo.
- **Type:** only when it's clear what kind of work it is, else leave it out.
  - `research`: find something out.
  - `decide`: make a call.
  - `action`: do or build something.
  - `review`: judge someone's work, like a PR.
  - `chore`: upkeep.
- **Note:** one to three sentences that let the user, or a later Claude, pick the
  item up cold. Say what's left, where it is (file, function, PR) and why it
  matters. Leave the note out when the title says it all. Don't add causes,
  fixes or details the user didn't give.

## Picking the repo

Always decide which repo an item belongs in, and pass it with `--dir`, even
the one you're in. Never assume it's the current one: the user often adds a
todo in one tab about another repo, or about no repo at all, and won't always
say which.

1. List the candidates: `~/.config/ghostty/bin/ghostty-todo repos` prints the
   git repos on disk, one `name<TAB>path` a line.
2. If the user names one, even loosely ("my dotfiles", "pixel mcp" for
   pixel-mcp), that's the repo.
3. Otherwise search those repos for what the item is about, read-only, with
   Grep, Glob, Read and ls: the feature, tool, file or command it mentions. The
   user's words often aren't the code's, so also search for other names the
   code may use for the same thing (a task bar app may be a tray, panel, widget
   or plasmoid), and read the READMEs and docs of repos that match. Skip
   node_modules and other vendored folders. Keep it to a handful of searches.
4. Bugs and features almost always belong in a repo, and other categories
   often do too. Errands and anything not about code (buy coffee filters, book
   a dentist) belong in none: pass `--dir none`. Use none too when you searched
   and no repo holds it.

Search only to find the repo; don't start on the item.

## Adding

```bash
~/.config/ghostty/bin/ghostty-todo add --dir <repo path or none> --cat <category> [--type <type>] [--note "<note>"] <title>
```

When the user lists several items, add each one with its own call. After
adding, say in one line what you added, its id and repo, for example
"Added `k3f` (follow-up, dotfiles): Add a test for the /settings fix".

## Filing from the Todo pane

The Todo pane sends a message like "File this todo from the Todo pane as
filing `<id>`. It was typed in … . The message: …". The pane already shows an
item with that id and a spinner; you fill it in instead of adding a new one.

1. Write the title, category, type and note from the message (Writing an
   item), and pick the repo (Picking the repo). Where it was typed is only
   where the user was, not the answer. The only commands you can run are
   `ghostty-todo repos`, `ghostty-todo add` and `ls`; search with the Grep,
   Glob and Read tools, not shell commands like git, grep or find. A command
   that's denied changes nothing else: carry on and file the item.
2. Run this once:

   ```bash
   ~/.config/ghostty/bin/ghostty-todo add --filing <id> --dir <repo path or none> --cat <category> [--type <type>] [--note "<note>"] <title>
   ```

3. Then stop. There's no one to reply to and nothing else to do.

## Listing, finishing and changing

```bash
~/.config/ghostty/bin/ghostty-todo list           # this repo's open items
~/.config/ghostty/bin/ghostty-todo list --all     # every repo's
~/.config/ghostty/bin/ghostty-todo done <id>...   # or: undo, rm
~/.config/ghostty/bin/ghostty-todo edit <id> --title "…" --cat <category> --type <type> --note "…"
```

An id can be shortened to any start of it that is unique. When you have just
finished the work an item describes, mark it done if the user asked you to do
that item. Otherwise, mention that it looks done and let them decide.

## Not adding unprompted

Add an item only when the user asks for one. If you end a task with work left
over, say so and offer to add it ("Want me to /todo the missing test?"). Don't
add it yourself.
