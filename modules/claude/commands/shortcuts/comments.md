---
description: Write comments that explain why the code is the way it is - nothing else.
---

A comment exists to say what the code cannot: the constraint behind a choice, the reason the obvious approach fails, the trap waiting for whoever edits this next. If a comment is not doing that, delete it. Never restate what the line already says.

Keep comments short. Avoid writing one that runs many lines. Never write one longer than the code it describes.

Write about the code as it is, never about the change you are making to it. Anything true only right now is banned - "new", "for now", "temporary", "this replaces", "was previously", "will be removed once" - as is any explanation aimed at the problem you just fixed rather than at how the code works. Leave no TODOs. If the comment would read as wrong or pointless a year from now, it is wrong now.

Our conversation never appears in a comment. Not my instructions, not my wording, not my terminology, not a justification aimed at me, not a reference to the task, the prompt, or a ticket. The reader was never in this conversation. Write every comment as though the code has always looked this way and you have never spoken to me.

Example - instead of:

```
// Loop through the items and increment the counter
// Added retry logic as requested to fix the timeout issue we were seeing
// TODO: clean this up later
```

Write:

```
// The vendor API 502s under sustained load and retrying immediately makes it
// worse, so the delay doubles up to 30s before we give up.
```
