/**
 * Tests for the memory-only byte ring — behaviour two other modules depend on
 * and neither can see:
 *
 *  - **Bytes are copied on the way in and on the way out.** The seam hands over
 *    a view onto the page's own buffer (`StreamChunk.data`), and the ring
 *    overwrites itself continuously while a trigger's re-parse is in flight. A
 *    view retained at either end silently rewrites already-recorded history,
 *    which does not fail — it produces a plausible wrong answer, in the dump
 *    the customer armed the recorder to get.
 *  - **Eviction is FIFO and the survivors stay byte-exact.** The ring writes
 *    every entry contiguously and wraps by abandoning tail slack rather than
 *    splitting, so the offset arithmetic has a wrap case, a full case and an
 *    ambiguous `writeOff === oldest offset` case. A model-based loop over many
 *    laps is the only test that reaches all three together.
 *  - **The bounds are bounds.** A ring that exceeded either one would spend
 *    memory on the customer's device that the depth key promises it will not.
 *  - **The storage is not claimed until it is wanted.** The ring is built
 *    unconditionally by `CollectorRuntime` and written to only while a
 *    flight-recorder trigger is armed, which ships off, so allocating in the
 *    constructor would cost a default install 32 MiB it never touches.
 *    `isReserved` makes that observable, so the regression is a failing test
 *    rather than a number nobody looks at.
 *
 * Not asserted: that `push` allocates nothing *per write*. That is true by
 * construction — the storage is claimed once and the write path performs stores
 * and one `TypedArray.set` — but nothing portable observes allocation from
 * inside a test, and a heap-delta assertion would be a flaky test of the garbage
 * collector rather than of this file.
 */

import { describe, expect, it } from 'vitest'
import { ByteRing, parseByteDepth, type RingEntry } from '../../ring/index.js'

const chunk = (len: number, fill: number): Uint8Array => new Uint8Array(len).fill(fill)

const entry = (
  data: Uint8Array,
  o: Partial<Omit<RingEntry, 'seq' | 'data'>> = {},
): Omit<RingEntry, 'seq'> => ({
  sessionId: 's1',
  streamId: 1,
  dir: 'rx',
  control: false,
  atMono: 0,
  ...o,
  data,
})

describe('ByteRing.push', () => {
  it('copies the chunk, so a caller writing through its own view cannot rewrite history', () => {
    const ring = new ByteRing({ maxBytes: 64 })
    const borrowed = chunk(8, 0x11)
    ring.push(entry(borrowed))

    // Exactly what the page does on its next frame.
    borrowed.fill(0x99)

    expect([...ring.snapshot()[0]!.data]).toEqual(new Array(8).fill(0x11))
  })

  it('carries the seam metadata through unchanged', () => {
    const ring = new ByteRing({ maxBytes: 64 })
    ring.push({
      sessionId: 'sess-a',
      streamId: 42,
      dir: 'tx',
      control: true,
      atMono: 12.5,
      data: chunk(3, 7),
    })
    ring.push({
      sessionId: 'sess-b',
      streamId: 0,
      dir: 'rx',
      control: false,
      atMono: 13,
      data: chunk(1, 8),
    })

    expect(ring.snapshot()).toMatchObject([
      { seq: 0, sessionId: 'sess-a', streamId: 42, dir: 'tx', control: true, atMono: 12.5 },
      { seq: 1, sessionId: 'sess-b', streamId: 0, dir: 'rx', control: false, atMono: 13 },
    ])
  })

  it('assigns strictly increasing sequence numbers', () => {
    const ring = new ByteRing({ maxBytes: 4096 })
    for (let i = 0; i < 5; i++) ring.push(entry(chunk(4, i)))
    expect(ring.snapshot().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4])
  })

  it('accepts a zero-length chunk without disturbing the entries around it', () => {
    const ring = new ByteRing({ maxBytes: 64, maxEntries: 8 })
    ring.push(entry(chunk(0, 0), { streamId: 7 }))
    ring.push(entry(chunk(4, 3)))
    for (let i = 0; i < 6; i++) ring.push(entry(chunk(20, i)))

    const snap = ring.snapshot()
    expect(ring.bytes).toBe(snap.reduce((n, e) => n + e.data.length, 0))
    expect(ring.bytes).toBeLessThanOrEqual(64)
    expect([...snap.at(-1)!.data]).toEqual(new Array(20).fill(5))
  })

  it('records through pushParts exactly as through push', () => {
    const viaObject = new ByteRing({ maxBytes: 64 })
    const viaParts = new ByteRing({ maxBytes: 64 })

    viaObject.push({
      sessionId: 's',
      streamId: 3,
      dir: 'tx',
      control: true,
      atMono: 1.5,
      data: chunk(4, 2),
    })
    viaParts.pushParts('s', 3, 'tx', true, 1.5, chunk(4, 2))

    expect(viaParts.snapshot()).toEqual(viaObject.snapshot())
  })
})

