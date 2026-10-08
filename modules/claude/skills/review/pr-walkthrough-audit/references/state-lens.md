# State lens (`--state`)

For UI entry points that use shared client state (Redux, Zustand, Pinia,
context, signals, or a hand-rolled store). It finds actions that each work on
their own but cancel each other out, so a button "does nothing" without any
error.

Example: a "New Email" button calls `setComposeMode(true)`, then
`selectThread(null)`. Both work. But `selectThread` also sets
`composeMode: false`, so the button does nothing. No error is thrown, so error
tracing alone never finds it.

## 1. Map the store first

Before tracing any handler, list every store action the PR's entry points can
reach:

```
STORE: emailStore
  setComposeMode(bool)  sets {composeMode}
  selectThread(t|null)  sets {selectedThread, messages}  RESETS {composeMode, composeData}

RESETS OF STATE THE ACTION DOESN'T OWN:
  selectThread resets composeMode (owned by setComposeMode)
```

If entry points are traced in parallel, build this map once and give it to
every subagent.

## 2. Add to each step record

| Field | What to write |
|---|---|
| `state_writes` | Fields this step sets |
| `state_resets` | Fields this step clears or resets as a side effect |

## 3. Check each handler for

| Pattern | What happens |
|---|---|
| Sequential undo | A later call resets what an earlier call just set |
| Async race | Two async calls set the same field; the result depends on which finishes last |
| Stale closure | A callback reads an old value captured when it was created |
| Effect interference | An effect watching a field resets it right after the handler sets it |
| Dead branch | A condition that is always false at that point, so the real work never runs |
| Missing transition | The label promises an action ("Save", "Send") that the handler never performs |

Finally compare the **final state** with what the button label or form
promises. A mismatch is a `MISLEADING-SUCCESS` finding even when no error is
thrown.
