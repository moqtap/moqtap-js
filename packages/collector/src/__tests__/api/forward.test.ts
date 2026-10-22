/**
 * What a probe hands its page when it compresses.
 *
 * Every frame arrives once and in order, whatever the compressor does: a piece
 * that comes out too large for a body is split and compressed again, one that
 * cannot be split or compressed goes as it is, and a forward asked for while
 * a compression runs follows it rather than overtaking it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../../api/config.js'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import {
  envelope,
  type ForwardMessage,
  type ForwardPart,
  type LinkedMessage,
  linkMessage,
} from '../../api/link.js'
import { ProbeRuntime, type ProbeTuning } from '../../api/probe.js'
import { draftSet } from '../../draft/index.js'
import { ALL_ADAPTERS } from '../../drafts/all.js'
import type { DeflateSegment } from '../../envelope/index.js'
import { crc32, readFrames } from '../../envelope/index.js'
import { installWebTransportHook } from '../../transport/index.js'
import type { EnvelopeRecord } from '../../types.js'
import { subgroupBytes } from '../decode/vectors.js'
import { settle } from '../support/settle.js'
import { MockWebTransport } from '../transport/mocks.js'

interface Harness {
  readonly forwards: ForwardMessage[]
  readonly errors: unknown[]
  /** Deliver `objects` objects of group `group` on the probe's transport. */
  send(group: number, objects: number): Promise<void>
  forward(): void
  stop(): void
}

/** Stand-in compressor output that is the input itself, so the test can read it back. */
const stored = (bytes: Uint8Array): DeflateSegment => ({
  deflate: bytes.slice(),
  crc: crc32(bytes),
  size: bytes.byteLength,
})

async function harness(tuning: ProbeTuning): Promise<Harness> {
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
  const { metrics, flightRecorder, limits, privacy, upload, context } = resolveConfig({
    apiKey: 'pk_test',
    endpoint: 'https://ingest.test/v1/ingest',
  })
  const linked: LinkedMessage = {
    t: 'linked',
    sessionId: 'sess',
    instanceId: 'inst',
    base: 0,
    level: 'headers+sizes',
    config: { metrics, flightRecorder, limits, privacy, upload, context },
  }
  const realm: { WebTransport?: unknown } = { WebTransport: MockWebTransport }
  const hook = installWebTransportHook(realm, null)
  // The probe's own timer never fires here: the test asks for each forward.
  const probe = new ProbeRuntime(
    linked,
    port,
    hook,
    draftSet(ALL_ADAPTERS),
    { setTimer: () => 0, clearTimer: () => {}, onInternalError: (e) => errors.push(e) },
    tuning,
  )
  probe.start()
  const wt = new (realm.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/w')
  await wt.open('moqt-20')
  await settle(5)
  const uni = wt.incomingUnidirectionalStreams.getReader()
  return {
    forwards,
    errors,
    async send(group, n) {
      const objects = Array.from({ length: n }, (_, i) => ({ id: BigInt(i), bytes: 1 }))
      const src = wt.deliverUniStream([subgroupBytes({ alias: 4n, group: BigInt(group), objects })])
      src.close()
      const arrived = await uni.read()
      const reader = (arrived.value as ReadableStream<Uint8Array>).getReader()
      for (;;) if ((await reader.read()).done) break
      await settle(2)
    },
    forward: () => onmessage?.({ data: envelope({ t: 'forward' }) } as MessageEvent),
    stop: () => onmessage?.({ data: envelope({ t: 'unlinked' }) } as MessageEvent),
  }
}

/** The records in a forward's parts, in order, reading the stand-in compressor's output as it is. */
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

const hdrGroups = (all: readonly EnvelopeRecord[]): string[] =>
  all.flatMap((r) => (r.t === 'hdr' ? [r.group] : []))

beforeEach(() => {
  MockWebTransport.instances = []
})

afterEach(() => {
  teardownDormant()
  resetDormantForTest()
})

describe('a compressing probe', () => {
  it('splits a piece that comes out too large for a body, and keeps every frame in order', async () => {
    const h = await harness({ compressMinBytes: 1, deflate: async (b) => stored(b) })
    for (let group = 0; group < 4; group += 1) await h.send(group, 200)
    h.forward()
    await settle(20)
    h.stop()

    expect(h.forwards).toHaveLength(1)
    const parts = h.forwards[0]?.parts ?? []
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) {
      expect('deflate' in p).toBe(true)
      expect(p.byteLength).toBeLessThanOrEqual(48 * 1024)
    }
    expect(parts.reduce((n, p) => n + p.n, 0)).toBe(h.forwards[0]?.n)
    const groups = hdrGroups(records(parts))
    expect(groups).toHaveLength(800)
    expect(groups).toEqual([...groups].sort((a, b) => Number(a) - Number(b)))
  })

  it('sends the frames as they are when the compressor fails', async () => {
    const h = await harness({
      compressMinBytes: 1,
      deflate: async () => {
        throw new Error('no compressor')
      },
    })
    await h.send(0, 50)
    h.forward()
    await settle(20)
    h.stop()

    const parts = h.forwards[0]?.parts ?? []
    expect(parts.every((p) => 'frames' in p)).toBe(true)
    expect(hdrGroups(records(parts))).toHaveLength(50)
    expect(h.errors.length).toBeGreaterThan(0)
  })

  it('holds a forward asked for during a compression until that one is sent', async () => {
    const gates: (() => void)[] = []
    const h = await harness({
      compressMinBytes: 1,
      deflate: (b) =>
        new Promise((resolve) => {
          gates.push(() => resolve(stored(b)))
        }),
    })
    await h.send(0, 20)
    h.forward()
    await settle(5)
    await h.send(1, 20)
    h.forward()
    await settle(5)
    expect(h.forwards).toHaveLength(0)
    expect(gates).toHaveLength(1)
    gates[0]?.()
    await settle(10)
    expect(gates).toHaveLength(2)
    gates[1]?.()
    await settle(10)
    h.stop()

    expect(h.forwards.map((f) => hdrGroups(records(f.parts ?? [])))).toEqual([
      Array(20).fill('0'),
      Array(20).fill('1'),
    ])
  })
})