describe('ByteRing eviction', () => {
  it('evicts the oldest entries until the newest fits, and counts what it lost', () => {
    const ring = new ByteRing({ maxBytes: 100, maxEntries: 8 })
    for (let i = 0; i < 3; i++) ring.push(entry(chunk(30, i)))
    expect(ring.entries).toBe(3)
    expect(ring.evicted).toBe(0)

    // 10 bytes free at the tail: too few, so the entry wraps to offset 0 and
    // the oldest goes to make room for it.
    ring.push(entry(chunk(20, 9)))

    expect(ring.snapshot().map((e) => e.seq)).toEqual([1, 2, 3])
    expect([...ring.snapshot().at(-1)!.data]).toEqual(new Array(20).fill(9))
    expect(ring.bytes).toBe(80)
    expect(ring.evicted).toBe(1)
    expect(ring.evictedBytes).toBe(30)
  })

  it('bounds the entry count independently of the byte depth', () => {
    const ring = new ByteRing({ maxBytes: 4096, maxEntries: 3 })
    for (let i = 0; i < 5; i++) ring.push(entry(chunk(4, i)))

    expect(ring.entries).toBe(3)
    expect(ring.bytes).toBe(12)
    expect(ring.snapshot().map((e) => e.seq)).toEqual([2, 3, 4])
    expect(ring.evicted).toBe(2)
    expect(ring.evictedBytes).toBe(8)
  })

  it('refuses a chunk larger than the whole ring rather than truncating it', () => {
    const ring = new ByteRing({ maxBytes: 32, maxEntries: 4 })
    ring.push(entry(chunk(8, 1)))
    ring.push(entry(chunk(64, 2)))

    // A truncated chunk re-parses into plausible garbage, so it is not stored;
    // what was already held is untouched.
    expect(ring.entries).toBe(1)
    expect(ring.bytes).toBe(8)
    expect([...ring.snapshot()[0]!.data]).toEqual(new Array(8).fill(1))
    expect(ring.evicted).toBe(1)
    expect(ring.evictedBytes).toBe(64)
  })

  it('keeps every surviving entry byte-exact across many laps of the buffer', () => {
    const ring = new ByteRing({ maxBytes: 256, maxEntries: 8 })
    const pushed: number[][] = []

    for (let i = 0; i < 200; i++) {
      const len = 1 + ((i * 37) % 61)
      const data = chunk(len, i & 0xff)
      ring.push(entry(data, { streamId: i % 3, atMono: i }))
      pushed.push([...data])

      const snap = ring.snapshot()
      const seqs = snap.map((e) => e.seq)

      // FIFO: the live set is always the most recent contiguous run of seqs.
      expect(seqs).toEqual(seqs.map((_, n) => (seqs[0] ?? 0) + n))
      expect(seqs.at(-1)).toBe(i)

      for (const e of snap) {
        expect([...e.data]).toEqual(pushed[e.seq])
        expect(e.streamId).toBe(e.seq % 3)
        expect(e.atMono).toBe(e.seq)
      }

      expect(ring.bytes).toBe(snap.reduce((n, e) => n + e.data.length, 0))
      expect(ring.bytes).toBeLessThanOrEqual(256)
      expect(ring.entries).toBeLessThanOrEqual(8)
      expect(ring.evicted).toBe(i + 1 - snap.length)
    }
  })
})

