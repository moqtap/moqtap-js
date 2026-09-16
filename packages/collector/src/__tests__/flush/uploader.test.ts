/**
 * Delivery — one `fetch()` path with no streaming bodies, the `sendBeacon`
 * tail, and the four-timestamp clock handshake.
 *
 * What these pin down:
 *
 *  - **One request shape**, with the beacon carrying only the tail: two upload
 *    paths mean two backpressure behaviours inside someone else's player, and
 *    the divergent one produces Safari-only bug reports we cannot reproduce.
 *  - **Never throwing into the caller.** Network failure, CORS refusal, a
 *    hostile response, a thrown `sendBeacon` — all of it comes back as a value.
 *  - **A 4xx is terminal and counted**, except the three codes that carry a
 *    retry by definition; retrying a body ingest refuses forever is a spin.
 *  - **The offset is pinned from the lowest round trip**, not the mean, because
 *    queueing delay is one-sided and unbounded above.
 *  - **`Idempotency-Key` travels in the header AND the first frame.** The header
 *    lets ingest dedupe without decompressing; the frame is what survives the
 *    beacon path, which can set no headers at all.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Chunk } from '../../flush/index.js'
import { ClockSync, RECV_HEADER, SEND_HEADER, sendTail, Uploader } from '../../flush/index.js'
import type { ClockSource } from '../../types.js'

/* ── helpers ─────────────────────────────────────────────────────────────── */

const chunk = (seq = 0, bytes = new Uint8Array([1, 2, 3, 4])): Chunk => ({
  sessionId: 's1',
  segmentSeq: seq,
  idempotencyKey: `key-${seq}`,
  createdWallMs: 1_700_000_000_000,
  bytes,
  level: 'baseline',
  attempts: 0,
})

interface Call {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

interface FakeFetch {
  readonly impl: typeof fetch
  readonly calls: Call[]
}

/** A fetch that replays a scripted list of responses, recording what it was given. */
const scripted = (responses: (Response | Error)[]): FakeFetch => {
  const calls: Call[] = []
  const impl = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v
    }
    calls.push({ url: String(input), headers, body: init?.body })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]
    if (next instanceof Error) return Promise.reject(next)
    return Promise.resolve((next as Response).clone())
  }) as typeof fetch
  return { impl, calls }
}

const ok = (headers: Record<string, string> = {}): Response =>
  new Response(null, { status: 200, headers })

const status = (code: number, headers: Record<string, string> = {}): Response =>
  new Response(null, { status: code, headers })

const wallClock = (values: number[]): ClockSource => ({
  now: () => 0,
  wall: () => values.shift() ?? 0,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const uploaderWith = (
  fetchImpl: typeof fetch,
  over?: Partial<ConstructorParameters<typeof Uploader>[0]>,
): Uploader =>
  new Uploader({
    endpoint: 'https://ingest.example/v1/ingest',
    apiKey: 'k-123',
    fetchImpl,
    sleep: () => Promise.resolve(),
    backoffMs: () => 1,
    onInternalError: () => {},
    ...over,
  })

/* ── the request ─────────────────────────────────────────────────────────── */

describe('Uploader.send, the request', () => {
  it('POSTs the body with the key in a header and declares no Content-Encoding', async () => {
    const f = scripted([ok()])
    const out = await uploaderWith(f.impl).send(chunk(7))

    expect(out).toMatchObject({ ok: true, status: 200, terminal: false })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]?.url).toBe('https://ingest.example/v1/ingest')
    expect(f.calls[0]?.headers['idempotency-key']).toBe('key-7')
    expect(f.calls[0]?.headers.authorization).toBe('Bearer k-123')
    expect(f.calls[0]?.headers['content-type']).toBe('application/octet-stream')
    // gzip is announced by the body's own preamble, because sendBeacon cannot
    // set a header and both paths must produce one readable shape.
    expect(f.calls[0]?.headers['content-encoding']).toBeUndefined()
  })

  it('sends the sealed bytes verbatim, so a retry after a reload is byte-identical', async () => {
    const f = scripted([ok()])
    const c = chunk(0, new Uint8Array([9, 8, 7]))
    await uploaderWith(f.impl).send(c)
    expect(f.calls[0]?.body).toBe(c.bytes)
  })

  it('carries caller-supplied headers alongside its own', async () => {
    const f = scripted([ok()])
    await uploaderWith(f.impl, { headers: { 'x-moqtap-release': '1.2.3' } }).send(chunk())
    expect(f.calls[0]?.headers['x-moqtap-release']).toBe('1.2.3')
  })

  it('counts an attempt on the chunk itself, which is what bounds an eternal requeue', async () => {
    const f = scripted([ok()])
    const c = chunk()
    await uploaderWith(f.impl).send(c)
    expect(c.attempts).toBe(1)
  })
})

