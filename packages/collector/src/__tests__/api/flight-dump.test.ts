/**
 * A worker's flight dump, from its recorder to the parts its page receives.
 *
 * A dump is the largest thing a probe forwards. It must reach the page as
 * pieces each small enough to be a body, never as one frame larger than the
 * page's buffer: that is refused whole and counted as dropped, which marks the
 * session partial.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../../api/config.js'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import type { RealmRecorder } from '../../api/features.js'
import {
  envelope,
  type ForwardMessage,
  type ForwardPart,
  type LinkedMessage,
  linkMessage,
} from '../../api/link.js'
import { ProbeRuntime, type WorkerBuild } from '../../api/probe.js'
import { crc32, readFrames } from '../../envelope/index.js'
import { flightRecorder } from '../../features/flight-recorder.js'
import { FrameBuffer } from '../../flush/frame-buffer.js'
import { installWebTransportHook } from '../../transport/index.js'
import type { EnvelopeRecord, FlightRecord } from '../../types.js'
import { subgroupBytes } from '../decode/vectors.js'
import { workerBuild } from '../support/init.js'
import { settle } from '../support/settle.js'
import { MockWebTransport } from '../transport/mocks.js'

/** The largest compressed piece a probe forwards as one body (`api/probe.ts`). */
const PIECE_MAX_BYTES = 48 * 1024

beforeEach(() => {
  MockWebTransport.instances = []
})

afterEach(() => {
  teardownDormant()
  resetDormantForTest()
})

function records(parts: readonly ForwardPart[]): EnvelopeRecord[] {
  const out: EnvelopeRecord[] = []
  const decoder = new TextDecoder()
  for (const p of parts) {
    const bytes =
      'deflate' in p
        ? new Uint8Array(p.deflate, 0, p.byteLength)
        : new Uint8Array(p.frames, 0, p.byteLength)
    for (const f of readFrames(bytes)) {
      if (!f.raw) out.push(JSON.parse(decoder.decode(f.payload)) as EnvelopeRecord)
    }
  }
  return out
}

describe("a worker's flight dump", () => {
  it('reaches the page in body-sized pieces at 12,000 objects, none refused', async () => {
    const forwards: ForwardMessage[] = []
    const errors: unknown[] = []
    let onmessage: ((e: MessageEvent) => void) | undefined
    const port = {
      postMessage: (m: unknown) => {
        const f = linkMessage(m)
        if (f?.t === 'fwd') forwards.push(f as unknown as ForwardMessage)
      },
      set onmessage(f: (e: MessageEvent) => void) {
        onmessage = f
      },
      close: () => {},
    } as unknown as MessagePort
    const {
      metrics,
      flightRecorder: fr,
      limits,
      privacy,
      upload,
      context,
    } = resolveConfig({
      apiKey: 'pk_test',
      endpoint: 'https://ingest.test/v1/ingest',
      // Armed, so the ring fills; the test fires the dump itself.
      flightRecorder: { triggers: { stall: { afterMs: 600_000 } } },
    })
    const linked: LinkedMessage = {
      t: 'linked',
      sessionId: 'sess',
      instanceId: 'inst',
      base: 0,
      level: 'baseline',
      room: 8 * 1024 * 1024,
      config: { metrics, flightRecorder: fr, limits, privacy, upload, context },
    }
    let recorder: RealmRecorder | undefined
    const build: WorkerBuild = {
      drafts: workerBuild.drafts,
      recorder: {
        ...flightRecorder,
        create(d, ring) {
          recorder = flightRecorder.create(d, ring)
          return recorder
        },
      },
    }
    const realm: { WebTransport?: unknown } = { WebTransport: MockWebTransport }
    const hook = installWebTransportHook(realm, null)
    const probe = new ProbeRuntime(
      linked,
      port,
      hook,
      build,
      { setTimer: () => 0, clearTimer: () => {}, onInternalError: (e) => errors.push(e) },
      {
        compressMinBytes: 1,
        // The compressor stores rather than shrinks, so a piece weighs what its
        // frames do and the test can read it back.
        deflate: async (b) => ({ deflate: b.slice(), crc: crc32(b), size: b.byteLength }),
      },
    )
    probe.start()
    const forward = (): void => onmessage?.({ data: envelope({ t: 'forward' }) } as MessageEvent)

    const wt = new (realm.WebTransport as new (u: string) => MockWebTransport)(
      'https://relay.test/w',
    )
    await wt.open('moqt-20')
    await settle(5)
    const uni = wt.incomingUnidirectionalStreams.getReader()
    const objects = Array.from({ length: 12_000 }, (_, i) => ({ id: BigInt(i), bytes: 1 }))
    wt.deliverUniStream([subgroupBytes({ alias: 4n, group: 0n, objects })]).close()
    const arrived = await uni.read()
    const reader = (arrived.value as ReadableStream<Uint8Array>).getReader()
    for (;;) if ((await reader.read()).done) break
    await settle(2)
    forward()
    await settle(20)
    const before = forwards.length

    recorder?.fire({ kind: 'stall', atMono: performance.now() + 1, detail: 'test' })
    await settle(40)
    forward()
    await settle(40)
    onmessage?.({ data: envelope({ t: 'unlinked' }) } as MessageEvent)

    const after = forwards.slice(before)
    const parts = after.flatMap((f) => f.parts ?? [])
    // The page's own buffer: what `session.ts` appends a frames part into.
    const page = new FrameBuffer({ maxPendingBytes: 8 * upload.byteThreshold })
    for (const p of parts) {
      if ('deflate' in p) expect(p.byteLength).toBeLessThanOrEqual(PIECE_MAX_BYTES)
      else expect(page.append(new Uint8Array(p.frames, 0, p.byteLength), p.n)).toBe(true)
    }
    const dump = records(parts).filter((r): r is FlightRecord => r.t === 'flight')
    expect(dump.length).toBeGreaterThan(1)
    expect(dump.flatMap((r) => r.cols.object)).toEqual(objects.map((o) => Number(o.id)))
    expect(dump.every((r) => !r.truncated)).toBe(true)
    expect(after.every((f) => f.dropped === 0)).toBe(true)
    expect(errors).toEqual([])
  })
})