describe('ByteRing refusal accounting', () => {
  it('separates a mid-stream hole from ordinary overwrite pressure', () => {
    const ring = new ByteRing({ maxBytes: 32, maxEntries: 4 })
    for (let i = 0; i < 4; i++) ring.push(entry(chunk(16, i)))

    // Overwrite pressure only: a stream's survivors are still a contiguous
    // suffix, so a replay starts late and knows it.
    expect(ring.evicted).toBeGreaterThan(0)
    expect(ring.refused).toBe(0)
    expect(ring.refusedBytes).toBe(0)

    const evictedBefore = ring.evicted
    ring.push(entry(chunk(64, 9)))

    // A refusal is different in kind: the chunks either side of it are now
    // adjacent, and concatenating them re-parses into objects never sent.
    expect(ring.refused).toBe(1)
    expect(ring.refusedBytes).toBe(64)
    expect(ring.evicted).toBe(evictedBefore + 1)
    expect(ring.evictedBytes).toBeGreaterThanOrEqual(64)
  })
})

describe('ByteRing zero-length writes', () => {
  it('stores an empty write without evicting anything to make room for it', () => {
    // Fill exactly, including one wrap, so writeOff lands on the oldest entry's
    // offset — the ambiguous "is it full or empty" case in the offset walk.
    const ring = new ByteRing({ maxBytes: 16, maxEntries: 8 })
    ring.push(entry(chunk(8, 1)))
    ring.push(entry(chunk(8, 2)))
    ring.push(entry(chunk(8, 3)))
    expect(ring.bytes).toBe(16)
    const evictedBefore = ring.evicted

    ring.push(entry(chunk(0, 0), { streamId: 77 }))

    // An empty write needs no bytes, so it must cost no data.
    expect(ring.evicted).toBe(evictedBefore)
    expect(ring.bytes).toBe(16)
    expect(ring.entries).toBe(3)
    expect(ring.snapshotStream(77).map((e) => e.data.length)).toEqual([0])
  })
})

describe('ByteRing.snapshotWindow', () => {
  const build = () => {
    const ring = new ByteRing({ maxBytes: 4096 })
    for (let i = 0; i < 10; i++) ring.push(entry(chunk(4, i), { atMono: i * 10 }))
    return ring
  }

  it('returns exactly the entries snapshot() would, filtered to the window', () => {
    const ring = build()
    const want = ring.snapshot().filter((e) => e.atMono >= 20 && e.atMono <= 50)

    expect(ring.snapshotWindow(20, 50)).toEqual(want)
    expect(want.map((e) => e.atMono)).toEqual([20, 30, 40, 50])
  })

  it('includes both bounds', () => {
    const ring = build()
    expect(ring.snapshotWindow(30, 30).map((e) => e.atMono)).toEqual([30])
    expect(ring.snapshotWindow(0, 90).length).toBe(10)
  })

  it('is empty when the window falls outside what the ring still holds', () => {
    const ring = build()
    expect(ring.snapshotWindow(1000, 2000)).toEqual([])
    expect(ring.snapshotWindow(-100, -1)).toEqual([])
  })

  it('copies, so a window handed to a re-parse survives the ring lapping', () => {
    const ring = new ByteRing({ maxBytes: 64, maxEntries: 4 })
    ring.push(entry(chunk(16, 0xaa), { atMono: 5 }))
    const window = ring.snapshotWindow(0, 10)

    for (let i = 0; i < 20; i++) ring.push(entry(chunk(16, 0xbb), { atMono: 100 + i }))

    expect([...window[0]!.data]).toEqual(new Array(16).fill(0xaa))
  })
})

/**
 * A seeded model check across many ring geometries.
 *
 * The single-geometry lap test above exercises one wrap pattern. The offset
 * walk has four cases — free tail, wrap to the front, the entry-slot cap, and
 * the ambiguous `writeOff === oldest offset` — and which of them a push takes
 * depends on the ratio of chunk size to depth. Small depths, `maxEntries: 1`
 * and chunks that sometimes exceed the whole ring reach combinations no
 * hand-written sequence covers, against the property every consumer relies on:
 * whatever survives is a byte-exact FIFO suffix of what went in, inside both
 * bounds.
 *
 * Seeded, so a failure names a reproducible case rather than a flake.
 */
