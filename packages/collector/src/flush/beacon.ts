/**
 * The tail, sent at `pagehide` by whatever means the page still has.
 *
 * `sendBeacon` caps around 64 KB and is best-effort; the main path is a
 * `fetch()` POST. Not a WebSocket and not `fetch(..., {keepalive: true})` as the
 * primary: a connection per session per tab interacts badly with bfcache and
 * does not survive page unload, which is precisely the case the tail exists for.
 *
 * `sendBeacon` **cannot set request headers at all**, so two things the envelope
 * puts in headers move into the body: compression is declared by the body's own
 * 8-byte preamble instead of `Content-Encoding: gzip`, and the idempotency key
 * rides in the first frame — the batch record, on both paths — instead of
 * `Idempotency-Key`.
 *
 * `sendBeacon` is also not always there and does not always take it. Four
 * situations, and only the first three are detectable:
 *
 *  1. **It is gone.** Firefox's `beacon.enabled` pref removes it, content
 *     blockers delete it, and some hardened browser modes never had it.
 *  2. **It is stubbed to refuse.** uBlock Origin's `set-constant` scriptlet
 *     bound to `falseFunc` is a one-line filter-list entry.
 *  3. **It genuinely refuses.** The browser's 64 KB keepalive quota is shared
 *     across everything already in flight, so a real `sendBeacon` returns
 *     `false` when something else got there first.
 *  4. **It lies.** Stubbed to return `true` and do nothing, or the request
 *     dropped by a network filter — `sendBeacon` returns `true` either way,
 *     because it reports *queueing* and never delivery. **This is undetectable**
 *     here or anywhere, and no fallback is possible.
 *
 * 1–3 come back as `false`, and a `false` nobody acts on is a **silently lost
 * tail**: `FlushQueue.sealSync` has already emptied the frame writer and
 * deliberately does not persist, so those bytes exist nowhere else — and the
 * tail carries the terminal record, the drop counters and the reason the session
 * ended.
 *
 * So 1–3 fall back to `fetch(..., {keepalive: true})`: the same property the
 * beacon was wanted for, a request allowed to outlive the document that started
 * it, through a different API that a blocker removing one has not necessarily
 * removed. The primary path is unchanged; the fallback runs only where the
 * primary has already failed and the alternative is losing the segment outright.
 */

/** Which mechanism took the body, or `false` if nothing did. */
import { MQ5001 } from '../codes.js'

export type TailOutcome = 'beacon' | 'keepalive' | false

