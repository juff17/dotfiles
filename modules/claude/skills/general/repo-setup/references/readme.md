# Writing the README

Used for the README-only path, and for the README step of a new or existing
repo. To update an existing README, read it first and keep the sections that
already follow these rules. Change only what is wrong, missing, or out of date.

A README is the first thing a developer reads about a project, and usually
decides whether they read anything else. Its audience is developers meeting
the project for the first time: people trying to understand and set up a new
tool or library. It is less for people who already know the codebase.
Everything below follows from writing for that reader.

## The reader's order

Order the README so it answers the reader's questions in sequence:
*what is this?* → *how do I use it?* → *where are the docs and examples?* →
*how do I contribute?* Each question only matters if the previous answer kept
the reader interested. Never make someone scroll past contribution guidelines
to find out what the project does. The sections below follow the same order,
top of the document to bottom.

## Tone

- Professional and informative. A README is not a conversation.
- Don't use two sentences when one is enough.
- No emojis unless the user asks for them (the ✅ and ❌ in the platform table
  are the exception).
- Leave out project-specific knowledge a new user would not understand. It
  does not belong in a README.

## Proportional length

A README does not need to be long to be good. Give the minimum a user needs,
in proportion to the project's size. A simple project needs a small README; a
complex one may earn a longer one. Never pad a small project's README to look
thorough.

## The header

The README opens with a centered header block, in this order: logo, title,
one-line tagline, badges, then a divider.

- The logo is a `<picture>` element with a dark-mode variant and a
  placeholder comment, so the user can add their own images.
- Badges stay on one centered row. Pick the ones that fit this project:
  build or CI status, package version, license, downloads, supported
  platforms, supported agents, test coverage. Don't add every badge available.

```markdown
<p align="center">
  <!-- LOGO PLACEHOLDER: add assets/logo.png (and assets/logo-dark.png for dark mode) -->
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
    <img src="assets/logo.png" width="220" alt="project logo">
  </picture>
</p>

<h1 align="center">project-name</h1>

<p align="center">
  <em>One-line tagline describing the project.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-111111?style=flat-square" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license">
</p>

---
```

## The opening

The first 10 or so lines give an overview of the project. The best
descriptions are concrete (for example, "Fast, disk space efficient package
manager"). A reader should finish the opening knowing exactly what the
project is.

## Core functionality list

Add one only if the project has several distinct uses or abilities. It is a
list of what the project can do, not a how-to. Skip it for a project with one
core function (for example, a tool that tracks the directories you visit most
and jumps to them).

- One bulleted list, each bullet at most one sentence.
- No granular detail. The list tells readers what they could use the project
  for.

## Platform support

If the project supports some platforms and not others, add a table of
supported and unsupported platforms. Mark each with the literal characters ✅
and ❌, not emoji shortcodes. For example, a project that supports some AI
coding agents lists each agent with a check or a cross, so a reader sees at a
glance whether theirs is covered.

## Write for the category

When a project targets one platform today but peers exist in the same
category, write the body using the category's general term ("coding agent")
rather than the platform's name. Name a specific platform only where facts
require it: the platform support table, and installation steps grouped under
a per-platform subsection. Supporting a new platform later then means adding
a subsection, not rewriting the document.

## Setup

Include a section for any setup the user must do themselves: dependencies
that need to be installed and are *not* installed by the project's own setup.
For a repo with a Makefile or justfile, point at its targets (`make setup`,
`make test`) instead of repeating the raw commands.

## Show, don't tell

When possible, show rather than describe. A short code example
(`import x; do_x_thing()`) guides a user better than prose about the same
thing.

- Keep examples in the README while each is under 20 to 30 lines and there
  are only 2 or 3 of that size.
- Past that, keep the core examples in the README and move the rest to an
  examples folder.
- Don't create a folder for only 1 or 2 examples.
- **Ask** the user before creating an examples folder, after the first README
  draft is written.

## Commands

If the tool has a fixed set of commands (CLI commands, slash commands), list
them all in a table, the README's version of `--help`. One row per command:
the command with its arguments, then a one-line description.

```markdown
| Command | What it does |
|---------|--------------|
| `tool init` | Scaffold a new project in the current directory. |
| `tool run [target]` | Run the given target, or the default if omitted. |
```

## Visual tools

For a visual tool (a TUI or GUI), add a placeholder section for a video, but
only where a visual example is needed to understand the tool. Most things can
still be explained in words; don't mark everything as needing a video. When
you add a placeholder, **tell the user in bold** so they remember to add the
video.

## Review your work

Your first draft is not your best. Check it against these rules:

- Did I add a video placeholder where words would have been fine?
- Did I describe something visual in words instead of adding a video
  placeholder?
- Can any explanation be simpler?
- Did I cover the main uses and core functionality correctly?
- Did I go into granular detail?
- Did I name one platform where the category term belongs?
- Did I follow the header format, and use literal ✅ and ❌ characters rather
  than emoji shortcodes?