describe('ByteRing model check', () => {
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  for (let seed = 0; seed < 24; seed++) {
    it(`holds the FIFO and bound invariants under seed ${seed}`, () => {
      const rnd = rng(seed)
      const maxBytes = 1 + Math.floor(rnd() * 200)
      const maxEntries = 1 + Math.floor(rnd() * 10)
      const ring = new ByteRing({ maxBytes, maxEntries })
      const accepted: { seq: number; bytes: number[]; streamId: number }[] = []
      let nextSeq = 0
      let refused = 0

      for (let i = 0; i < 150; i++) {
        // Sometimes larger than the whole ring, sometimes empty.
        const len = Math.floor(rnd() * (maxBytes + 4))
        const data = new Uint8Array(len)
        for (let k = 0; k < len; k++) data[k] = (nextSeq * 31 + k) & 0xff
        const streamId = i % 3
        ring.push(entry(data, { streamId, atMono: i }))
        if (len > maxBytes) refused++
        else accepted.push({ seq: nextSeq++, bytes: [...data], streamId })
        // The page writes through its own buffer on the next frame.
        data.fill(0x5a)

        const snap = ring.snapshot()
        const seqs = snap.map((e) => e.seq)

        expect(ring.entries).toBeLessThanOrEqual(maxEntries)
        expect(ring.bytes).toBeLessThanOrEqual(maxBytes)
        expect(ring.bytes).toBe(snap.reduce((n, e) => n + e.data.length, 0))
        expect(seqs).toEqual(accepted.slice(accepted.length - seqs.length).map((a) => a.seq))
        expect(ring.evicted).toBe(accepted.length - seqs.length + refused)
        expect(ring.refused).toBe(refused)

        for (const e of snap) {
          const want = accepted.find((a) => a.seq === e.seq)!
          expect([...e.data]).toEqual(want.bytes)
          expect(e.streamId).toBe(want.streamId)
        }
        for (const sid of [0, 1, 2]) {
          expect(ring.snapshotStream(sid).map((e) => e.seq)).toEqual(
            snap.filter((e) => e.streamId === sid).map((e) => e.seq),
          )
        }
      }
    })
  }
})

describe('ByteRing.snapshot', () => {
  it('does not consume the ring — a second trigger sees the same history', () => {
    const ring = new ByteRing({ maxBytes: 64 })
    for (let i = 0; i < 3; i++) ring.push(entry(chunk(4, i)))

    const first = ring.snapshot()
    const second = ring.snapshot()

    expect(second).toEqual(first)
    expect(ring.entries).toBe(3)
    expect(ring.bytes).toBe(12)
  })

  it('returns bytes the ring cannot overwrite afterwards', () => {
    const ring = new ByteRing({ maxBytes: 64, maxEntries: 4 })
    ring.push(entry(chunk(16, 0xaa)))
    const taken = ring.snapshot()

    // Enough traffic to overwrite the whole buffer several times.
    for (let i = 0; i < 20; i++) ring.push(entry(chunk(16, 0xbb)))

    expect([...taken[0]!.data]).toEqual(new Array(16).fill(0xaa))
  })

  it('is empty on a fresh ring', () => {
    expect(new ByteRing({ maxBytes: 64 }).snapshot()).toEqual([])
  })
})

describe('ByteRing.snapshotStream', () => {
  it('returns one stream in arrival order and nothing else', () => {
    const ring = new ByteRing({ maxBytes: 256 })
    ring.push(entry(chunk(4, 1), { streamId: 1 }))
    ring.push(entry(chunk(4, 2), { streamId: 2 }))
    ring.push(entry(chunk(4, 3), { streamId: 1 }))
    ring.push(entry(chunk(4, 4), { streamId: 3 }))

    expect(ring.snapshotStream(1).map((e) => e.seq)).toEqual([0, 2])
    expect(ring.snapshotStream(1).map((e) => e.data[0])).toEqual([1, 3])
    expect(ring.snapshotStream(9)).toEqual([])
  })

  it('drops the entries of one stream as they are evicted, like any other', () => {
    const ring = new ByteRing({ maxBytes: 32, maxEntries: 8 })
    ring.push(entry(chunk(16, 1), { streamId: 5 }))
    for (let i = 0; i < 4; i++) ring.push(entry(chunk(16, 2), { streamId: 6 }))

    expect(ring.snapshotStream(5)).toEqual([])
    expect(ring.snapshotStream(6).length).toBeGreaterThan(0)
  })
})

