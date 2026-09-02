/**
 * Rebuilds `manifest.json`, the corpus index.
 *
 *     bun run src/__tests__/corpus/manifest.ts
 *
 * Run it after either generator. The counts are read back off the files
 * rather than declared, so the manifest cannot claim a shape the bytes do not
 * have — and because it is committed, regenerating the files without
 * regenerating this fails the corpus test instead of drifting quietly.
 *
 * Descriptions live here rather than in the JSON because the JSON is
 * generated. Adding a case means adding a row to `DESCRIPTIONS` and running
 * this; a directory with no row is reported rather than silently indexed,
 * since an undescribed corpus case is one nobody can tell the purpose of.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readMoqtraceSegments, TruncatedTraceError } from '../../binary.js'
import type { Trace } from '../../types.js'
import { CORPUS_MISSING_MESSAGE, findCorpusDir } from './locate.js'

/** What each case is for, and why the corpus would be weaker without it. */
const DESCRIPTIONS: Record<string, string> = {
  'v1-basic':
    'A version-1 file: only the keys and event types version 1 defined. Readers must accept it — SPEC.md requires both versions — and a reader that rejected it would strand every capture taken before the bump.',
  'v2-basic':
    'A non-segmented version-2 file exercising every event type, with a relay-tap perspective so every event carries "p". Timestamps and two identifiers sit past 2^32, where the integer-not-float rule bites.',
  'v2-segmented':
    'Three segments of one stream. Segmentation is the sole reason version 2 exists: a version-1 reader decodes the second segment magic as a CBOR byte string and desynchronizes with no way to recover.',
  'v2-unknown-event':
    'An event type (99) no reader knows, between two it does. It must survive a read-modify-write with its fields intact, or one tool ignorance becomes permanent for everything downstream.',
  'v2-unknown-perspective':
    'A perspective ("sidecar") and protocol identifier ("moq-transport-rfc9999") outside the sets this revision names. Both may change without a version bump, so both must read.',
  'v2-extra-keys':
    'Known event types carrying keys no reader knows, and no reader ever will: every key is "x-" prefixed, the range SPEC.md reserves for private use. The fixture borrowed keys from PROPOSAL-v3 until §2 shipped and claimed two of them, turning the dedicated assertions red — which invited weakening them rather than replacing the fixture. One value is a nested map holding a byte string, a further map and an array, because preservation has to be structural — a shallow copy passes every flat assertion and loses that one.',
  'v2-truncated':
    'A file that stops mid-event, as a capture killed at the wrong moment does. Readers must report the truncation distinctly and still return everything that decoded before the cut.',
  'v2-control-msg-map':
    'The three shapes a conforming "msg" takes: a populated snake_case map carrying an integer, an integer and a byte string; an empty map for a message the recorder decoded nothing from; and a nested map, because preserving a map has to mean the whole tree. The fourth shape, a "msg" that is not a map, needs no case of its own — every capture-* file carries a Rust debug string there.',
  'v2-headers-level-flow':
    'A headers-level trace where the stream-header identifiers are the only way to group anything: "sg" on a subgroup stream, "fri" on a fetch, "g" on a datagram, and "ta" on each. Before those keys a "headers" recording could not say which track a stream belonged to, which is most of what the level is for. The three streams share a track alias deliberately — legal, ordinary, and why "ta" alone cannot key a flow.',
  'v2-header-extra':
    'The only file in the corpus carrying an unrecognised key in the *header*. Without it the three header stores — the header map, "segment" and "sampling" — could be deleted outright and every corpus test would stay green, a round trip being a reader checked against its own encoder. "x-scope" sits in all three maps with three different values, so a reader that merged them emits the segment private key at the top level and is caught here; "transport": 42 reaches a store through the ordinary field path, being a defined key whose value no reader can use; and "x-scale" (an integral float) and "x-blob" (a byte string under tag 64) are the two shapes SPEC.md requires a writer to normalise inside a store — the one place the two implementations could silently differ, cbor-x being unable to represent either distinction.',
  'v2-msg-absent':
    'Control messages with no "msg" key at all, which SPEC.md now forbids a writer to produce. Readers must keep the events regardless: Event 0 is a type sampling MUST NOT drop, so rejecting the omission discards exactly what the format promises to keep. The shipped Rust reader did that until this case existed. JavaScript-authored only, since neither writer emits it.',
  'v2-float-ints':
    'The v2-basic content with integers past 2^32 written as CBOR float64 — what cbor-x emits by default. SPEC.md requires readers to accept this form because files carrying it exist. JavaScript-authored only: ciborium will not emit it.',
  'v2-tag64':
    'The v2-basic content with byte strings wrapped in RFC 8746 tag 64 — what cbor-x emitted before this package configured it not to. Readers must accept it, for the same reason. JavaScript-authored only.',
  'capture-client-draft16-moq-rs':
    'A real client-perspective session against cloudflare/moq-rs on draft-16, recorded by `moqtap peek`. Control messages, state changes and annotations, none of it designed to be readable.',
  'capture-observer-draft16-moq-rs':
    'A real proxy-perspective capture of a subgroup delivery from moq-rs on draft-16, recorded by `moqtap intercept`: 52 object headers on one track. Every data event declares stream 0, which is what PROPOSAL-v3 §1 is about.',
  'capture-observer-draft18-moq-rs':
    'The same against moq-rs on draft-18, where each request takes its own bidirectional stream: four stream-opened events all declaring stream 0, plus an error event. The unified SETUP message type (0x2F00) appears here and nowhere else in the corpus.',
  'capture-client-draft19-imquic':
    'A real client-perspective session against meetecho/imquic on draft-19 — a C implementation over picoquic, and the newest draft any peer in the interop set speaks.',
}

