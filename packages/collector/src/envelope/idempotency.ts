/**
 * The idempotency key — `sha256(sessionId || ":" || segmentSeq)`.
 *
 * Deterministic and collector-derived, so a retry regenerates the identical key
 * whether it failed on the network or after the process died. Ingest dedupes
 * **exactly** on this string, so this one function decides both whether a retry
 * is counted twice and whether a distinct batch is silently discarded.
 *
 * The key is stamped at creation, before persistence — but **`sha256` in a
 * browser is `crypto.subtle.digest`, which is asynchronous, and `crypto.subtle`
 * does not exist at all outside a secure context** (local `http://` development,
 * an internal LAN player, a captive-portal deployment). Hence three functions
 * rather than one, so the caller *knows* which key it got instead of being
 * handed a silent substitution:
 *
 *  - {@link subtleAvailable} — ask first.
 *  - {@link idempotencyKey} — the real thing, async, 64 hex chars. **Rejects**
 *    when `crypto.subtle` is missing; it does not fall back, because a fallback
 *    hidden inside the primary would make `BatchRecord.keyFallback` a guess.
 *  - {@link idempotencyKeySync} — the non-secure-context key, 32 hex chars.
 *
 * The seal path is therefore async (`FlushQueue.seal(): Promise<Chunk | null>`)
 * and stamps `BatchRecord.keyFallback` from `subtleAvailable()`.
 *
 * The two forms differ in length on purpose: 64 hex characters means sha256, 32
 * means the fallback, so ingest can tell them apart **from the key alone**. That
 * matters because the `fetch()` path also sends the key as an `Idempotency-Key`
 * header so ingest can dedupe without decompressing the body, and a header
 * cannot carry `keyFallback`, which lives in the first frame.
 *
 * Not solved here: `sessionId` uniqueness is unconstrained — it may be a
 * customer string. The collector defaults it to `crypto.randomUUID()`, but two
 * tabs, two devices or one customer supplying a constant all produce colliding
 * keys, which an exact-dedupe consumer discards as a retry. That is **silent**
 * data loss, and no hash function can fix it.
 */

import { MQ2101, MQ2102 } from '../codes.js'

const ENCODER = new TextEncoder()

/**
 * `sessionId + ':' + segmentSeq`, with the argument checking both key functions
 * need.
 *
 * The separator is unambiguous for a numeric sequence — every input ends in
 * `':' + digits`, so no `(sessionId, seq)` pair can produce another pair's
 * string even when the id itself contains colons.
 *
 * A non-integer `segmentSeq` throws rather than stringifying. `"s:NaN"` is a
 * perfectly good hash input and a catastrophic key: every chunk hitting the bug
 * would share one key, and an exact-dedupe consumer would keep the first and
 * drop the rest.
 */
function keyInput(sessionId: string, segmentSeq: number): string {
  if (!Number.isSafeInteger(segmentSeq) || segmentSeq < 0) {
    throw new RangeError(`${MQ2101}: ${String(segmentSeq)}`)
  }
  return `${sessionId}:${segmentSeq}`
}

function hex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Whether `crypto.subtle.digest` exists here.
 *
 * False on an insecure origin, where `crypto` is present and `crypto.subtle` is
 * `undefined` — which is why this tests the method and not the namespace.
 */
export function subtleAvailable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto?.subtle?.digest === 'function'
}

/**
 * `sha256(sessionId + ':' + segmentSeq)`, lowercase hex, 64 characters.
 *
 * Rejects when {@link subtleAvailable} is false — check first and use
 * {@link idempotencyKeySync}, setting `BatchRecord.keyFallback`.
 *
 * The returned key is written down **with** the chunk before it is persisted and
 * reused verbatim on every retry. A chunk keyed at upload time gets a fresh key
 * after a reload and is counted twice; a chunk re-keyed on a page where
 * `crypto.subtle` is now available changes form mid-retry and defeats dedupe
 * just as thoroughly.
 */
export async function idempotencyKey(sessionId: string, segmentSeq: number): Promise<string> {
  const input = keyInput(sessionId, segmentSeq)
  if (!subtleAvailable()) {
    throw new Error(MQ2102)
  }
  const digest = await crypto.subtle.digest('SHA-256', ENCODER.encode(input))
  return hex(new Uint8Array(digest))
}

/** FNV-1a 128-bit offset basis. */
const FNV_OFFSET_BASIS = 0x6c62272e07bb014262b821756295c58dn
/** FNV-1a 128-bit prime, `2^88 + 2^8 + 0x3b`. */
const FNV_PRIME = 0x0000000001000000000000000000013bn
const MASK_128 = (1n << 128n) - 1n

/**
 * The non-secure-context key: FNV-1a, 128-bit, lowercase hex, 32 characters.
 *
 * **Not sha256 and not a substitute for it.** A *distinctness* function, not a
 * commitment: deterministic, separating every `(sessionId, segmentSeq)` pair the
 * collector will generate, and a published algorithm anyone can reimplement to
 * check a key — with none of sha256's collision resistance and visibly poor
 * avalanche (`sess-1:0` and `sess-1:1` differ in four of thirty-two nibbles, all
 * but one in the last three). Ingest is told which form it has, both by
 * `BatchRecord.keyFallback` and by the length.
 *
 * A hand-rolled sha256 was rejected rather than overlooked: ~1 KB of bundle on a
 * path that runs only on insecure origins, and it would produce a key
 * *indistinguishable* from the real one — the property that actually matters,
 * since an attacker who can choose `sessionId` is a customer corrupting their
 * own data and no hash prevents that.
 */
export function idempotencyKeySync(sessionId: string, segmentSeq: number): string {
  const bytes = ENCODER.encode(keyInput(sessionId, segmentSeq))
  let h = FNV_OFFSET_BASIS
  for (const b of bytes) {
    h = (h ^ BigInt(b)) * FNV_PRIME
    h &= MASK_128
  }
  return h.toString(16).padStart(32, '0')
}