describe('ByteRing.clear', () => {
  it('empties the ring, keeps the loss counters, and never reuses a seq', () => {
    const ring = new ByteRing({ maxBytes: 16, maxEntries: 4 })
    for (let i = 0; i < 6; i++) ring.push(entry(chunk(8, i)))

    const evicted = ring.evicted
    const evictedBytes = ring.evictedBytes
    expect(evicted).toBeGreaterThan(0)

    ring.clear()

    expect(ring.entries).toBe(0)
    expect(ring.bytes).toBe(0)
    expect(ring.snapshot()).toEqual([])
    // A deliberate teardown is not overwrite pressure: counting it would make
    // every clean session look lossy in the terminal record.
    expect(ring.evicted).toBe(evicted)
    expect(ring.evictedBytes).toBe(evictedBytes)

    ring.push(entry(chunk(4, 9)))
    expect(ring.snapshot().map((e) => e.seq)).toEqual([6])
    expect(ring.bytes).toBe(4)
  })

  it('is safe on an empty ring', () => {
    const ring = new ByteRing({ maxBytes: 16 })
    ring.clear()
    ring.clear()
    ring.push(entry(chunk(4, 1)))
    expect(ring.entries).toBe(1)
  })
})

describe('ByteRing construction', () => {
  it('derives an entry cap from the byte depth when none is given', () => {
    // maxBytes / 512, clamped to [64, 65536].
    expect(new ByteRing({ maxBytes: 1024 }).maxEntries).toBe(64)
    expect(new ByteRing({ maxBytes: 512 * 1000 }).maxEntries).toBe(1000)
    expect(new ByteRing({ maxBytes: 32 * 1024 * 1024 }).maxEntries).toBe(65_536)
  })

  it('refuses a depth that cannot hold anything', () => {
    expect(() => new ByteRing({ maxBytes: 0 })).toThrow()
    expect(() => new ByteRing({ maxBytes: -1 })).toThrow()
    expect(() => new ByteRing({ maxBytes: Number.NaN })).toThrow()
    expect(() => new ByteRing({ maxBytes: 64, maxEntries: 0 })).toThrow()
  })
})

describe('parseByteDepth', () => {
  it('reads the default depth the spec itself writes', () => {
    expect(parseByteDepth('32MB')).toBe(33_554_432)
  })

  it('treats the decimal spellings as binary multiples', () => {
    expect(parseByteDepth('1KB')).toBe(1024)
    expect(parseByteDepth('1KiB')).toBe(1024)
    expect(parseByteDepth('512kb')).toBe(524_288)
    expect(parseByteDepth('1GB')).toBe(1_073_741_824)
    expect(parseByteDepth('1.5MB')).toBe(1_572_864)
  })

  it('accepts surrounding space, bare byte counts and numbers', () => {
    expect(parseByteDepth('  8 mb ')).toBe(8_388_608)
    expect(parseByteDepth('4096')).toBe(4096)
    expect(parseByteDepth('4096b')).toBe(4096)
    expect(parseByteDepth(4096)).toBe(4096)
    expect(parseByteDepth(4096.9)).toBe(4096)
  })

  it('throws rather than substituting a default it was not asked for', () => {
    // A silently defaulted depth is a recorder sized at something other than
    // what the customer wrote, discovered during the incident it was armed for.
    expect(() => parseByteDepth('abc')).toThrow()
    expect(() => parseByteDepth('')).toThrow()
    expect(() => parseByteDepth('32TB')).toThrow()
    expect(() => parseByteDepth('32 megabytes')).toThrow()
    expect(() => parseByteDepth('0')).toThrow()
    expect(() => parseByteDepth('-1MB')).toThrow()
    expect(() => parseByteDepth(0)).toThrow()
    expect(() => parseByteDepth(-5)).toThrow()
    expect(() => parseByteDepth(Number.NaN)).toThrow()
    expect(() => parseByteDepth(Number.POSITIVE_INFINITY)).toThrow()
  })
})

