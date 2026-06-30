# Section examples

Worked examples for the format-heavy parts of the output. The api-investigator and domain-investigator should read this before producing their primary outputs.

The point of these examples is calibration: how much shape detail is enough, what counts as a *why*, when to flag inconsistency. Your output for a real repo won't look identical — these are templates and anti-templates, not boilerplate to copy.

---

## Endpoints — Common response patterns

### Good

```
- All resource responses include an `id` (UUID v4) at the top level.
- List endpoints use cursor pagination: `{ items: T[], next_cursor: string | null }`.
- Errors use the envelope `{ error: { code: string, message: string, details?: object } }` with HTTP status set appropriately.
- Timestamps are ISO 8601 strings in UTC.
- Boolean flags use `is_*` / `has_*` naming (e.g., `is_active`, `has_pending_changes`).
```

Why it's good: each bullet is a pattern the reader will see across most endpoints. No schema dumps. The reader now knows what to expect when they open Swagger.

### Anti-example

```
- POST /users returns:
  {
    id: string,
    email: string,
    name: string,
    created_at: string,
    updated_at: string,
    is_active: boolean,
    role: "admin" | "user" | "guest",
    profile: {
      avatar_url: string | null,
      bio: string | null,
      timezone: string
    }
  }
- GET /users/:id returns the same shape as above.
- PATCH /users/:id returns the same shape.
- DELETE /users/:id returns 204 with no body.
... (continues for every endpoint)
```

Why it's bad: that's Swagger's job. The reader can read Swagger themselves. The wiki should say "all user endpoints return the same `User` shape — see Swagger" and move on.

---

## Endpoints — Notable endpoints

### Good

```
**`POST /search`** — Returns `{ results: Result[], facets: Facet[], cursor: string | null }`. Each `Result` includes a `score` populated by the custom ranker (see Notable workflows → Search ranking). The `facets` array is computed lazily and may be omitted on follow-up paginated calls when `cursor` is set. [search_handler.py:88](../../api/search_handler.py#L88)

**`POST /threads/:id/messages`** — Accepts a message and streams the assistant response back as Server-Sent Events. The first event is `{ type: "metadata", message_id }`; subsequent events are `{ type: "token", text }`; the final event is `{ type: "done", usage }`. Returns 202 immediately, *not* 200, because the response continues over the open connection. [threads.ts:142](../../api/threads.ts#L142)
```

Why these are good:
- They tell you the response shape at a level Swagger usually misses (custom fields, when fields are present/absent, streaming protocol).
- They flag the non-obvious bits: "facets may be omitted", "returns 202 not 200".
- They link to the handler so the reader can read the code.

### Anti-examples

**Too generic:**
```
**`POST /users`** — Creates a user. [users.py:42](../../api/users.py#L42)
```
Useless. If it's standard CRUD, it doesn't belong in Notable endpoints. Just put it in the table.

**Too detailed:**
```
**`POST /search`** — First, the handler validates the input against `SearchRequestSchema`. Then it calls `auth_service.check_permission(user, "search:read")`. Then it builds a query plan via `QueryPlanner.plan(...)`. The planner has three stages: (1) tokenization, (2) field weighting, (3) filter compilation. Once the plan is built, it's passed to `SearchExecutor.execute(plan)` which... [continues for 500 words]
```
Too detailed. The reader will read the code. Tell them the response shape, the non-obvious bits, and a file:line link.

---

## Notable workflows entries

### Good

```
**Search result ranking** — Search results are ranked by a blended score combining BM25 relevance, recency decay, and per-user personalization weight. The blend coefficients are tuned per query intent (informational vs. navigational vs. transactional). Comment in code: *"the recency weight has to dominate for `news`-intent queries because BM25 alone surfaces too many old high-relevance docs"*. [ranker.py:64](../../services/search/ranker.py#L64)

**LLM response post-processing** — Raw model output is passed through `clean_and_split` before storage: it strips chain-of-thought blocks, splits multi-part answers into separate `Message` rows, and re-attaches citations from the retrieval step by string-matching the snippet. Comment: *"we can't just store the raw response because the UI renders citations inline and we need them as structured FK refs"*. [llm/postprocess.py:31](../../llm/postprocess.py#L31)
```

Why these are good:
- Title is short and descriptive.
- 1–3 sentences on *what* it does.
- A *why* — explicitly. Quoted comment if one captures it.
- file:line link to the core code.
- The reader knows whether they care, and where to go if they do.

### Anti-examples

**Missing the why:**
```
**Search result ranking** — Ranks search results using BM25, recency, and personalization. [ranker.py:64](../../services/search/ranker.py#L64)
```
The *what* is fine but the reader doesn't know whether this is interesting. Why a custom blend? Why per-intent? Without the *why*, this could just be a table-of-contents entry.

