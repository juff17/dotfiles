---
name: make-diagram
description: >
  Explain something with a Mermaid diagram drawn in the diagram pane beside the
  chat: the picture goes in the pane, the words stay in chat. Use whenever the
  user asks for a diagram, a picture, a visual, a flowchart, a sequence or state
  diagram, "draw this", "show me how this flows", "visualize this", or asks to
  have something explained visually.
license: MIT
---

# make-diagram: explain with a picture beside the chat

Two places, two jobs:

- **The pane** holds the picture: one Mermaid diagram per idea.
- **The chat** holds the words: a few short bullets that walk the picture.

The reader looks at the pane while reading the chat. Never paste the Mermaid
source into chat, and never repeat in chat what the picture already shows.

## Steps

1. **Read enough to be right.** Every node and arrow comes from the code or
   the facts in front of you, never from a plausible guess.
2. **Pick the diagram type** (table below), then draw.
3. **Send it to the pane.** Call `mcp__diagram-pane__show` with a short
   `title` and the `mermaid` source. The pane renders it as an image in the
   terminal's own colors. If the tool is not listed, tell the user to run
   `/diagram-pane` to check the mod is loaded, and give the source in a
   ```mermaid fence instead. If it fails with `mmdc` missing, tell the user to
   run `PUPPETEER_SKIP_DOWNLOAD=1 npm install` in the mod's folder.
4. **On a syntax error**, the tool's result names it. Fix the source and call
   again. Don't explain the error to the user.
5. **Write the chat part**: 2 to 5 bullets in the order the eye follows the
   diagram. Say what the picture can't: why, the surprise, the risk.

Several ideas get several diagrams, one call each. The pane keeps them all and
the user pages through with `p` and `n`, scrolls over the picture to zoom, pans with `h` `j` `k` `l`, or clicks "open full size" for the
PNG.

## Choosing the diagram

| The thing is about | Draw a | Mermaid |
|---|---|---|
| Which parts exist and how they connect | System map | `flowchart TD` |
| A request or job moving through steps | Pipeline | `flowchart TD` |
| Two or more actors talking over time | Sequence | `sequenceDiagram` |
| Something with modes or statuses | State machine | `stateDiagram-v2` |
| Tables, records, relationships | Entity map | `erDiagram` |
| A number that changed | Chart | `xychart-beta` |

## Rules that keep it readable

- **15 nodes at most.** More is two diagrams.
- **`flowchart TD`, not `LR`.** The pane is tall and narrow; `LR` past about 5
  nodes is too wide to read.
- **Short labels.** 1 to 4 words. Detail goes in chat.
- **Quote any label with spaces or punctuation:** `B["retry (2^n)"]`, not
  `B[retry (2^n)]`. Unquoted parentheses, colons and `>` break the parser.
- **Diagram the flow of data or control**, not the folder tree.
- **Mark changes in the label** when explaining a change: `*` new, `~`
  changed, `x` removed, and say the legend once in chat.
- **No hard-coded colors.** Skip `style`, `classDef` and `%%{init}%%` color
  settings; the pane themes every diagram from the terminal.
- **Never draw ASCII art.** If Mermaid feels wrong, pick another Mermaid type
  or use a markdown table in chat.