describe('the storage is claimed only when the ring is wanted', () => {
  it('allocates nothing at construction', () => {
    // The measured cost of getting this wrong: `flightRecorder.depth` defaults
    // to '32MB' and `flightRecorder.triggers` defaults to `{}`, so eager
    // allocation costs a fresh install 32 MiB plus 1.8 MiB of slot arrays it
    // never writes a byte into — roughly a thousand times the gzipped bundle.
    const ring = new ByteRing({ maxBytes: 32 * 1024 * 1024 })
    expect(ring.isReserved).toBe(false)
    // The bounds are known from the constructor either way: they are what the
    // runtime reports as the recorder's capacity, and they are scalars.
    expect(ring.maxBytes).toBe(32 * 1024 * 1024)
    expect(ring.maxEntries).toBeGreaterThan(0)
  })

  it('still validates its bounds at construction, not at first write', () => {
    // A bad depth is a configuration error and belongs on the caller's stack at
    // init(), not on the first chunk in the middle of a session.
    expect(() => new ByteRing({ maxBytes: 0 })).toThrow()
    expect(() => new ByteRing({ maxBytes: Number.NaN })).toThrow()
    expect(() => new ByteRing({ maxBytes: 64, maxEntries: 0 })).toThrow()
    expect(() => new ByteRing({ maxBytes: 64, maxEntries: Number.NaN })).toThrow()
  })

  it('reads as empty before it is reserved, rather than throwing', () => {
    const ring = new ByteRing({ maxBytes: 4096 })
    expect(ring.entries).toBe(0)
    expect(ring.bytes).toBe(0)
    expect(ring.evicted).toBe(0)
    expect(ring.refused).toBe(0)
    expect(ring.snapshot()).toEqual([])
    expect(ring.snapshotStream(1)).toEqual([])
    expect(ring.snapshotWindow(0, 1e9)).toEqual([])
    expect(() => ring.clear()).not.toThrow()
    expect(ring.isReserved).toBe(false)
  })

  it('reserves on demand, and reserving twice is a no-op', () => {
    const ring = new ByteRing({ maxBytes: 4096 })
    ring.reserve()
    expect(ring.isReserved).toBe(true)
    ring.push(entry(chunk(8, 0x41)))
    expect(ring.entries).toBe(1)
    ring.reserve()
    // A second reserve must not hand the ring fresh empty buffers.
    expect(ring.entries).toBe(1)
    expect(ring.bytes).toBe(8)
  })

  it('claims its storage on the first write if nobody reserved it', () => {
    // The dormant pre-key ring is built at module-eval time and written to only
    // if a WebTransport session actually opens, so this path is the ordinary
    // one for it -- not a fallback.
    const ring = new ByteRing({ maxBytes: 4096 })
    expect(ring.isReserved).toBe(false)
    const data = chunk(16, 0x42)
    ring.push(entry(data))
    expect(ring.isReserved).toBe(true)
    const [first] = ring.snapshot()
    expect(first?.data).toEqual(data)
    expect(ring.bytes).toBe(16)
  })

  it('behaves identically whether or not it was reserved first', () => {
    const make = (reserveFirst: boolean): ByteRing => {
      const r = new ByteRing({ maxBytes: 128, maxEntries: 4 })
      if (reserveFirst) r.reserve()
      for (let i = 0; i < 12; i++) {
        r.push(
          entry(chunk(20, i), {
            sessionId: `s${i % 2}`,
            streamId: i % 3,
            dir: i % 2 === 0 ? 'rx' : 'tx',
            control: i % 4 === 0,
            atMono: i,
          }),
        )
      }
      return r
    }
    const eager = make(true)
    const lazy = make(false)
    expect(lazy.snapshot()).toEqual(eager.snapshot())
    expect(lazy.bytes).toBe(eager.bytes)
    expect(lazy.entries).toBe(eager.entries)
    expect(lazy.evicted).toBe(eager.evicted)
    expect(lazy.evictedBytes).toBe(eager.evictedBytes)
  })

  it('refuses an oversize chunk as oversize, not as an unclaimed ring', () => {
    // The check is `len > buf.length`, and an unreserved buffer is zero-length.
    // Testing before reserving would refuse every chunk ever offered and report
    // the ring as hopelessly undersized.
    const ring = new ByteRing({ maxBytes: 64 })
    ring.push(entry(chunk(32, 0x43)))
    expect(ring.entries).toBe(1)
    expect(ring.refused).toBe(0)

    const tooBig = new ByteRing({ maxBytes: 64 })
    tooBig.push(entry(chunk(65, 0x44)))
    expect(tooBig.entries).toBe(0)
    expect(tooBig.refused).toBe(1)
  })
})
