---
name: todo
description: >-
  Add, list, finish or change items on the user's todo list, the one the
  Ghostty viewer's Todo mode shows across every repo. Use when the user runs
  /todo, or asks to add a todo, note something for later, "remind me to…",
  "put that on the list", asks what's on their todo list, or says a todo is
  done. Only add items the user asked for; never add them unprompted.
---

# Todo

The list lives in one file shared by every repo. Change it only through
`~/.config/ghostty/bin/ghostty-todo`. When you add an item from here, the CLI
records the repo, branch, worktree, tmux tab and this Claude session itself,
so the user can jump back to this tab from the viewer later. Don't pass any of
that in.

## Adding

```bash
~/.config/ghostty/bin/ghostty-todo add --cat <category> --note "<note>" <title>
```

- **Title:** at most about 50 characters, saying what to do. For example
  "Add a test for the /settings hydration fix", not "Hydration".
- **Category:** pick one.
  - `bug`: something is broken.
  - `feature`: something new to build.
  - `follow-up`: unfinished or deferred work from this session. This is the default.
  - `docs`: writing or updating docs.
  - `question`: something to decide or find out.
- **Note:** one to three sentences that let the user, or a later Claude, pick the
  item up cold. Say what's left, where it is (file, function, PR) and why it
  matters. Leave the note out when the title says it all.
- `--dir <path>` files the item under another repo than the current folder's.
- When the user lists several items, add each one with its own call.

After adding, say in one line what you added and its id, for example
"Added `k3f` (follow-up): Add a test for the /settings fix".

## Listing, finishing and changing

```bash
~/.config/ghostty/bin/ghostty-todo list           # this repo's open items
~/.config/ghostty/bin/ghostty-todo list --all     # every repo's
~/.config/ghostty/bin/ghostty-todo done <id>...   # or: undo, rm
~/.config/ghostty/bin/ghostty-todo edit <id> --title "…" --cat <category> --note "…"
```

An id can be shortened to any start of it that is unique. When you have just
finished the work an item describes, mark it done if the user asked you to do
that item. Otherwise, mention that it looks done and let them decide.

## Not adding unprompted

Add an item only when the user asks for one. If you end a task with work left
over, say so and offer to add it ("Want me to /todo the missing test?"). Don't
add it yourself.
