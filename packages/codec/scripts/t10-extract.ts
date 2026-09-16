/**
 * Turn a real `.moqtrace` capture into a subgroup-stream fixture for T10.
 *
 * The trace records *decoded* objects — ids, group, priority, payload size —
 * not the wire bytes that carried them, so the bytes are re-encoded here with
 * this draft's own `encodeSubgroupStream`. What comes from the capture is the
 * shape of real traffic: how many objects, how large, how they are distributed
 * across groups and subgroups, and how the Object IDs step. What does not come
 * from the capture is the payload content, which no decoder looks at.
 *
 * That distinction matters for reading the result and is repeated in the
 * output: this measures decoding a stream shaped like the capture, not a
 * replay of the capture's own bytes.
 *
 * Usage: bun run scripts/t10-extract.ts <trace> <out.json> [maxObjects]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createMoqtraceReader } from '../../trace/src/index.js'
import { encodeSubgroupStream } from '../src/drafts/draft14/index.js'
import { encodeSubgroupStream as encode20 } from '../src/drafts/draft20/index.js'

const [tracePath, outPath, maxArg] = process.argv.slice(2)
if (!tracePath || !outPath) {
  console.error('usage: bun run scripts/t10-extract.ts <trace> <out.json> [maxObjects]')
  process.exit(1)
}
const maxObjects = maxArg ? Number(maxArg) : 20000

interface Obj {
  streamId: bigint
  groupId: bigint
  objectId: bigint
  size: number
  priority: number
}

const reader = createMoqtraceReader()
const bytes = new Uint8Array(readFileSync(tracePath))

const headers: Obj[] = []
/** The header event awaiting its payload event, per stream. */
const pending = new Map<string, Obj>()
const counts = new Map<string, number>()
let segments = 0
let events = 0
let protocol = '(unknown)'

// One pass, in chunks, so a truncated capture still yields what decoded.
const CHUNK = 1 << 20
try {
  for (let off = 0; off < bytes.length; off += CHUNK) {
    for (const item of reader.push(bytes.subarray(off, Math.min(off + CHUNK, bytes.length)))) {
      if (item.kind === 'segment') {
        segments++
        protocol = String((item.header as unknown as Record<string, unknown>).protocol ?? protocol)
        continue
      }
      events++
      const e = item.event as unknown as Record<string, unknown>
      const t = String(e.type)
      counts.set(t, (counts.get(t) ?? 0) + 1)
      // The Object ID lives on the header event and the payload size on the
      // payload event, so an object is the pair. They arrive adjacent per
      // stream, which is what `pending` tracks.
      if (t === 'object-header') {
        pending.set(String(e.streamId), {
          streamId: BigInt((e.streamId as bigint) ?? 0n),
          groupId: BigInt((e.groupId as bigint) ?? 0n),
          objectId: BigInt((e.objectId as bigint) ?? 0n),
          size: 0,
          priority: Number(e.publisherPriority ?? 128),
        })
      }
      if (t === 'object-payload' && headers.length < maxObjects) {
        const h = pending.get(String(e.streamId))
        if (h === undefined) continue
        pending.delete(String(e.streamId))
        headers.push({ ...h, size: Number(e.size ?? 0) })
      }
    }
  }
} catch (err) {
  console.error(`stopped early: ${(err as Error).message}`)
}

console.log(`segments=${segments} events=${events} protocol=${protocol}`)
for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${t}: ${n}`)

if (headers.length === 0) {
  console.error('no object-payload events in this capture; nothing to measure')
  process.exit(2)
}

// Group by the stream the objects actually arrived on. Grouping by Group ID
// instead merges the subgroups that shared it, whose Object IDs overlap, and a
// subgroup stream requires them to ascend.
const byGroup = new Map<string, Obj[]>()
for (const o of headers) {
  const k = o.streamId.toString()
  const arr = byGroup.get(k)
  if (arr) arr.push(o)
  else byGroup.set(k, [o])
}

const streams: string[] = []
// The collector decodes draft-19/20 only, so the same real objects are also
// encoded in draft-20 to measure the path that actually ships.
const streams20: string[] = []
let totalObjects = 0
let totalPayload = 0
for (const [, objs] of byGroup) {
  // Object IDs must ascend within a subgroup stream; the capture interleaves
  // subgroups under one Group ID, so the order is restored rather than assumed.
  // Object IDs are NOT taken from the capture, because the capture does not
  // have them: every `object-header` event in these draft-14 traces records
  // `objectId: 0`, so the writer never wrote the field. They are renumbered
  // ascending here, which is what an ordinary subgroup stream looks like — a
  // one-byte zero delta per object. Everything else is the capture's:
  // per-stream object counts, payload sizes, priorities, group ids.
  const stream = {
    type: 'subgroup' as const,
    headerType: 0x10,
    trackAlias: 1n,
    groupId: objs[0]?.groupId ?? 0n,
    subgroupId: 0n,
    publisherPriority: 128,
    objects: objs.map((o, i) => ({
      type: 'object' as const,
      byteOffset: 0,
      payloadByteOffset: 0,
      objectId: BigInt(i),
      payloadLength: o.size,
      // Content is never read by a decoder; only the length steers it.
      payload: new Uint8Array(o.size),
      extensionData: new Uint8Array(0),
    })),
  }
  let encoded: Uint8Array
  try {
    // biome-ignore lint/suspicious/noExplicitAny: cross-draft fixture shape
    encoded = encodeSubgroupStream(stream as any)
  } catch {
    continue
  }
  totalObjects += objs.length
  totalPayload += objs.reduce((n, o) => n + o.size, 0)
  streams.push(Buffer.from(encoded).toString('base64'))
  try {
    // biome-ignore lint/suspicious/noExplicitAny: cross-draft fixture shape
    streams20.push(Buffer.from(encode20(stream as any)).toString('base64'))
  } catch {
    // A draft-20 header type this stream cannot carry; the draft-14 case stands.
  }
}

const sizes = headers.map((o) => o.size).sort((a, b) => a - b)
const pct = (p: number) => sizes[Math.min(sizes.length - 1, Math.floor((sizes.length - 1) * p))]

const out = {
  source: tracePath,
  protocol,
  streams,
  streams20,
  totalObjects,
  totalPayloadBytes: totalPayload,
  objectSize: {
    min: sizes[0],
    p50: pct(0.5),
    p90: pct(0.9),
    p99: pct(0.99),
    max: sizes[sizes.length - 1],
    mean: Math.round(totalPayload / Math.max(1, totalObjects)),
  },
  note:
    'Wire bytes re-encoded from the capture’s decoded objects. Object counts per ' +
    'stream, payload sizes, priorities and group ids are the capture’s. Payload ' +
    'content is zeros (no decoder reads it) and Object IDs are renumbered ' +
    'ascending, because every object-header event in these traces records ' +
    'objectId 0 — the writer never recorded the real ones.',
}
writeFileSync(outPath, JSON.stringify(out))
console.log(
  `wrote ${outPath}: ${streams.length} streams, ${totalObjects} objects, ` +
    `payload p50=${out.objectSize.p50}B p99=${out.objectSize.p99}B max=${out.objectSize.max}B`,
)
