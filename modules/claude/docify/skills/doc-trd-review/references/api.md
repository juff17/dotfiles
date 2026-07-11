# Reviewing APIs

_Load when the TRD defines or materially changes an API contract._

Four principles sit under every point below:

- **Design from the caller's goals inward, not your data model outward.**
- **Make the right thing easy and the wrong thing hard** — safe defaults, shapes that resist misuse.
- **Optimize for change** — you will get things wrong, so make them cheap to evolve.
- **Prefer explicit over implicit** — unambiguous types, clear errors, no magic.

Much of what follows turns on *what already exists*: naming conventions, auth
middleware, error envelopes, a versioning approach. A review comment is only
valid once you've checked the current codebase and confirmed the design breaks
from an established pattern — or that no pattern exists yet. **Verify before you
flag.** A critique resting on a convention you assumed rather than read is noise,
and worse than silence because it erodes trust in the rest of the review.

## Know the consumer

Who calls this — another internal service, a first-party client, a named third
party, or the open public? The blast radius of a mistake scales with the
audience. A public API that others build products on is nearly impossible to
change once shipped, so it earns strict, conservative, explicit design; an
internal service-to-service call can stay lean and evolve alongside its callers.
Settle the consumer first — it sets how strict every choice below has to be.

## Resource & operation modeling

Do the operations map cleanly to their effects? GET is safe, PUT and DELETE
idempotent, POST creates — a design that tunnels everything through POST throws
away semantics that clients, caches, and proxies rely on. Watch for redundant
endpoints (a singular and a plural doing the same job, where the plural could
serve both), and check operation and path naming against the convention the
codebase already uses rather than inventing a parallel one.

## Request & response shape

Are requests and responses predictable and consistent across endpoints? Required
and optional fields labeled correctly, with the right ones actually optional.
Types unambiguous — enums instead of free-form strings, explicit units (ISO-8601
UTC for time, a stated currency for money). And hunt for leaked implementation
detail: database IDs, internal enum values, storage layout. Anything you expose
becomes a contract, and the ones you leak by accident are the ones you most
regret.

## Pagination, filtering & sorting

Should this be paginated? A collection that can grow unbounded needs it; a fixed,
small list makes pagination ceremony without benefit. When callers need to narrow
large responses, prefer filtering, sorting, and field selection over a bespoke
endpoint per query — but don't build query flexibility nobody asked for.

## Versioning & backward compatibility

What's the strategy — URL path, header, or additive-only evolution? Be explicit
about what counts as a breaking change: removing or renaming fields, tightening
validation, changing defaults, reordering — whereas additions are usually safe
when clients ignore unknown fields. And how do you deprecate: sunset headers,
timelines, and actually communicating to consumers. The question behind all of
it: how does this change without breaking the clients already depending on it?

## AuthN / AuthZ

Is every endpoint authenticated and authorized, and does it reuse the auth the
codebase already has — existing middleware, an established guard — rather than a
new bespoke check? Confirm what's in place before recommending anything. Authorization
is per-endpoint, not global: a read and a destructive write on the same resource
rarely deserve the same permission.

## Error schema consistency

Do errors follow the established envelope, and does each status carry the right
meaning — 401 for unauthenticated, 403 for authorized-but-forbidden, 404 vs 403
where you need to hide existence, 409 for conflicts? Right error, right reason,
consistent shape. Check the responses against how the rest of the API already
reports failure before flagging a divergence.

## Scale & access patterns

How often will this endpoint be hit, and what changes as that number climbs?
Caching, rate limits and quotas, payload and connection limits all shift with
volume. Watch for N+1 access patterns and large payloads, and consider whether
the design should encourage batching. Size the critique to the expected load, not
a hypothetical one.

## Additional concerns

- Idempotency keys for safe retries on non-idempotent writes (POST)
- Caching semantics (ETags, `Cache-Control`)
- SLA / uptime expectations (follow from the consumer)