**Too generic:**
```
**User creation** — Creates a user when they sign up. [users.py:88](../../services/users.py#L88)
```
Standard logic. Doesn't belong in Notable workflows. The reader will assume `POST /users` does what the name says.

**Algorithm walkthrough:**
```
**Search result ranking** — First, the BM25 score is computed by tokenizing the query, applying field-level weights (title: 3.0, body: 1.0, tags: 1.5), and summing TF-IDF contributions. Then the recency decay function `exp(-age_days / half_life)` is applied with a half-life of 30 days for transactional queries and 180 days for informational queries. The personalization weight is computed by... [continues for 800 words]
```
The reader will read the code. The wiki tells them *that* there's interesting blended ranking and *why* (per-intent tuning), then links them to the file.

---

## Conventions callouts

### Good

```
- Resource responses include an `id` field at the top level.
- Errors use `{ error: { code, message } }`.
- Mutations return the full updated resource, not just an id.
- Background work goes through the BullMQ queue defined in `lib/queues.ts`.
- All timestamps are stored and returned as UTC.
```

Why it's good: each line is a pattern that holds across most of the codebase. No exceptions catalog, no rationale.

### Flagging inconsistency

```
- Error envelope is `{ error: { code, message } }` in `api/v2/*` but `{ error: string }` in legacy `api/v1/*` routes — inconsistent across versions.
```

Why this is the right way to flag inconsistency: one line acknowledges the split. Don't list every v1 endpoint that uses the old format — the reader will see it when they open the file.

### Anti-example

```
- Resource responses include an `id` field, except in:
  - GET /metrics/summary (returns aggregates, no id)
  - GET /health (returns { status })
  - POST /webhooks/stripe (returns 200 with empty body)
  - PATCH /users/:id/preferences (returns just the patched fields)
  ... (continues with every exception)
```

Why it's bad: the reader doesn't need to know every exception to understand the convention. The convention is "responses include `id`". The exceptions are obvious from context (you don't expect an `id` on `/health`). If the exceptions are pervasive enough to matter, flag inconsistency once and stop.

---

## Queues — Notable handlers

### Good

```
**`checkout-saga` (BullMQ)** — Orchestrates the checkout flow as a saga: reserves inventory, charges the card, fulfills the order, and emits the `OrderConfirmed` event. Each step is its own job; on failure the saga enqueues a compensating job (release reservation, refund). Custom backoff: 30s, 2m, 10m. DLQ wired to `checkout-saga-dlq`. Comment: *"linear retry isn't safe here — a stuck payment must wait long enough for the bank's idempotency window to clear, otherwise the compensating refund double-fires"*. [workers/checkout.ts:48](../../workers/checkout.ts#L48)

**`webhook-fanout` (Celery)** — Receives one inbound webhook event and fans out to N subscriber-specific delivery jobs, each running with its own retry policy keyed off the subscriber's `failure_streak`. Subscribers in cooldown are skipped, not retried. [workers/webhooks.py:112](../../workers/webhooks.py#L112)
```

Why these are good:
- Title names the handler and its broker.
- 1–3 sentences on *what* it does at the orchestration level — not a line-by-line walkthrough.
- Reliability mechanics surfaced: custom backoff, DLQ, per-subscriber retry policy.
- A *why* — quoted comment for the saga's backoff choice, explicit rationale for the fan-out.
- file:line link to the handler.

### Anti-examples

**Too generic:**
```
**`send-welcome-email`** — Sends a welcome email to a new user. [workers/email.ts:12](../../workers/email.ts#L12)
```
That's a "do one thing" handler. It belongs in the inventory table, not in Notable handlers. The reader will assume `send-welcome-email` sends a welcome email.

**Defaults dressed up as notable:**
```
**`generate-report`** — Runs with BullMQ's default retry policy (3 attempts, exponential backoff) and writes failures to a DLQ. [workers/reports.ts:30](../../workers/reports.ts#L30)
```
That's the library default. Anyone familiar with BullMQ already knows. Save Notable handlers for handlers whose mechanics are *custom* or whose orchestration shape is *non-trivial*.

**Algorithm walkthrough:**
```
**`checkout-saga`** — First, the handler calls `InventoryService.reserve(items)` with an idempotency key derived from `order_id`. If reservation succeeds, it calls `PaymentService.charge(amount, currency)` with the Stripe idempotency header set to `order_id + ":charge"`. If the charge succeeds, it calls `FulfillmentService.create(order)` and then... [continues for 600 words]
```
The reader will read the code. The wiki tells them *that* it's a saga, *how* it compensates, *why* the backoff is custom, then links them to the file.
