# Diagram recipes

Pick **one** primary diagram. Two only if the change genuinely has two faces
(e.g. a data-model change *and* a new request flow). Never more than two.

The examples below are deliberately drawn from **different, unrelated domains** —
they teach the *shape*, not the subject. Never copy an example's nouns into your
output. Every box, arrow, and number must come from the code in front of you.

Universal markers — always include the legend line:

```
* new    ~ changed    x removed
```

---

## Choosing

| The change is about... | Draw a... |
|---|---|
| A request/job moving through layers | **Pipeline** |
| Two+ services/actors talking over time | **Sequence** |
| Something that has modes (draft/live/archived) | **State machine** |
| Tables, records, relationships | **Entity map** |
| Same input, different output than before | **Before / after** |
| A formula, a threshold, a number that moves | **Number line / curve** |
| Where a thing lives now vs before | **Placement** |

---

## Pipeline (most common)

Data or control flowing through stages. *Example domain: file upload.*

```
  POST /upload           UploadHandler         Scanner            S3
      │                       │                   │                │
      ├── multipart ─────────▶│                   │                │
      │                       ├── reject >50MB * ─┤                │
      │                       ├── virus scan * ──▶│                │
      │                       │◀── clean ─────────┤                │
      │                       ├── strip EXIF ~ ───┤                │
      │                       └── put(key) ───────────────────────▶│
      ▼
   201 {url, scanId *}

  * new    ~ changed
```

Keep boxes to ≤6. Annotate the arrow with *what travels*, not the method name.

---

## Sequence

When ordering and round-trips are the point. *Example domain: OAuth login.*

```
  Browser        App          AuthServer      UserDB
    │             │                │             │
    │─ click ────▶│                │             │
    │◀─ redirect ─│                │             │
    │──────── authorize ──────────▶│             │
    │◀─────── code ────────────────│             │
    │─ code ─────▶│                │             │
    │             │─ exchange ────▶│             │
    │             │◀─ token+claims │             │
    │             │─ upsert user * ─────────────▶│
    │◀─ session ──│                │             │
```

The win here is showing **what round-trip was added or removed**.

---

## State machine

Anything with a status column. *Example domain: a subscription.*

```
                  ┌──────────┐
       ┌─────────▶│  TRIAL   │
       │          └────┬─────┘
       │               │ card added
   signup              ▼
       │          ┌──────────┐   payment fails   ┌───────────┐
       │          │  ACTIVE  │──────────────────▶│ PAST_DUE *│
       │          └────┬─────┘                   └─────┬─────┘
       │               │ cancel                        │ 3 retries fail *
       │               ▼                               ▼
       │          ┌──────────┐                   ┌───────────┐
       └─────────▶│ CANCELED │◀──────────────────│ SUSPENDED*│
                  └──────────┘   30d grace *     └───────────┘

  * new
```

Always draw the **old** paths too — the reader needs to see what got bolted on.

---

## Entity map

Schema / model changes. *Example domain: a helpdesk.*

```
  Org ──1:N──▶ User ──1:N──▶ Ticket ──N:1──▶ Queue
                │              │
                │              └──1:N──▶ Attachment *
                │                         ├ url *
                │                         └ scannedAt *
                └──1:N──▶ ApiKey *
                          ├ scope
                          └ revokedAt      (LegacyToken x — dropped)
```

Show dropped tables/columns with `x`. That's usually the thing they missed.

---

## Before / after

The strongest shape when behaviour changed but structure didn't.
*Example domain: a search endpoint.*

```
  BEFORE                          AFTER
  ──────                          ─────
  LIKE '%term%' scan      →       inverted index lookup
  O(n) over 2M rows       →       O(log n)
  900ms p95               →       ~12ms p95
  no typo tolerance       →       fuzzy match, edit distance 2 *
```

Two columns, same rows. The reader's eye does the diffing for you.

---

## Number line / curve

For formulas, thresholds, tuning constants. *Example domain: retry backoff.*

```
  wait before retry N, by strategy

   fixed(1s)      █ █ █ █ █             total 5s, all 5 hit at once
   exp(2^n) *     █ ██ ████ ████████    total 31s, spread out *

   attempt        1  2   3    4     5
                  ──────────────────▶ time

   old: gave up after 5 retries / 5s
   new: gives up after 5 retries / 31s *   ← callers must raise their timeout
```

Bars beat numbers. Anchor the old value and the new value, and say what it costs.

---

## Placement

Where code/config/infra moved. *Example domain: extracting a service.*

```
   before                    after
   ┌─────────────┐           ┌─────────────┐
   │  monolith   │           │  monolith   │
   │  ├ web      │           │  ├ web      │
   │  └ imaging ~│  ──────▶  │  └ (calls) ─┼──┐
   └─────────────┘           └─────────────┘  │
                                              ▼
                                       ┌──────────────┐
                                       │ imaging svc *│
                                       └──────────────┘
```

---

## Craft notes

- **Box-drawing chars** (`│ ─ ┌ ┐ └ ┘ ▶ ▼`) not ASCII pipes — they line up.
- **Align columns.** A crooked diagram is worse than no diagram.
- **Label arrows with data**, not function names: `12MB pdf` > `handleUpload()`.
- **Keep it under ~20 lines.** Bigger than that, split or zoom out.
- **The diagram must carry the change.** If you could draw the same picture before
  and after the commit, you drew the wrong thing.
- **Real names, real numbers.** Pull them from the diff. A diagram of `ServiceA →
  ServiceB` is a diagram of nothing.
