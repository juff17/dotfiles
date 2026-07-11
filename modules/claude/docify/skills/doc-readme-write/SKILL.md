---
name: doc-readme-write
description: >
  Create and update a project's README. Use when the user wants to write
  a readme, improve or restructure an existing one, or document a new project.
license: MIT
---

A README is the first thing a developer reads about a project, and usually the
thing that decides whether they read anything else. Its audience is developers
meeting the project for the first time — people looking to understand and set
up a new tool or library, it is less for people who already know the codebase. 
Everything below follows from writing for that reader.

## The reader's order

The README is orderd to reveal information the devopers need progressviely: *what is
this?* → *how do I use it?* → *where are the docs and examples?* → *how do I
contribute?* Each question only matters if the answer to the previous one kept
the reader interested, so the document should answer them in that sequence and
never make someone scroll past contribution guidelines to find out what the
project does. The sections below follow this same order, top of the document
to bottom.

## Tone

Use a professional and informative tone. A README is not a conversation and
should not read like one — stay focused on the project, do not use two sentences
when one is sufficient, avoid using emojis unless instructed otherwise, avoid overly
verbose and frivolous language. Part of the audience includes new users and we should
avoid project specific knowledge that new users would not understand and information
that fits this criteria does not belong in a README.

## Proportional length

A README does not need to be long to be good. It should contain the minimal
amount of information needed to guide a user and its length should be proportional
to the project's scope and size. A simple project only needs a small README, while
a more complex project may earn a more extensive one. Never pad a small project's README to look thorough.

## The header

The README opens with a centered header block, in this order: logo, title,
one-line tagline, badges, then a divider. The logo is a `<picture>` element
with a dark-mode variant and a placeholder comment so the user can drop in
their own images. Badges stay to one centered row — not a wall. Pick the
badges that are right for this project rather than adding everything
available; common candidates include build/CI status, package version,
license, downloads, supported platforms, supportend agents, and test coverage. Use this format:

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

## The Opening

The first approximately 10 lines should give an overview of the project. The best
descriptions are concrete, (e.g. "Fast, disk space efficient package manager"). 
A reader should finish the opening knowing exactly what the project is.

## Core functionality list

Before adding, ask if this project deserves a core functionality list. For example,
if the project is for a tool with multiple unique use cases or abilities then a list of
features and capabilities makes sense. This is not a how to use guide or instruction set,
but a capabiltiies list - what it can do. Do NOT create a core functionality list if it does not 
fit the project, for example a project that tracks the directories you visit most and jump to them
does not need a core functionality list, it has only one core function.

Present information in a bulleted list where each bullet is at most one sentence long. Do NOT
overexplain or go into granular details, this list is to bring to the readers attention what they
could use this project for.

## Platform Support

If the project only supports certain platforms and not others, create a table listing
the supported platforms in the README that outlines supported versus
unsupported platforms, using the literal emoji characters ✅ and ❌ to mark
each one. For example, if the project only supports certain AI coding
agents, the table would list various coding agents with a check
or cross for each — so a reader can see at a glance whether their platform
is covered.

## Write for the Category

When a project targets one platform today but peers exist in the same
category, write the body prose using the category's general term
("Coding Agent") rather than the platform's name. Name a specific platform
only where facts require it: the platform-support table, and installation
instructions grouped under a per-platform subsection. Then supporting a new
platform later means adding a subsection, not a full document re-write

## Setup

Include a section for any setup required by the user — specifically, any
dependencies that need to be installed and are *not* installed automatically
by running the setup.


## Show, don't tell

The best descriptions are visual — when possible, show rather than tell. A
short code example ("import x, do_x_thing()") can guide the user better than
prose describing the same thing. BUT when the project has a lot of
functionality this breaks down and code examples become exhaustive and deserve
their own subfolder. When an example would exceed 20–30 lines or require more than 2-3
examples around the maximum allowed length, keep the core ones in the README and move
the other to a example folder instead. Do not create a folder for only 1-2 examples to
be kept in it. Before creating a example folder, ASK the user if they want to create an example
folder for additional examples AFTER you create the initial README.

## Commands

If the tool has a finite list of commands, such as CLI commands or slash
commands, list them all in a table — the README's equivalent of `--help`.
These inform the user of how they will use this project and will be one of
the first places they look for help when getting started. One row per
command: the command (with its arguments) in the first column, a one-line
description in the second. For example:

```markdown
| Command | What it does |
|---------|--------------|
| `tool init` | Scaffold a new project in the current directory. |
| `tool run [target]` | Run the given target, or the default if omitted. |
```

## Visual tools

If the application is a visual tool, such as a TUI or a GUI, add a placeholder
section for the user to upload a video. You cannot example a tool that requires 
a video walkthrough in words. When considering if you should ask yourself if this
would make more sense to a user with a video or if it would be easier to explain 
with a video. Do NOT classify everything as needing a video, things can still be 
explain through word much of the time. Only use this when a **visual** example would
aid in understanding or is critical to understanding. When you add a placeholder for a
video, always **notify the user in bold output text** so they make sure to go
back and add the video or visual.

## Reviewing Your Work

Your first attempt will not be your best attempt. Look through your work carefully and review if you
have followed the instructions. Consider the following:
- Did I add a placeholder for a video when words would have been fine?
- Did I try to explain something visual instead of adding placeholder text for a video?
- Can any of my explanations be simplified?
- Did I cover the main usages and core functionality of this project correctly?
- Did I focus on granular details too much?
- Did I write prose around one platform's name where a category term belongs?
- Did I follow the header format, and use literal ✅/❌ characters rather than emoji shortcodes?

Use this to help review and refine your work.
