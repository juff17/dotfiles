# Types, naming, and module shape

Rules for the names and types a spec introduces, and for how it describes the
shape of new modules. In brownfield work, the repo's existing names and
patterns win; read them first.

## One name per concept

- Each domain concept has exactly one name, used the same way in the database,
  the API, the code, the UI copy where possible, and the spec's prose. A
  concept called `order` in the API and `purchase` in the table will cause
  bugs.
- Casing changes between layers are fine (`cancellation_reason` in SQL,
  `cancellationReason` in JSON). The words don't change.
- Use the word the domain and the existing code already use. A word the user
  used in passing is not a domain term.
- Two concepts that look alike but behave differently get two names (an
  `Invoice` is not a `Bill` if one can be partly paid).

## Glossary section

Every spec has a short glossary of the domain terms it introduces or relies
on. If the repo keeps a `GLOSSARY.md` (or similar), use its terms and list any
new ones the spec adds so they can be copied into it.

```md
## Glossary

**Order**: A customer's request to buy one or more items, from checkout until
it ships or is cancelled.
_Avoid_: Purchase, transaction

**Cancellation reason**: Why an order was cancelled. One of
`customer_request`, `payment_failed`, `out_of_stock`.
```

Rules:
- One or two sentences. Say what it **is**, not what it does.
- Pick one word and list the rejected synonyms under `_Avoid_`.
- Only terms specific to this domain. General programming terms (timeout,
  retry, cache) don't belong.

## Types

| Rule | Example |
|---|---|
| Status and category values are enums with a fixed list, never free strings | `status: pending \| paid \| shipped \| cancelled` |
| A value with several related fields that only make sense together is one object, not loose fields | `refund: { amountMinor, currency, refundedAt }`, not three top-level nullable fields |
| Mutually exclusive shapes use a discriminator field | `{ type: "card", last4 }` or `{ type: "bank", iban }` |
| Units go in the name when the type doesn't carry them | `timeoutMs`, `sizeBytes`, `amountMinor`, `ttlSeconds` |
| Booleans read as yes/no questions | `isActive`, `hasShipped`, `canRefund`. Never `flag`, `status`, or a negative like `notDisabled` |
| A boolean that may need a third state later is an enum now | `visibility: public \| private` instead of `isPublic`, if `unlisted` is likely |
| IDs of different entities are not interchangeable | Name them `orderId`, `customerId`; never a bare `id` in a payload that holds more than one |
| Nullable means "unknown or not applicable", and the spec says which | `cancelledAt: null` means "not cancelled" |
| Lists are never null | An empty list, not `null` |

## Module shape

When the spec adds a module, service, or library (anything with an interface
other code calls), describe its interface, not its internals.

- **Small interface, lots behind it.** A good module hides a lot of behavior
  behind a few operations. If the interface is nearly as large as what it
  does, merge it into its caller or into a neighbor.
- **The deletion test.** If deleting the module would only move its code into
  one caller, it isn't earning its place. If the same logic would reappear in
  several callers, it is.
- **The interface includes more than the signature**: inputs and outputs,
  error cases, ordering rules ("call `open` before `send`"), and performance
  limits. Write these in the spec.
- **Add a seam (an interface with swappable implementations) only when there
  are two implementations today.** Production plus an in-memory version for
  tests counts as two. A seam with one implementation is extra code with no
  use; leave it out until the second one exists.
- **Dependencies by kind:**

  | Dependency | How the spec treats it |
  |---|---|
  | Pure logic, no I/O | Part of the module, tested directly |
  | Local stand-in exists (in-memory DB, temp filesystem) | Part of the module, tested with the stand-in |
  | Our own remote service | An interface at the boundary; HTTP or queue implementation in production, in-memory in tests |
  | Third party (Stripe, Twilio) | An interface at the boundary; translate the third party's errors into our own at that boundary |

## Contract first

- The contract (`openapi.yaml`, an event schema, a shared type) is the single
  source of truth for a boundary. Don't keep the same shape separately in the
  spec's prose, a mock file, and the code.
- **Change the contract before the code.** In stages, the contract change comes
  first, then provider and consumer code.
- A contract describes what callers can observe. Database columns and internal
  classes are not part of it.
- Each side is tested against the same contract (generated types, schema
  validation of real responses, or contract tests). Passing their own tests
  separately isn't enough.
- Don't add contract tooling to a boundary inside one module that always
  changes in one commit. A shared type is enough there.