/* ── failure ─────────────────────────────────────────────────────────────── */

describe('Uploader.send, failure', () => {
  it('retries a 5xx and succeeds', async () => {
    const f = scripted([status(503), ok()])
    const u = uploaderWith(f.impl)
    const c = chunk()

    expect(await u.send(c)).toMatchObject({ ok: true, status: 200 })
    expect(f.calls).toHaveLength(2)
    expect(u.retries).toBe(1)
    expect(c.attempts).toBe(2)
  })

  it('treats an ordinary 4xx as terminal: ingest will refuse that body forever', async () => {
    const f = scripted([status(400)])
    const u = uploaderWith(f.impl)

    expect(await u.send(chunk())).toEqual({ ok: false, status: 400, terminal: true })
    expect(f.calls).toHaveLength(1)
    expect(u.terminalDrops).toBe(1)
  })

  it('retries the three 4xx codes that carry a retry by definition', async () => {
    for (const code of [408, 425, 429]) {
      const f = scripted([status(code), ok()])
      expect(await uploaderWith(f.impl).send(chunk())).toMatchObject({ ok: true })
      expect(f.calls).toHaveLength(2)
    }
  })

  it('waits as long as the server asked, because the server is the one under load', async () => {
    const slept: number[] = []
    const sleep = (ms: number): Promise<void> => {
      slept.push(ms)
      return Promise.resolve()
    }
    const f = scripted([status(429, { 'retry-after': '2' }), ok()])
    await uploaderWith(f.impl, { sleep }).send(chunk())
    expect(slept).toEqual([2_000])
  })

  it('never throws when fetch itself rejects, and keeps the chunk retryable', async () => {
    const f = scripted([new Error('Failed to fetch')])
    const u = uploaderWith(f.impl, { maxAttempts: 2 })

    const out = await u.send(chunk())
    expect(out).toEqual({ ok: false, terminal: false })
    expect(f.calls).toHaveLength(2)
  })

  it('gives up after maxAttempts and reports the last status without dropping the chunk', async () => {
    const f = scripted([status(500)])
    const out = await uploaderWith(f.impl, { maxAttempts: 3 }).send(chunk())

    expect(f.calls).toHaveLength(3)
    expect(out).toEqual({ ok: false, status: 500, terminal: false })
  })

  it('reports a non-terminal failure when the environment has no fetch at all', async () => {
    vi.stubGlobal('fetch', undefined)
    const u = new Uploader({ endpoint: 'https://ingest.example', apiKey: 'k' })
    const c = chunk()
    // Persistence is what makes "keep it" survivable, so this must not be
    // reported as terminal.
    expect(await u.send(c)).toEqual({ ok: false, terminal: false })
    expect(c.attempts).toBe(0)
  })
})

/* ── the clock handshake ────────────────────────────────────── */

