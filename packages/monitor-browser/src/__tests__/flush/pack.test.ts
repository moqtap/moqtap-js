/**
 * The packer: the buffer gzipped in runs as it grows, the runs joined into a
 * body once they weigh the target. No byte is compressed more than twice, no
 * one compression is longer than a merge and a step, and a pack whose frames
 * a seal took is dropped rather than redone.
 */

import { describe, expect, it } from 'vitest'
import { type DeflateSegment, deflateSegment, readFrames } from '../../envelope/index.js'
import { FlushQueue } from '../../flush/index.js'
import { Packer, type PackerOptions } from '../../flush/pack.js'
import type { NoteRecord } from '../../types.js'

const note = (i: number): NoteRecord => ({
  t: 'note',
  ts: i,
  lvl: 'baseline',
  name: `n${i}`,
  data: `object ${i % 30} of group ${i >> 5}`,
})

async function gunzipFrames(body: Uint8Array): Promise<number> {
  const ds = new DecompressionStream('gzip')
  const out = new Response(
    new Blob([body.subarray(8) as unknown as BlobPart]).stream().pipeThrough(ds),
  )
  return [...readFrames(new Uint8Array(await out.arrayBuffer()))].length
}

function harness(over: Partial<PackerOptions> = {}) {
  const queue = new FlushQueue({
    sessionId: 's',
    instanceId: 'i',
    maxPendingBytes: 1 << 24,
  })
  const timers: (() => void)[] = []
  const inputs: number[] = []
  const bodies: Uint8Array[] = []
  let hold = false
  const held: (() => void)[] = []
  /** Packs under way: the packer's own continuation runs before a wait on one ends. */
  const running = new Set<Promise<void>>()
  const packer: Packer = new Packer({
    queue,
    step: 2_000,
    merge: 8_000,
    target: 1_000,
    maxRaw: 1 << 20,
    timers: {
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
    },
    onBody: () => {
      const packed = packer.take()
      if (packed !== null) bodies.push(queue.sealSegment(packed.segment, {}, packed).bytes)
    },
    onFailed: (err) => {
      throw err
    },
    deflate: (b) => {
      inputs.push(b.byteLength)
      let done = deflateSegment(b)
      if (hold) {
        const real = done
        done = new Promise<DeflateSegment>((resolve) => held.push(() => resolve(real)))
      }
      const settled = done.then(
        () => {},
        () => {},
      )
      running.add(settled)
      void settled.then(() => running.delete(settled))
      return done
    },
    ...over,
  })
  let next = 0
  return {
    queue,
    packer,
    inputs,
    bodies,
    write(n: number): void {
      for (let k = 0; k < n; k += 1) queue.json(note(next++))
      packer.note()
    },
    get written(): number {
      return next
    },
    /** Run the timers and the packs they start until nothing more is due. */
    async run(): Promise<void> {
      for (;;) {
        const fn = timers.shift()
        if (fn !== undefined) fn()
        else if (!hold && running.size > 0) await Promise.all([...running])
        else break
        await Promise.resolve()
      }
    },
    hold(on: boolean): void {
      hold = on
    },
    release(): void {
      for (const r of held.splice(0)) r()
    },
  }
}

describe('Packer', () => {
  it('joins its runs into bodies by their gzipped size, compressing a byte at most twice', async () => {
    const h = harness()
    let raw = 0
    for (let i = 0; i < 40; i += 1) {
      const before = h.queue.pendingBytes
      h.write(30)
      raw += h.queue.pendingBytes - before
      await h.run()
    }

    expect(h.bodies.length).toBeGreaterThan(1)
    let frames = 0
    for (const b of h.bodies) {
      expect(b.byteLength).toBeLessThan(1_000 + 600)
      frames += await gunzipFrames(b)
    }
    // Each body's batch frame, and every note sealed so far.
    expect(frames - h.bodies.length + h.queue.frameCount).toBe(h.written)
    expect(h.inputs.reduce((n, x) => n + x, 0)).toBeLessThanOrEqual(2 * raw)
    for (const x of h.inputs) expect(x).toBeLessThanOrEqual(8_000 + 2_000 + 200)
  })

  it('keeps no compression longer than a merge and a step when a burst arrives at once', async () => {
    const h = harness({ target: 1 << 20 })
    h.write(2_000)
    await h.run()

    expect(Math.max(...h.inputs)).toBeLessThanOrEqual(8_000 + 2_000 + 200)
    expect(h.inputs.some((x) => x >= 8_000)).toBe(true)
  })

  it('drops a pack whose frames a seal took, and packs only what came after', async () => {
    const h = harness({ target: 1 << 20 })
    h.write(40)
    h.hold(true)
    await h.run()
    expect(h.inputs).toHaveLength(1)

    // Sealed while the pack is under way, with no run yet to join.
    expect(h.packer.take(1 << 20)).toBeNull()
    h.queue.seal()
    h.hold(false)
    h.release()
    await h.run()
    expect(h.packer.packedBytes).toBe(0)

    h.write(40)
    const after = h.queue.pendingBytes
    await h.run()
    expect(h.inputs.slice(1).reduce((n, x) => n + x, 0)).toBeLessThanOrEqual(after)
    expect(h.packer.packedBytes).toBeGreaterThan(0)
  })

  it('keeps a pack under way on later frames when a body takes the runs before it', async () => {
    const h = harness({ target: 1 << 20 })
    h.write(40)
    await h.run()
    const first = h.packer.packedBytes
    expect(first).toBeGreaterThan(0)
    const packs = h.inputs.length

    h.write(40)
    h.hold(true)
    await h.run()
    expect(h.inputs).toHaveLength(packs + 1)
    const packed = h.packer.take()
    expect(packed?.bytes).toBe(first)
    expect(packed?.rest).toBe(false)
    h.queue.sealSegment(packed?.segment as DeflateSegment, {}, packed ?? undefined)
    const left = h.queue.pendingBytes
    h.hold(false)
    h.release()
    await h.run()

    // The pack under way became a run, and nothing after the body was packed twice.
    expect(h.packer.packedBytes).toBeGreaterThanOrEqual(h.inputs[packs] as number)
    expect(h.inputs.slice(packs).reduce((n, x) => n + x, 0)).toBeLessThanOrEqual(left)
    const body = h.packer.take(1 << 20)
    expect(body?.rest).toBe(true)
    const frames = h.queue.frameCount
    const sealed = h.queue.sealSegment(body?.segment as DeflateSegment, {}, body ?? undefined, true)
    expect(await gunzipFrames(sealed.bytes)).toBe(1 + frames)
    expect(h.queue.frameCount).toBe(0)
  })
})
