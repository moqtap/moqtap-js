/**
 * The vendored v2 viewer goldens: the same inputs through this package's
 * writer give the same bytes.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type BodyConn,
  type BodyTrack,
  batchJson,
  contractBody,
  encodeMarks,
  encodeRuns,
  encodeStreamEnds,
  type MarkInput,
  preambleFrame,
  type RunInput,
  type StreamEndInput,
  withRseq,
} from '../../envelope/contract.js'
import { FrameWriter } from '../../envelope/frame-writer.js'
import { idempotencyKey } from '../../envelope/idempotency.js'
import type { EnvelopeRecord } from '../../types.js'
import { factsOf } from '../support/runs.js'

const DIR = join(import.meta.dirname, 'fixtures', 'contract-v2')

const SESSION = 'sess_8c41f2d0'
const INSTANCE = '0b6f9d2e-41a7-4c3e-9f58-2d7c1e6a0b93'
const BASE = 7_200_000_000
const SEAL_MS = 15_000
const U64 = (1n << 64n) - 1n

type Record_ =
  | { readonly kind: 'run'; readonly runs: readonly RunInput[] }
  | { readonly kind: 'mark'; readonly marks: readonly MarkInput[] }
  | { readonly kind: 'stream-end'; readonly ends: readonly StreamEndInput[] }
  | { readonly kind: 'json'; readonly json: Record<string, unknown>; readonly raw: Uint8Array[] }

interface Spec {
  readonly seq?: number
  readonly first?: number
  readonly conn: readonly BodyConn[]
  readonly trk: readonly BodyTrack[]
  readonly records: readonly Record_[]
}

function build(p: Spec): Uint8Array {
  const seq = p.seq ?? 0
  const first = p.first ?? 0
  const frames = new FrameWriter()
  frames.json(
    batchJson({
      sessionId: SESSION,
      instanceId: INSTANCE,
      seq,
      idempotencyKey: idempotencyKey(SESSION, INSTANCE, seq),
      final: false,
      lvl: 'baseline',
      clk: {
        baseUs: BASE,
        epoch: 0,
        resUs: 5,
        sample: {
          oUs: 1_761_696_000_000_000 - BASE + 41_500,
          rUs: 18_250,
          atUs: BASE - 2_000_000,
          pop: 'LHR',
        },
      },
      tail: {
        lastRseq: first + p.records.length - 1,
        preDrop: { records: 0, objects: 0 },
        conn: [],
      },
      conn: p.conn,
      trk: p.trk,
    }),
  )
  p.records.forEach((r, i) => {
    const rseq = first + i
    if (r.kind === 'run') {
      frames.json({ t: 'run', v: 2, n: r.runs.length, rseq } as unknown as EnvelopeRecord)
      frames.raw(encodeRuns(BASE, r.runs))
    } else if (r.kind === 'mark') {
      frames.json({ t: 'mark', v: 1, n: r.marks.length, rseq } as unknown as EnvelopeRecord)
      frames.raw(encodeMarks(BASE, r.marks))
    } else if (r.kind === 'stream-end') {
      frames.json({ t: 'stream-end', v: 1, n: r.ends.length, rseq } as unknown as EnvelopeRecord)
      frames.raw(encodeStreamEnds(BASE, r.ends))
    } else {
      const one = new FrameWriter()
      one.json(r.json as unknown as EnvelopeRecord)
      const bytes = one.take()
      const payload = withRseq(bytes.subarray(4), rseq)
      const framed = new Uint8Array(4 + payload.byteLength)
      new DataView(framed.buffer).setUint32(0, payload.byteLength, false)
      framed.set(payload, 4)
      frames.append(framed, 1)
      for (const raw of r.raw) frames.raw(raw)
    }
  })
  const preamble = preambleFrame({
    i: INSTANCE,
    em: p.records.length === 0 ? [] : [[first, p.records.length]],
    seal: {
      seq,
      fromUs: BASE + seq * SEAL_MS * 1000,
      throughUs: BASE + (seq + 1) * SEAL_MS * 1000,
      ms: SEAL_MS,
    },
  })
  return contractBody(preamble, frames.take(), false)
}

const ids = (from: bigint, n: number) => Array.from({ length: n }, (_, i) => from + BigInt(i))
const times = (t0: number, step: number, n: number) =>
  Array.from({ length: n }, (_, i) => t0 + i * step)

const VCONN: BodyConn = { c: 0, draft: 20, relay: 'https://relay-a.example.net' }
const alias = (id: number, v: string): BodyTrack => ({ id, key: { d: 'rx', k: 'alias', v, e: 0 } })
const fetchKey = (id: number, v: string): BodyTrack => ({
  id,
  key: { d: 'tx', k: 'fetch', v, e: 0 },
})

const SPECS: Record<string, Spec> = {
  basic: {
    conn: [VCONN],
    trk: [alias(0, '1'), alias(1, '2')],
    records: [
      {
        kind: 'json',
        json: { t: 'ctrl', c: 0, dir: 'tx' },
        raw: [new Uint8Array([0x03, 0x00, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05])],
      },
      {
        kind: 'run',
        runs: [
          {
            c: 0,
            ti: 0,
            g: 100n,
            path: 'sub_stream',
            sub: 0n,
            sid: 3n,
            ids: ids(0n, 8),
            timesUs: times(BASE + 45_100.2, 33_333.3, 8),
            tlUs: BASE + 45_100.2 + 7 * 33_333.3 + 870,
            b: 41_210,
            fo: true,
            foKnown: true,
            eog: true,
            end: 'fin',
          },
          {
            c: 0,
            ti: 1,
            g: 100n,
            path: 'sub_stream',
            sub: 0n,
            sid: 7n,
            ids: ids(0n, 13),
            timesUs: times(BASE + 46_000, 20_000, 13),
            b: 2_080,
            fo: true,
            foKnown: true,
            end: 'fin',
          },
          {
            c: 0,
            ti: 0,
            g: 101n,
            path: 'sub_stream',
            sub: 0n,
            sid: 11n,
            ids: ids(0n, 2),
            timesUs: times(BASE + 311_900, 33_333.3, 2),
            b: 9_870,
            fo: true,
            foKnown: true,
          },
        ],
      },
    ],
  },
  'zero-length-normal': {
    conn: [
      { c: 0, draft: 8, relay: 'https://relay-a.example.net' },
      { c: 1, draft: 14, relay: 'https://relay-a.example.net' },
      { c: 2, draft: 20, relay: 'https://relay-a.example.net' },
    ],
    trk: [alias(0, '1'), fetchKey(1, '4')],
    records: [
      {
        kind: 'run',
        runs: [0, 1, 2].flatMap((c): RunInput[] => [
          {
            c,
            ti: 0,
            g: 9n,
            path: 'sub_stream',
            sub: 1n,
            sid: BigInt(2 + c * 4),
            ids: ids(0n, 3),
            timesUs: times(BASE + 100 + c, 1_000, 3),
            b: 0,
            end: 'fin',
          },
          {
            c,
            ti: 0,
            g: 9n,
            path: 'datagram',
            sub: null,
            ids: [3n],
            timesUs: [BASE + 4_000 + c],
            b: 0,
          },
          {
            c,
            ti: 1,
            g: 8n,
            path: 'fetch',
            sid: BigInt(3 + c * 4),
            ids: ids(0n, 2),
            osub: [0n, null],
            timesUs: times(BASE + 5_000 + c, 10, 2),
            b: 0,
            end: 'fin',
          },
        ]),
      },
    ],
  },
  'datagram-arrival-order': {
    conn: [VCONN],
    trk: [alias(0, '1')],
    records: [
      {
        kind: 'run',
        runs: [
          {
            c: 0,
            ti: 0,
            g: 40n,
            path: 'datagram',
            sub: null,
            ids: [5n, 3n, 4n, 4n, 9n],
            timesUs: times(BASE + 1_000, 1_000, 5),
            b: 500,
            eog: true,
          },
        ],
      },
    ],
  },
  'fetch-paths': {
    conn: [
      VCONN,
      { c: 1, draft: 14, relay: 'https://relay-b.example.net' },
      { c: 2, draft: 22, relay: 'https://relay-c.example.net' },
    ],
    trk: [fetchKey(0, '6'), fetchKey(1, '9'), alias(2, '3')],
    records: [
      {
        kind: 'run',
        runs: [
          {
            c: 0,
            ti: 0,
            g: 11n,
            path: 'fetch',
            sid: 14n,
            ids: ids(0n, 3),
            osub: [0n, 0n, 1n],
            timesUs: times(BASE + 10_000, 120, 3),
            b: 3_000,
          },
          {
            c: 0,
            ti: 0,
            g: 10n,
            path: 'fetch',
            sid: 14n,
            ids: [0n, 2n],
            osub: [0n, 0n],
            timesUs: times(BASE + 10_400, 120, 2),
            b: 2_000,
            end: 'fin',
          },
          {
            c: 1,
            ti: 1,
            g: 77n,
            path: 'fetch_joining',
            sid: 6n,
            ids: ids(0n, 2),
            osub: [0n, 0n],
            timesUs: times(BASE + 20_000, 300, 2),
            b: 800,
            end: 'fin',
          },
          {
            c: 2,
            ti: 2,
            g: 500n,
            path: 'fill',
            sid: 22n,
            ids: ids(4n, 2),
            osub: [null, 3n],
            timesUs: times(BASE + 30_000, 50, 2),
            b: 90,
            end: 'fin',
          },
        ],
      },
    ],
  },
  'reset-cont-negative': {
    seq: 2,
    first: 30,
    conn: [VCONN],
    trk: [alias(0, '1')],
    records: [
      {
        kind: 'run',
        runs: [
          {
            c: 0,
            ti: 0,
            g: 7n,
            path: 'sub_stream',
            sub: 0n,
            sid: 3n,
            ids: ids(4n, 3),
            timesUs: [BASE + 5_000, BASE + 4_900.7, BASE + 5_250],
            tlUs: BASE + 4_000,
            b: 30,
            end: 'reset',
            rc: 0x10n,
            cont: true,
          },
          {
            c: 0,
            ti: 0,
            g: 8n,
            path: 'sub_stream',
            sub: 0n,
            sid: 7n,
            ids: ids(0n, 2),
            timesUs: [BASE + 1_000, BASE + 2_000],
            b: 20,
          },
        ],
      },
    ],
  },
  marks: {
    conn: [
      { c: 0, draft: 22, relay: 'https://relay-a.example.net' },
      { c: 1, draft: 8, relay: 'https://relay-a.example.net' },
      { c: 2, draft: 7, relay: 'https://relay-a.example.net' },
    ],
    trk: [alias(0, '1'), fetchKey(1, '2')],
    records: [
      {
        kind: 'mark',
        marks: [
          {
            kind: 'rng_nx',
            c: 0,
            ti: 1,
            g: 10n,
            o: 0n,
            g2: 12n,
            o2: 4n,
            n: 0n,
            tUs: BASE + 100,
            path: 'fetch',
            sid: 14n,
          },
          {
            kind: 'rng_to',
            c: 0,
            ti: 1,
            g: 13n,
            o: 9n,
            g2: 13n,
            o2: 9n,
            n: 1n,
            tUs: BASE + 90,
            path: 'fetch',
            sid: 18n,
          },
          {
            kind: 'pgg',
            c: 0,
            ti: 0,
            g: 20n,
            o: 0n,
            n: 3n,
            tUs: BASE + 500,
            path: 'sub_stream',
            sid: 3n,
          },
          { kind: 'pog', c: 0, ti: 0, g: 20n, o: 5n, n: 2n, tUs: BASE + 520, path: 'datagram' },
          {
            kind: 'status_unknown',
            c: 0,
            ti: 0,
            g: 20n,
            o: 6n,
            n: 9n,
            tUs: BASE + 530,
            path: 'sub_stream',
            sid: 3n,
          },
          { kind: 'eot', c: 0, ti: 0, g: 20n, o: 7n, tUs: BASE + 540, path: 'sub_stream', sid: 3n },
          { kind: 'eotg', c: 1, ti: 0, g: 4n, o: 9n, tUs: BASE + 600, path: 'sub_stream', sid: 2n },
          { kind: 'dne', c: 1, ti: 0, g: 4n, o: 2n, tUs: BASE + 610, path: 'sub_stream', sid: 2n },
          { kind: 'eosg', c: 2, ti: 0, g: 1n, o: 3n, tUs: BASE + 700, path: 'sub_stream', sid: 6n },
        ],
      },
    ],
  },
  'stream-ends': {
    seq: 1,
    first: 8,
    conn: [VCONN, { c: 1, draft: 23, relay: 'https://relay-b.example.net' }],
    trk: [alias(0, '1'), fetchKey(1, '5'), fetchKey(2, '6')],
    records: [
      {
        kind: 'stream-end',
        ends: [
          {
            end: 'fin',
            c: 0,
            ti: 0,
            path: 'sub_stream',
            sid: 11n,
            g: 101n,
            o: 1n,
            tUs: BASE + 200,
          },
          {
            end: 'fin',
            eog: true,
            c: 0,
            ti: 0,
            path: 'sub_stream',
            sid: 15n,
            g: 102n,
            tUs: BASE + 300,
          },
          { end: 'reset', c: 0, ti: 1, path: 'fetch', sid: 19n, rc: 0x2n, tUs: BASE + 250 },
          {
            end: 'none',
            eog: true,
            c: 1,
            ti: 2,
            path: 'fill',
            sid: 6n,
            g: 40n,
            o: 7n,
            tUs: BASE + 400,
          },
          { end: 'fin', c: 1, ti: 2, path: 'fill', sid: 6n, g: 41n, o: 2n, tUs: BASE + 900 },
        ],
      },
    ],
  },
  ident: {
    conn: [VCONN],
    trk: [],
    records: [
      {
        kind: 'json',
        json: {
          t: 'ident',
          v: 1,
          at_us: BASE + 10,
          content: 'movie-42',
          env: 'prod',
          release: '4.2.1',
          tags: { plan: 'pro', region: 'eu' },
        },
        raw: [],
      },
      {
        kind: 'json',
        json: { t: 'ident', v: 1, at_us: BASE + 9_000_000, actor: 'u_19f2', tags: { ab: 'b' } },
        raw: [],
      },
      { kind: 'json', json: { t: 'ident', v: 1, at_us: BASE + 12_000_000, content: '' }, raw: [] },
    ],
  },
  'unknown-draft-unseen-fetch': {
    conn: [
      { c: 0, relay: 'https://relay-a.example.net' },
      { c: 1, draft: 14, relay: 'https://relay-a.example.net' },
    ],
    trk: [alias(0, '1'), fetchKey(1, '3')],
    records: [
      {
        kind: 'run',
        runs: [
          {
            c: 0,
            ti: 0,
            g: 3n,
            path: 'sub_stream',
            sub: 0n,
            sid: 3n,
            ids: ids(0n, 2),
            timesUs: times(BASE + 1_000, 33_333, 2),
            b: 900,
            fo: true,
            foKnown: true,
            end: 'fin',
          },
          {
            c: 1,
            ti: 1,
            g: 9n,
            path: 'fetch_unseen',
            sid: 7n,
            ids: ids(0n, 3),
            osub: [0n, 0n, 0n],
            timesUs: times(BASE + 2_000, 100, 3),
            b: 300,
            end: 'fin',
          },
        ],
      },
    ],
  },
  'u64-ids': {
    conn: [VCONN],
    trk: [alias(0, U64.toString())],
    records: [
      {
        kind: 'run',
        runs: [
          {
            c: 0,
            ti: 0,
            g: U64,
            path: 'sub_stream',
            sub: U64 - 1n,
            sid: (1n << 62n) - 1n,
            ids: [U64 - 1n, U64],
            timesUs: times(BASE, 10, 2),
            b: 2,
            end: 'fin',
          },
        ],
      },
    ],
  },
}

interface ManifestEntry {
  readonly name: string
  readonly file: string
  readonly expect: { readonly ok: boolean }
}

const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as {
  readonly fixtures: readonly ManifestEntry[]
}

describe('v2 viewer goldens', () => {
  it('rebuilds every accepted fixture, and only those', () => {
    const accepted = manifest.fixtures.filter((f) => f.expect.ok).map((f) => f.name)
    expect(Object.keys(SPECS).sort()).toEqual([...accepted].sort())
  })

  for (const [name, spec] of Object.entries(SPECS)) {
    it(`${name} reads back as its inputs`, async () => {
      const entry = manifest.fixtures.find((f) => f.name === name)!
      const facts = await factsOf(new Uint8Array(readFileSync(join(DIR, entry.file))))
      const want = spec.records.flatMap((r) => (r.kind === 'run' ? r.runs : []))
      expect(facts.runs.map((r) => [r.path, r.g, r.ids, r.b])).toEqual(
        want.map((r) => [r.path, r.g, r.ids, r.b]),
      )
      const marks = spec.records.flatMap((r) => (r.kind === 'mark' ? r.marks : []))
      expect(facts.marks.map((m) => [m.kind, m.g, m.o, m.n])).toEqual(
        marks.map((m) => [m.kind, m.g, m.o, m.n ?? null]),
      )
      const ends = spec.records.flatMap((r) => (r.kind === 'stream-end' ? r.ends : []))
      expect(facts.ends.map((e) => [e.end, e.eog, e.path, e.sid, e.g, e.o, e.tUs, e.rc])).toEqual(
        ends.map((e) => [
          e.end,
          e.eog === true,
          e.path,
          e.sid,
          e.g ?? null,
          e.o ?? null,
          e.tUs,
          e.rc ?? null,
        ]),
      )
    })

    it(`${name} is byte for byte the golden`, () => {
      const entry = manifest.fixtures.find((f) => f.name === name)!
      const golden = new Uint8Array(readFileSync(join(DIR, entry.file)))
      expect(Buffer.from(build(spec)).equals(Buffer.from(golden))).toBe(true)
    })
  }
})