export interface SendTailOptions {
  /**
   * The cap. A beacon over the browser's own limit is refused outright and
   * `sendBeacon` returns false; refusing here means the caller learns it before
   * the page is gone.
   */
  readonly maxBytes?: number
  /**
   * The body's declared type.
   *
   * `application/octet-stream` is honest and is **not** CORS-safelisted, so a
   * cross-origin beacon preflights — and a preflight at `pagehide` may not
   * complete. The mitigation is a long `Access-Control-Max-Age` at ingest, so the
   * preflight the `fetch()` path paid for early in the session is still cached.
   * Overridable so a deployment that has measured its own endpoint can choose
   * `text/plain` and skip the preflight entirely.
   */
  readonly contentType?: string
  /**
   * The ingest credential.
   *
   * Sent as `?k=` on the beacon path, which can carry it nowhere else, and as an
   * `Authorization` header on the fallback, which can. Without it the beacon is
   * an **unauthenticated** POST, and an ingest tier that checks credentials
   * refuses every tail — invisibly, because `sendBeacon` cannot read a response.
   */
  readonly apiKey?: string
  /**
   * The segment's idempotency key.
   *
   * Sent as `?ik=` on the beacon path and as an `Idempotency-Key` header on the
   * fallback, mirroring {@link apiKey} for the same reason: `sendBeacon` cannot
   * set headers. It also travels inside the first frame, but the edge cannot
   * reach it there without decompressing every upload.
   *
   * Not load-bearing here: the tail is fire-and-forget with no retry loop, so it
   * cannot produce the duplicate the key exists to collapse. It matters because
   * the same tail may go by either mechanism, and the edge should not see a key
   * on one and none on the other.
   */
  readonly idempotencyKey?: string
  /** Injected for the suite and for hosts with a different beacon. */
  readonly beacon?: (url: string, data: Blob) => boolean
  /** Injected for the suite. Defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch
  readonly onInternalError?: (err: unknown) => void
}

/** The "caps around 64 KB". */
export const BEACON_MAX_BYTES = 64 * 1024

/**
 * Hand the tail to the platform. Returns which mechanism accepted it for
 * delivery — never whether it arrived, which nothing on this path can know.
 *
 * **Never throws.** A beacon that throws at `pagehide` must not be the last
 * thing the page does.
 */
export function sendTail(endpoint: string, body: Uint8Array, opts?: SendTailOptions): TailOutcome {
  const max = opts?.maxBytes ?? BEACON_MAX_BYTES
  // Not a platform failure, so nothing falls back from it: retrying an oversize
  // body as a fetch would send the bytes the cap exists to withhold.
  if (body.byteLength === 0 || body.byteLength > max) return false

  const contentType = opts?.contentType ?? 'application/octet-stream'
  let blob: Blob
  try {
    blob = new Blob([body as unknown as BlobPart], { type: contentType })
  } catch (err) {
    opts?.onInternalError?.(err)
    return false
  }

  if (tryBeacon(endpoint, blob, opts)) return 'beacon'
  if (tryKeepalive(endpoint, blob, contentType, opts)) return 'keepalive'

  opts?.onInternalError?.(new Error(`${MQ5001}: ${body.byteLength}`))
  return false
}

function tryBeacon(endpoint: string, blob: Blob, opts: SendTailOptions | undefined): boolean {
  const send =
    opts?.beacon ??
    ((url: string, data: Blob): boolean => {
      const nav = (globalThis as { navigator?: Navigator }).navigator
      if (nav === undefined || typeof nav.sendBeacon !== 'function') return false
      return nav.sendBeacon(url, data)
    })
  try {
    return send(beaconUrl(endpoint, opts), blob)
  } catch (err) {
    opts?.onInternalError?.(err)
    return false
  }
}

/**
 * The fallback. Returns whether the request was *started*, which is exactly the
 * standing `sendBeacon`'s `true` has: both mean the platform took it, neither
 * means it arrived.
 */
function tryKeepalive(
  endpoint: string,
  blob: Blob,
  contentType: string,
  opts: SendTailOptions | undefined,
): boolean {
  const doFetch = opts?.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch
  if (typeof doFetch !== 'function') return false

  const headers: Record<string, string> = { 'content-type': contentType }
  if (opts?.apiKey !== undefined && opts.apiKey !== '') {
    headers.authorization = `Bearer ${opts.apiKey}`
  }
  if (opts?.idempotencyKey !== undefined && opts.idempotencyKey !== '') {
    headers['idempotency-key'] = opts.idempotencyKey
  }

  try {
    const pending = doFetch(endpoint, {
      method: 'POST',
      headers,
      body: blob,
      // The one property that makes this a usable substitute for the beacon
      // rather than a request the unload cancels.
      keepalive: true,
      // Nothing at ingest reads a cookie, and sending one would force an ingest
      // host's CORS policy to allow credentials it has no use for.
      credentials: 'omit',
    })
    // Never let it float. The response arrives after the page is gone, if at
    // all, and an unattended rejection surfaces as an unhandled rejection inside
    // somebody else's application.
    void Promise.resolve(pending).then(
      () => undefined,
      (err: unknown) => opts?.onInternalError?.(err),
    )
    return true
  } catch (err) {
    opts?.onInternalError?.(err)
    return false
  }
}

/**
 * `?k=…&ik=…`, appended without disturbing a query the endpoint already carries.
 *
 * Everything the fallback puts in headers goes here instead, because
 * `sendBeacon` has nowhere else to put it.
 *
 * String work rather than `new URL()`: this runs at `pagehide`, `resolveConfig`
 * has already validated the endpoint, and a parse that threw here would cost the
 * tail for nothing.
 */
function beaconUrl(endpoint: string, opts: SendTailOptions | undefined): string {
  const params: string[] = []
  if (opts?.apiKey !== undefined && opts.apiKey !== '') {
    params.push(`k=${encodeURIComponent(opts.apiKey)}`)
  }
  if (opts?.idempotencyKey !== undefined && opts.idempotencyKey !== '') {
    params.push(`ik=${encodeURIComponent(opts.idempotencyKey)}`)
  }
  if (params.length === 0) return endpoint
  const sep = endpoint.includes('?') ? '&' : '?'
  return `${endpoint}${sep}${params.join('&')}`
}
