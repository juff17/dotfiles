# Failure checklist

Check every step against this list. Skip what doesn't apply to the step; don't
list a category just to say it's fine.

## 1. Invalid input

- Is the input rejected **before** any side effect?
- Does the caller get a client error (400/422, a form message, a non-zero exit),
  not a 500 or a generic "something went wrong"?

## 2. Not found, forbidden, or failed precondition mid-path

- Can this check fail **after** earlier steps already wrote something?
- If so, are those writes undone?

## 3. Dependency failure (database, internal service, external API)

- Is there a timeout at all? A call with no timeout hangs the whole path.
- Are 5xx and rate-limit responses handled differently from 4xx?
- **Unknown outcome:** the request was sent, then the call timed out. Did the
  charge, email, or write happen? Is there an idempotency key or a status check,
  or does a retry do it twice?

## 4. Partial writes

- Two or more writes that must succeed together but aren't in one transaction.
- A database write plus a queue message, email, or third-party call, with no
  outbox or compensation. If the second fails, the first is already committed.
- Record what is committed at each step (`committed_so_far`) so this is visible.

## 5. Retries

- Retrying an operation that isn't safe to repeat (creates, charges, sends).
- Retrying a 4xx or validation error that will never succeed.
- No limit on attempts, or no backoff.
- Retries run out silently, with no log, alert, or error to the caller.
- Queue redelivery of a message that was half-processed, with no idempotency
  check.

## 6. Concurrency

- Double submit (two clicks, two identical requests).
- Lost update: read, modify, write without a version check or lock.
- Check then act: the state changes between the check and the action.

## 7. Async work nobody waits for

- A promise not awaited, a goroutine or thread whose error goes nowhere, a
  fire-and-forget task.
- Event handlers and callbacks whose errors are dropped.
- The request returns success before the async work finishes or fails.

## 8. Swallowed errors

- Empty catch, or catch that logs and continues as if nothing happened.
- An error turned into a default value (`?? []`, `or {}`, `return None`) that
  later code treats as real data.
- Optional chaining (`?.`) that silently skips a step that was required.
- An ignored error return (`_ = err`, an unchecked Result).

## 9. Error translation

- A broad catch that turns different failures into one message, losing the
  cause.
- Internal details (stack traces, SQL, secrets) sent to the user.
- An error re-thrown without the original cause attached.

## 10. Cleanup on the failure path

- Locks, file handles, temp files, or transactions left open.
- UI: a spinner that never stops, a button left disabled, an optimistic update
  that is never rolled back.

## 11. What the outside world sees

- The user is shown success while work actually failed.
- An HTTP 200 with an error in the body.
- A job marked done, or a message acked, after it failed.
- A CLI that exits 0 on failure, or leaves partial output files.

## 12. Last-resort handlers

- Where does an unhandled error end up: a global handler, process exit, a
  dead-letter queue?
- Does anyone get alerted, or does it only reach a log nobody reads?

## 13. Leftovers from earlier versions

- Does the PR rename, move, or delete something a previous version created
  (installed files, symlinks, database rows, queue names, cache keys, config
  entries, feature flags)?
- What cleans up the old copies on machines or databases that already have
  them? If nothing does, what happens when old and new exist together?

## 14. Things the code doesn't own

- Does a write, overwrite, or delete hit something another tool or user
  created, because it has the same name or path?
- Is ownership checked before replacing or removing?

## 15. Stuck states

For every status, flag, lock, lease, or "pending" record the path writes:

- List each non-final value it can set (`processing`, `pending`, `locked`,
  `is_syncing = true`).
- What moves it to a final value on success? On failure? On a crash or
  timeout between the two?
- If the path fails after setting it, is there a recovery: a timeout, a retry
  job, a reaper, an expiry (TTL) on the lock?
- What do readers do with that value? A retry that skips "in progress" items,
  a UI that waits for "done", or a job that blocks on the lock will wait
  forever if nothing clears it.
- Can a user or operator see and clear the stuck item, or does it need a
  database edit?

## 16. Timing and ordering

For every point where the path makes something visible to another process
(another request, a worker, a consumer, another service):

- **Visible before committed:** an event published, a cache filled, a webhook
  sent, or a job queued before the database transaction commits. The reader
  sees data that isn't there yet, or that gets rolled back.
- **Invalidated before committed:** a cache cleared before the write commits,
  so a reader refills it with old data.
- **Response before durable:** success returned to the caller while the work
  that matters is still in memory or queued.
- **Out-of-order delivery:** messages or webhooks that can arrive out of order
  or twice, with no sequence number, version, or timestamp check, so an old
  update overwrites a newer one.
- **Callback before record:** a reply, webhook, or event for an item that may
  arrive before the record it refers to is saved.
- **Read after write on a replica:** a read right after a write goes to a
  replica that hasn't caught up.
- **Two workers, one item:** a scheduled job or consumer that can run twice at
  once on the same item, with no claim or lock.

## By entry point type

| Entry point | Also check |
|---|---|
| HTTP endpoint | The status code and response body for each failure |
| UI action | The final screen state after each failure; use `--state` for shared stores |
| Job / queue consumer | Ack or nack on failure, poison messages, what happens on redelivery |
| Webhook | Does it return 2xx before processing? Is a repeated delivery safe? |
| CLI command | Exit code, stderr message, leftover files |
