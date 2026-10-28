/**
 * The idempotency key — `sha256(sessionId + ":" + instanceId + ":" + seq)`.
 *
 * Deterministic and collector-derived, so a retry regenerates the identical key
 * whether it failed on the network or after the page died and a later load
 * swept the stored copy. Ingest dedupes **exactly** on this string, so this one
 * function decides both whether a retry is counted twice and whether a distinct
 * body is silently discarded.
 *
 * `instanceId` is in the input because `sessionId` alone is not unique per
 * stream of bodies: a supplied id is reused across reloads and across tabs, and
 * each of those numbers its own bodies from zero. The instance is minted per
 * `init()`, so two streams can never produce the same key.
 *
 * Synchronous, on the bundled {@link sha256Hex}, so a seal keys its body in the
 * same turn it takes the frames and the key has one form on every origin.
 */

import { MQ2101 } from '../codes.js'
import { sha256Hex } from './sha256.js'

/**
 * `sha256(sessionId:instanceId:seq)`, lowercase hex, 64 characters.
 *
 * The separators are unambiguous: every input ends in `':' + digits`, and the
 * instance id is minted by the collector and never contains a colon, so no
 * triple can produce another triple's string even when the session id holds
 * colons of its own.
 *
 * A non-integer `seq` throws rather than stringifying. `"s:i:NaN"` is a
 * perfectly good hash input and a catastrophic key: every body hitting the bug
 * would share one key, and an exact-dedupe consumer would keep the first and
 * drop the rest.
 */
export function idempotencyKey(sessionId: string, instanceId: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new RangeError(`${MQ2101}: ${String(seq)}`)
  }
  return sha256Hex(`${sessionId}:${instanceId}:${seq}`)
}
