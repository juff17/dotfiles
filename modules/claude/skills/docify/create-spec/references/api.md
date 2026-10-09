# API design

Rules for the endpoints in a spec and the `openapi.yaml` that defines them.
**In brownfield work, the existing API's conventions win over every default
below.** Read a few existing endpoints and their OpenAPI (if any) first, and
match their paths, casing, error shape, pagination, and auth.

## How many endpoints

**Prefer fewer endpoints.** Each endpoint adds routing, auth checks, docs,
tests, client code, and monitoring. Design around what each screen or caller
needs, not around database tables.

Combine into one endpoint when:
- one screen or caller needs the data together, e.g. a page that polls the
  status of several things gets one `GET /v1/dashboards/{id}/status` that
  returns all of them, not one poll per item;
- the combined response stays small (a rough guide: a few KB, no unbounded
  lists);
- the parts share the same auth, cache policy, and freshness needs.

Split into separate endpoints when the parts differ in:

| Differs in | Example |
|---|---|
| Payload size | A large or unbounded list next to small status fields. Page the list separately |
| Cache policy | Static reference data next to live status |
| Auth or permissions | Admin-only fields next to user fields |
| Rate limits or cost | An expensive search next to a cheap read |
| Callers | A public client and an internal service need different shapes |
| Change rate | One part is stable, the other changes every release |

When polling, also state the interval and the load it adds at the estimated
scale (see [`context.md`](context.md)). Consider server-sent events or
webhooks only when polling load or latency is a stated problem.

## Extend or create

- **Additive change** (a new optional request field, a new response field) to
  an existing endpoint → extend it.
- **Transformative change** that alters what an established, widely used
  endpoint does → create a new endpoint (or a new version) and leave the old
  behavior intact.
- **Unrelated to existing endpoints** → create a new one.
- Never change the meaning of an existing field. Add a new field instead and
  deprecate the old one.

## Naming and shape

Defaults for greenfield. Brownfield follows the repo.

| Topic | Default |
|---|---|
| Paths | Plural nouns, lowercase, kebab-case: `/v1/purchase-orders/{id}` |
| Nesting | At most one level: `/v1/orders/{id}/items`. Deeper → top-level resource with a filter |
| Actions | When an operation isn't create, read, update, or delete, use a verb sub-path: `POST /v1/orders/{id}/cancel` |
| Fields | One casing for the whole API (camelCase unless the repo uses snake_case). Same name as the glossary term (see [`types-naming.md`](types-naming.md)) |
| IDs | Strings in the contract, even if the database uses integers |
| Times | ISO 8601 UTC strings, field names ending in `At` (`createdAt`) |
| Money | Integer minor units plus a currency code, never floats |
| Enums | Listed in the schema with every allowed value; consumers must handle unknown values |
| Responses | Shaped for the caller's task, not a copy of a database row |

## Status codes and errors

- `200` read or update, `201` create (with a `Location` header), `202` accepted
  for async work, `204` no body.
- `400` malformed, `401` not authenticated, `403` not allowed, `404` not found,
  `409` conflict or invalid state change, `422` validation failed, `429` rate
  limited.
- One error shape for the whole API. Default (RFC 9457 problem details):
  `type`, `title`, `status`, `detail`, plus `errors[]` with `field` and
  `message` for validation. Brownfield uses the existing shape.
- Document every error a caller must handle differently. A state-change
  endpoint lists the `409` cases (e.g. "order already shipped").

## Pagination

- Any list that can grow without bound is paginated from day one. Adding
  pagination later is a breaking change.
- Cursor-based (`cursor`, `limit`, response `nextCursor`) for feeds and large
  or fast-changing tables. Offset (`page`, `pageSize`, `total`) only for small
  admin lists where jumping to a page matters.
- State the default and maximum `limit`.

## Idempotency

- Any `POST` that creates something a retry could duplicate (orders, payments,
  charges, messages sent to users) accepts an `Idempotency-Key` header. Same
  key and same body → the original response; same key and different body →
  `422`.
- State how long keys are kept.
- `PUT` and `DELETE` must be idempotent by design.

## Versioning

- Follow the repo's existing scheme. Greenfield default: a major version in
  the path (`/v1/`).
- Additive changes don't bump the version. Breaking changes (removing or
  renaming a field, changing a type or meaning, adding a required request
  field) need a new version or a deprecation period. Say which in the spec.

## The openapi.yaml file

- OpenAPI **3.1**. Contains every new or changed endpoint in this spec. In
  brownfield work, if the repo already has an OpenAPI document, the spec's
  file shows only the additions and changes, and the stages include updating
  the repo's document.
- Shared shapes go in `components/schemas` and are referenced with `$ref`.
  Errors use one shared schema.
- Every schema lists `required` fields, nullability (`type: [string, "null"]`),
  enum values, and string formats (`uuid`, `date-time`, `email`).
- Every operation has an `operationId` (camelCase verb + noun, e.g.
  `cancelOrder`), a one-line `summary`, its security requirement, and every
  documented response code.
- Add an `example` for any field whose format isn't obvious.
- Use a `description` for behavior a reader would question (e.g. why one
  polling endpoint returns several resources).
- **Lint it** if a linter is available: `npx @redocly/cli lint openapi.yaml`
  or `npx @stoplight/spectral-cli lint openapi.yaml`. Fix errors; mention
  warnings you chose to keep. If neither runs, say the file is unlinted.

## In the spec body

List endpoints in a table and link to the file. Don't repeat schemas.

| Endpoint | Purpose | New / changed |
|---|---|---|
| `GET /v1/dashboards/{id}/status` | All live statuses for one dashboard, polled every 10s | New |
| `POST /v1/orders/{id}/cancel` | Cancel an order that hasn't shipped | New |
| `GET /v1/orders/{id}` | Adds `cancellationReason` | Changed (additive) |

Full contract: [openapi.yaml](openapi.yaml).