describe('Uploader, the clock handshake', () => {
  it('pins the offset from the lowest round trip, not from the mean', async () => {
    const f = scripted([
      ok({ [RECV_HEADER]: '1200', [SEND_HEADER]: '1210' }),
      ok({ [RECV_HEADER]: '2050', [SEND_HEADER]: '2055' }),
      ok({ [RECV_HEADER]: '3500', [SEND_HEADER]: '3510' }),
    ])
    const u = uploaderWith(f.impl, {
      clock: wallClock([1_000, 1_400, 2_000, 2_100, 3_000, 4_000]),
      clockSamples: 3,
    })

    await u.send(chunk(0))
    expect(u.clockOffsetMs).toBe(5)
    await u.send(chunk(1))
    // rtt 95 beats rtt 390, so this sample wins.
    expect(u.clockOffsetMs).toBe(2.5)
    expect(u.clockRttMs).toBe(95)
    await u.send(chunk(2))
    // rtt 990 loses; the pinned offset does not move.
    expect(u.clockOffsetMs).toBe(2.5)
  })

  it('stops sampling once it has enough, and still reports the server clock', async () => {
    const f = scripted([
      ok({ [RECV_HEADER]: '1200', [SEND_HEADER]: '1210' }),
      ok({ [RECV_HEADER]: '5001', [SEND_HEADER]: '5002' }),
    ])
    const u = uploaderWith(f.impl, {
      clock: wallClock([1_000, 1_400, 5_000, 5_003]),
      clockSamples: 1,
    })

    await u.send(chunk(0))
    expect(u.clockOffsetMs).toBe(5)
    const second = await u.send(chunk(1))
    // A better sample arrives, but sampling is closed: the offset holds.
    expect(u.clockOffsetMs).toBe(5)
    expect(second.serverWallMs).toBe(5_002)
  })

  it('falls back to the Date header when the edge sends no timestamps of its own', async () => {
    const serverWall = Date.parse('Sat, 05 Sep 2026 12:00:00 GMT')
    const f = scripted([ok({ date: 'Sat, 05 Sep 2026 12:00:00 GMT' })])
    const u = uploaderWith(f.impl, { clock: wallClock([serverWall - 50, serverWall + 50]) })

    const out = await u.send(chunk())
    expect(out.serverWallMs).toBe(serverWall)
    expect(u.clockOffsetMs).toBe(0)
    expect(u.clockRttMs).toBe(100)
  })

  it('reports no offset when the response carries no usable timestamp', async () => {
    const f = scripted([ok()])
    const u = uploaderWith(f.impl)
    const out = await u.send(chunk())
    expect(out.serverWallMs).toBeUndefined()
    expect(u.clockOffsetMs).toBeUndefined()
  })
})

describe('ClockSync', () => {
  it('computes the four-timestamp offset and delay', () => {
    const s = new ClockSync()
    s.sample(1_000, 1_200, 1_210, 1_400)
    expect(s.offsetMs).toBe(5)
    expect(s.bestRttMs).toBe(390)
    expect(s.samples).toBe(1)
  })

  it('keeps the lowest-delay sample, because queueing delay is one-sided', () => {
    const s = new ClockSync()
    s.sample(0, 500, 510, 1_000)
    s.sample(0, 40, 45, 100)
    s.sample(0, 900, 910, 2_000)
    expect(s.bestRttMs).toBe(95)
    expect(s.offsetMs).toBe(-7.5)
    expect(s.samples).toBe(3)
  })

  it('ignores an impossible exchange rather than pinning a fiction', () => {
    const s = new ClockSync()
    // Negative round trip: one of the two clocks stepped mid-exchange.
    s.sample(0, 0, 100, 50)
    s.sample(Number.NaN, 1, 2, 3)
    s.sample(0, 1, 2, Number.POSITIVE_INFINITY)
    expect(s.offsetMs).toBeUndefined()
    expect(s.samples).toBe(0)
  })
})

/* ── the tail beacon ─────────────────────────────────────────── */

/**
 * Run `fn` with no platform `fetch`, so "no mechanism is available" is actually
 * reproduced. Node supplies a global `fetch`, and without removing it the
 * keepalive fallback always succeeds — which would make the assertions below
 * pass while testing the opposite of what they say.
 */
function withoutGlobalFetch<T>(fn: () => T): T {
  const g = globalThis as { fetch?: typeof fetch | undefined }
  const saved = g.fetch
  g.fetch = undefined
  try {
    return fn()
  } finally {
    g.fetch = saved
  }
}

