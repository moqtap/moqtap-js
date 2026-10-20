/**
 * The tail, sent at `pagehide` by whatever means the page still has.
 *
 * `sendBeacon` caps around 64 KB and is best-effort; the main path is a
 * `fetch()` POST. Not a WebSocket and not `fetch(..., {keepalive: true})` as the
 * primary: a connection per session per tab interacts badly with bfcache and
 * does not survive page unload, which is precisely the case the tail exists for.
 *
 * `sendBeacon` **cannot set request headers at all**, so nothing is sent in
 * one: compression is declared by the body's own 8-byte preamble, and the key
 * and idempotency key ride in the URL ({@link uploadUrl}).
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
  /** The body's declared type. Default {@link UPLOAD_CONTENT_TYPE}. */
  readonly contentType?: string
  /**
   * The ingest credential, sent as `?k=`. Without it the tail is an
   * unauthenticated POST that ingest refuses — invisibly, because `sendBeacon`
   * cannot read a response.
   */
  readonly apiKey?: string
  /**
   * The segment's idempotency key, sent as `?ik=`. It also travels inside the
   * first frame, but the edge cannot reach it there without decompressing.
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

  const contentType = opts?.contentType ?? UPLOAD_CONTENT_TYPE
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
    return send(uploadUrl(endpoint, opts?.apiKey, opts?.idempotencyKey), blob)
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

  try {
    const pending = doFetch(uploadUrl(endpoint, opts?.apiKey, opts?.idempotencyKey), {
      method: 'POST',
      headers: { 'content-type': contentType },
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
 * A CORS-safelisted type. The body's own preamble says what it is, and any
 * other type costs every upload a preflight request.
 */
export const UPLOAD_CONTENT_TYPE = 'text/plain'

/**
 * `?k=…&ik=…`, appended without disturbing a query the endpoint already carries.
 *
 * The key and the idempotency key travel in the URL on every path: a request
 * with no custom header needs no preflight, and `sendBeacon` cannot set one.
 * The key is the public ingest key, so nothing secret reaches a log.
 *
 * String work rather than `new URL()`: this runs at `pagehide`, `resolveConfig`
 * has already validated the endpoint, and a parse that threw here would cost the
 * tail for nothing.
 */
export function uploadUrl(endpoint: string, apiKey?: string, idempotencyKey?: string): string {
  const params: string[] = []
  if (apiKey !== undefined && apiKey !== '') params.push(`k=${encodeURIComponent(apiKey)}`)
  if (idempotencyKey !== undefined && idempotencyKey !== '') {
    params.push(`ik=${encodeURIComponent(idempotencyKey)}`)
  }
  if (params.length === 0) return endpoint
  const sep = endpoint.includes('?') ? '&' : '?'
  return `${endpoint}${sep}${params.join('&')}`
}