/** Which tool wrote a file, inferred from its name. */
const WRITERS: Record<string, string> = {
  'js.moqtrace': '@moqtap/trace',
  'rust.moqtrace': 'moqtap-trace',
  'capture.moqtrace': 'moqtap CLI, against a third-party relay',
}

const VERSION_OFFSET = 8

interface CaseEntry {
  id: string
  description: string
  files: { name: string; writer: string; bytes: number }[]
  version: number
  segments: number
  truncated: boolean
  protocol: string
  perspective: string
  detail: string
  eventCount: number
  /** Event type discriminant to number of events carrying it. */
  eventTypes: Record<string, number>
}

function declaredVersion(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    VERSION_OFFSET,
    true,
  )
}

/** Wire discriminant for an event, including the ones only a file knows. */
const EVENT_TYPE_IDS: Record<string, number> = {
  control: 0,
  'stream-opened': 1,
  'stream-closed': 2,
  'object-header': 3,
  'object-payload': 4,
  'state-change': 5,
  error: 6,
  annotation: 7,
  'peer-connected': 8,
  'peer-disconnected': 9,
  'subscription-derivation': 10,
}

function readSegmentsTolerantly(bytes: Uint8Array): { segments: Trace[]; truncated: boolean } {
  try {
    return { segments: readMoqtraceSegments(bytes), truncated: false }
  } catch (error) {
    if (error instanceof TruncatedTraceError) {
      return { segments: error.segments, truncated: true }
    }
    throw error
  }
}

function describe(id: string, dir: string): CaseEntry {
  const description = DESCRIPTIONS[id]
  if (description == null) throw new Error(`corpus case '${id}' has no description`)

  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.moqtrace'))
    .sort()
  if (names.length === 0) throw new Error(`corpus case '${id}' has no .moqtrace file`)

  const files = names.map((name) => {
    const writer = WRITERS[name]
    if (writer == null) throw new Error(`corpus case '${id}': unexpected file '${name}'`)
    return { name, writer, bytes: statSync(join(dir, name)).size }
  })

  // The first file, alphabetically, describes the case. Every file in a case
  // carries the same content — that is what the corpus test asserts — so any
  // of them would give the same answer.
  const bytes = new Uint8Array(readFileSync(join(dir, names[0] as string)))
  const { segments, truncated } = readSegmentsTolerantly(bytes)
  const first = segments[0]
  if (first == null) throw new Error(`corpus case '${id}' decoded to no segments`)
  const events = segments.flatMap((segment) => segment.events)

  const eventTypes: Record<string, number> = {}
  for (const event of events) {
    const key = String(event.type === 'unknown' ? event.eventType : EVENT_TYPE_IDS[event.type])
    eventTypes[key] = (eventTypes[key] ?? 0) + 1
  }

  return {
    id,
    description,
    files,
    version: declaredVersion(bytes),
    segments: segments.length,
    truncated,
    protocol: first.header.protocol,
    perspective: first.header.perspective,
    detail: first.header.detail,
    eventCount: events.length,
    eventTypes,
  }
}

function main(): void {
  const root = findCorpusDir()
  if (root == null) throw new Error(CORPUS_MISSING_MESSAGE)

  const cases = readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort()
    .map((name) => describe(name, join(root, name)))

  const manifest = {
    schema_version: 1,
    spec: 'moqtrace',
    description:
      'Shared .moqtrace conformance corpus. Every file here is read by both @moqtap/trace and moqtap-trace; files of the same case carry identical content written by different encoders. An implementation that cannot round-trip the corpus is not conformant.',
    cases,
  }

  const path = join(root, 'manifest.json')
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`${path}  ${cases.length} cases`)
}

main()
