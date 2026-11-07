# Report format

## Step record

One record per step that can fail, in execution order. Number steps per entry
point: `E2.S5` is entry point 2, step 5.

| Field | What to write |
|---|---|
| `id` | `E<n>.S<n>` |
| `location` | `file:line` or `file:start-end`, from code you read |
| `operation` | Concrete: "INSERT orders", "POST Stripe /charges", "publish order.created". Not "saves data". |
| `committed_so_far` | Side effects already durable before this step, or "none" |
| `failure` | How it fails, using the checklist category |
| `handled_at` | `file:line` of the handler, or "none, propagates to X" |
| `action` | propagate, translate, retry (bounded? safe to repeat?), roll back, compensate, fall back, log and continue, swallow |
| `seen_by` | user (what they see), caller (status, exit code), operator (log level, alert), or nobody |
| `state_after` | consistent, partial (list what's left), stuck (which status or lock, and who waits on it), or unknown |
| `verdict` | See below |
| `reproduced` | yes (how), or no |
| `evidence` | A short quote of the relevant code |
| `fix` | One line. Only when the verdict is not `HANDLED` or `DEGRADED-OK`. |

## Verdicts

| Verdict | Meaning |
|---|---|
| `HANDLED` | Caught, surfaced to the right party, state consistent |
| `DEGRADED-OK` | A deliberate, visible fallback (a comment, a test, or documentation shows intent) |
| `DESTRUCTIVE` | Deletes or overwrites something it doesn't own, or that the user didn't ask to change |
| `SILENT` | Fails with no useful signal to the user, caller, or operator |
| `PARTIAL-STATE` | Fails after earlier writes, and they are not undone |
| `MISLEADING-SUCCESS` | Reports success while the work failed |
| `UNHANDLED` | Nothing catches it; it crashes or reaches a last-resort handler. A bare exit code or 500 with no explanation is this, not `SILENT`. |
| `STUCK-STATE` | Leaves a status, lock, or pending record that nothing moves on, so later work skips it or waits for it |
| `OUT-OF-ORDER` | Another process can see the data before it is complete or committed, or apply updates in the wrong order |
| `UNTRACEABLE` | The path couldn't be followed (dynamic dispatch, missing code); say why |

## Output

### In chat

1. One line: base, HEAD commit, entry points traced, number of findings.
2. With 2 or more entry points, a table with one row per entry point and a
   count per verdict:

   | Entry point | Steps | DESTRUCTIVE | PARTIAL-STATE | STUCK-STATE | OUT-OF-ORDER | MISLEADING-SUCCESS | SILENT | UNHANDLED |
   |---|---|---|---|---|---|---|---|---|

   Leave out verdict columns that are all zero.
3. Top findings ranked by **consequence**: lost or overwritten data first, then
   data left inconsistent or stuck (including what other processes read too
   early or out of order), then users told something false, then failures
   nobody sees, then noisy crashes that a re-run fixes. Use the verdict only to
   break ties. For each: id, location, one sentence on what goes wrong, the
   fix, and whether it was reproduced.
4. Open questions: fallbacks that might be deliberate, and assumptions about
   code outside the repo.
5. Notes: things worth knowing that aren't findings (a risky pattern the PR
   doesn't reach yet, an assumption you checked). Skip if empty.
6. The path to the full report, and the offer to fix or make a tour.

Keep chat short. The full detail goes in the file.

### Full report file

Write to `.claude/docs/audits/pr-audit-<name>.md`, where `<name>` is the
branch, or the short HEAD hash when auditing the default branch. Use a path the
user gives instead, if any.

- Header: branch, base, merge-base commit, HEAD commit, date.
- One section per entry point: a one-line description of the path, then a table
  of every step record in order (including `HANDLED` steps, so the reader sees
  the whole path).
- A final "Assumptions" section for code outside the repo.

## Tour mapping (`--tour`)

One tour step per finding (skip `HANDLED` steps unless the user wants the full
path), in execution order across entry points.

| Tour field | From the record |
|---|---|
| `file`, `line` | `location` |
| `title` | `[<verdict>] <short operation>`, e.g. `[SILENT] Stripe charge retry` |
| `description` | Two to four sentences: what fails here, what the user and the data are left with, and the fix. |

Start the tour with a file step at the first entry point, and end with a
content step listing the fixes in the same order as the chat report.