describe('sendTail', () => {
  it('hands the body to the platform and reports what the browser said', async () => {
    const seen: { url: string; blob: Blob }[] = []
    const body = new Uint8Array([1, 2, 3])
    const accepted = sendTail('https://ingest.example/v1/ingest?k=abc', body, {
      beacon: (url, blob) => {
        seen.push({ url, blob })
        return true
      },
    })

    expect(accepted).toBe('beacon')
    expect(seen[0]?.url).toBe('https://ingest.example/v1/ingest?k=abc')
    expect(seen[0]?.blob.type).toBe('application/octet-stream')
    expect(new Uint8Array((await seen[0]?.blob.arrayBuffer()) as ArrayBuffer)).toEqual(body)
  })

  it('reports the browser refusing it, rather than pretending the tail went', () => {
    // With no fallback reachable either. A refusal that *can* be retried is
    // escalated to a keepalive fetch — see the describe below.
    const sent = withoutGlobalFetch(() =>
      sendTail('https://ingest.example', new Uint8Array([1]), { beacon: () => false }),
    )
    expect(sent).toBe(false)
  })

  it('refuses an empty body and one over the 64 KB cap', () => {
    let called = 0
    const beacon = (): boolean => {
      called += 1
      return true
    }
    expect(sendTail('https://x', new Uint8Array(0), { beacon })).toBe(false)
    expect(sendTail('https://x', new Uint8Array(64 * 1024 + 1), { beacon })).toBe(false)
    expect(sendTail('https://x', new Uint8Array(64 * 1024), { beacon })).toBe('beacon')
    expect(called).toBe(1)
  })

  it('honours a caller-chosen content type, which is how a deployment skips the preflight', () => {
    let type = ''
    sendTail('https://x', new Uint8Array([1]), {
      contentType: 'text/plain;charset=UTF-8',
      beacon: (_url, blob) => {
        type = blob.type
        return true
      },
    })
    // `Blob` lower-cases the type it was handed; the parameter survives.
    expect(type).toBe('text/plain;charset=utf-8')
  })

  it('never throws at pagehide, whatever the platform does', () => {
    const errors: unknown[] = []
    const sent = withoutGlobalFetch(() =>
      sendTail('https://x', new Uint8Array([1]), {
        beacon: () => {
          throw new Error('TypeError: Illegal invocation')
        },
        onInternalError: (e) => errors.push(e),
      }),
    )
    expect(sent).toBe(false)
    // The throw, and the "nothing took it" report that follows it.
    expect(errors).toHaveLength(2)
  })

  it('returns false where the platform offers neither mechanism', () => {
    expect(withoutGlobalFetch(() => sendTail('https://x', new Uint8Array([1])))).toBe(false)
  })
})

/* ── the upload has a deadline ───────────────────────────────────────────── */

/**
 * `CollectorRuntime.stop()` awaits the drain, which awaits `send`: without an
 * `AbortSignal` and a request timeout on the `fetch`, a blackholed socket leaves
 * the promise `stop()` handed the page unresolved forever. The end-to-end
 * assertion lives in `../harness/non-interference.test.ts`; these are the
 * unit-level obligations that make it hold, and the one easiest to get wrong is
 * the last: **a deadline that expires must be transient, never terminal.** A
 * terminal outcome tells the caller to delete the chunk, so getting that
 * backwards turns a slow endpoint into silent data loss.
 */
describe('Uploader.send, deadlines', () => {
  /** A fetch that answers nobody — the blackhole, without the socket. */
  const blackhole = (): FakeFetch => {
    const calls: Call[] = []
    const impl = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), headers: {}, body: init?.body })
      return new Promise<Response>((_resolve, reject) => {
        const s = init?.signal
        // No signal means no way out, which is precisely the bug: the test
        // hangs rather than passing quietly.
        if (s == null) return
        if (s.aborted) {
          reject(new Error('aborted'))
          return
        }
        s.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }) as typeof fetch
    return { impl, calls }
  }

  it('abandons a request that is never answered, and retries it', async () => {
    const f = blackhole()
    const u = uploaderWith(f.impl, { timeoutMs: 20, maxAttempts: 3 })
    const c = chunk()

    const out = await u.send(c)

    expect(f.calls).toHaveLength(3)
    expect(c.attempts).toBe(3)
    // Transient, so the store keeps the chunk. A terminal outcome here would delete
    // a body ingest never even looked at.
    expect(out).toEqual({ ok: false, terminal: false })
    expect(u.terminalDrops).toBe(0)
  })

  it("stops before the first request when the caller's deadline has already gone", async () => {
    const f = blackhole()
    const ctl = new AbortController()
    ctl.abort()

    const out = await uploaderWith(f.impl, { timeoutMs: 60_000 }).send(chunk(), ctl.signal)

    // Not one request. A `stop()` that has run out of time must not open a
    // connection it cannot wait for.
    expect(f.calls).toHaveLength(0)
    expect(out).toEqual({ ok: false, terminal: false })
  })

  it("ends the retry loop when the caller's deadline expires mid-flight", async () => {
    const f = blackhole()
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 30)

    const out = await uploaderWith(f.impl, {
      // Each request would wait a minute; the caller's deadline is what ends it.
      timeoutMs: 60_000,
      maxAttempts: 5,
    }).send(chunk(), ctl.signal)

    expect(f.calls).toHaveLength(1)
    expect(out).toEqual({ ok: false, terminal: false })
  })

  it('cuts the backoff short rather than sitting it out past the deadline', async () => {
    const f = scripted([status(503)])
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 30)

    const t0 = Date.now()
    const out = await uploaderWith(f.impl, {
      maxAttempts: 5,
      // A sleep that never resolves, standing in for the 30 s backoff the
      // uploader would otherwise be sitting inside when the deadline passes.
      sleep: () => new Promise<void>(() => {}),
      backoffMs: () => 30_000,
    }).send(chunk(), ctl.signal)

    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(f.calls).toHaveLength(1)
    expect(out).toEqual({ ok: false, status: 503, terminal: false })
  })

  it('leaves a healthy upload untouched: the signal is only ever a bound', async () => {
    const f = scripted([ok()])
    const ctl = new AbortController()
    const out = await uploaderWith(f.impl, { timeoutMs: 60_000 }).send(chunk(), ctl.signal)
    expect(out).toMatchObject({ ok: true, status: 200 })
    expect(ctl.signal.aborted).toBe(false)
  })
})

/* ── the tail when the platform will not take a beacon ───────────────────── */

/**
 * The tail path assumes `navigator.sendBeacon` exists and works. Three common situations
 * where it does not, and only the first two are detectable:
 *
 *  1. **It is gone.** Firefox's `beacon.enabled` pref removes it; content
 *     blockers delete it; some hardened browser modes never had it.
 *  2. **It is stubbed to refuse.** uBlock Origin's `set-constant` scriptlet with
 *     `falseFunc` is a filter-list one-liner, and the browser's own 64 KB
 *     keepalive quota makes a genuine `sendBeacon` return `false` too.
 *  3. **It lies.** Stubbed to return `true` and do nothing, or the request
 *     blocked by a network filter — `sendBeacon` returns `true` either way,
 *     because it reports queueing and never delivery. **Nothing can detect
 *     this**, here or anywhere, and no fallback is possible.
 *
 * 1 and 2 come back as `false`, and a `false` that nobody reads is a silently
 * lost tail: `sealSync` has already emptied the frame writer and deliberately
 * does not persist, so those bytes exist nowhere else.
 */
describe('sendTail when the platform will not take a beacon', () => {
  const body = new Uint8Array([1, 2, 3])

  function recorder(): { calls: { url: string; init: RequestInit }[]; impl: typeof fetch } {
    const calls: { url: string; init: RequestInit }[] = []
    const impl = ((url: string, init: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve({ ok: true, status: 202 } as Response)
    }) as unknown as typeof fetch
    return { calls, impl }
  }

  it('falls back to a keepalive fetch when the beacon refuses', () => {
    const { calls, impl } = recorder()
    const outcome = sendTail('https://ingest.test/v1/ingest', body, {
      beacon: () => false,
      fetchImpl: impl,
      apiKey: 'pk_test',
    })

    expect(outcome).toBe('keepalive')
    expect(calls).toHaveLength(1)
    // `keepalive` is the whole point: it is what lets a request outlive the
    // document that started it, which is the one property the beacon had.
    expect(calls[0]?.init.keepalive).toBe(true)
    expect(calls[0]?.init.method).toBe('POST')
  })

  it('falls back when sendBeacon does not exist at all', () => {
    const { calls, impl } = recorder()
    // No `beacon` port and no `navigator.sendBeacon` in this process: exactly
    // what a page sees when a blocker has deleted the API.
    const outcome = sendTail('https://ingest.test/v1/ingest', body, { fetchImpl: impl })
    expect(outcome).toBe('keepalive')
    expect(calls).toHaveLength(1)
  })

  it('carries the credential on each path in the only way that path can', () => {
    // The beacon can set no headers, so its key rides in the URL. The fallback
    // is a real fetch and uses a header, which keeps the key out of access logs
    // wherever we have the choice.
    let beaconUrl = ''
    sendTail('https://ingest.test/v1/ingest', body, {
      apiKey: 'pk test/+&',
      beacon: (url) => {
        beaconUrl = url
        return true
      },
    })
    expect(beaconUrl).toBe('https://ingest.test/v1/ingest?k=pk%20test%2F%2B%26')

    const { calls, impl } = recorder()
    sendTail('https://ingest.test/v1/ingest?tenant=7', body, {
      beacon: () => false,
      fetchImpl: impl,
      apiKey: 'pk_test',
      idempotencyKey: 'a'.repeat(64),
    })
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(calls[0]?.url).toBe('https://ingest.test/v1/ingest?tenant=7')
    expect(headers.authorization).toBe('Bearer pk_test')
    expect(headers['idempotency-key']).toBe('a'.repeat(64))
  })

  it('appends the key to an endpoint that already has a query', () => {
    let beaconUrl = ''
    sendTail('https://ingest.test/v1/ingest?tenant=7', body, {
      apiKey: 'pk_test',
      beacon: (url) => {
        beaconUrl = url
        return true
      },
    })
    expect(beaconUrl).toBe('https://ingest.test/v1/ingest?tenant=7&k=pk_test')
  })

  it('says so when neither path took it, instead of reporting a tail that never left', () => {
    const errors: unknown[] = []
    const outcome = withoutGlobalFetch(() =>
      sendTail('https://ingest.test/v1/ingest', body, {
        beacon: () => false,
        onInternalError: (e) => errors.push(e),
      }),
    )
    expect(outcome).toBe(false)
    expect(errors).toHaveLength(1)
  })

  it('never lets the fallback reject into the page', async () => {
    // The collector's failure is never the customer's failure, and an
    // unattended rejection at `pagehide` surfaces as an unhandled rejection in
    // somebody else's application.
    const impl = (() => Promise.reject(new Error('blocked by client'))) as unknown as typeof fetch
    const errors: unknown[] = []
    const outcome = sendTail('https://ingest.test/v1/ingest', body, {
      beacon: () => false,
      fetchImpl: impl,
      onInternalError: (e) => errors.push(e),
    })
    // Initiating it is all we can know at `pagehide`; the rejection arrives later.
    expect(outcome).toBe('keepalive')
    await Promise.resolve()
    await Promise.resolve()
    expect(errors).toHaveLength(1)
  })

  it('does not reach for a fallback when the body was refused on size', () => {
    // An oversize body is not a platform failure and retrying it as a fetch
    // would send the bytes the cap exists to withhold.
    const { calls, impl } = recorder()
    let beaconCalls = 0
    const outcome = sendTail('https://ingest.test/v1/ingest', new Uint8Array(64 * 1024 + 1), {
      beacon: () => {
        beaconCalls += 1
        return true
      },
      fetchImpl: impl,
    })
    expect(outcome).toBe(false)
    expect(beaconCalls).toBe(0)
    expect(calls).toEqual([])
  })
})
