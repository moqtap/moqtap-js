/**
 * Writes this package's half of the shared `.moqtrace` corpus.
 *
 *     bun run src/__tests__/corpus/generate.ts
 *
 * The Rust half comes from `cargo run -p moqtap-trace --example
 * generate_corpus`. Run both after changing `cases.ts`, and commit the bytes:
 * the corpus test compares the two files, so regenerating only one turns a
 * deliberate change into a failure that names the file nobody updated.
 *
 * Four of the files here cannot come from the normal writer, and each exists
 * because a reader has to cope with something this package no longer emits:
 *
 *   - `v1-basic`      declares version 1, which the writer stopped writing.
 *   - `v2-truncated`  stops mid-event, as a capture killed at the wrong
 *                     moment does.
 *   - `v2-float-ints` encodes integers past 2^32 as float64, as cbor-x did
 *                     before this package configured it not to.
 *   - `v2-tag64`      wraps byte strings in RFC 8746 tag 64, as cbor-x did
 *                     before the same fix.
 *
 * The last two are the two encoding conventions SPEC.md makes normative, in
 * the wrong form. Files written that way exist, so a conformant reader accepts
 * them — and until now nothing checked that.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Encoder } from 'cbor-x'
import { writeMoqtrace, writeMoqtraceSegments } from '../../binary.js'
import { cborItemLength } from '../../cbor-scan.js'
import { AUTHORED_CASES, SEGMENTED_CASES, v2Basic } from './cases.js'
import { CORPUS_MISSING_MESSAGE, findCorpusDir } from './locate.js'

/** Byte offset of the format version in a segment preamble. */
const VERSION_OFFSET = 8
/** Magic (8) + version (4) + header length (4). */
const PREAMBLE_SIZE = 16

function write(dir: string, caseName: string, file: string, bytes: Uint8Array): void {
  const caseDir = join(dir, caseName)
  mkdirSync(caseDir, { recursive: true })
  writeFileSync(join(caseDir, file), bytes)
  console.log(`${caseName}/${file}  ${bytes.length} bytes`)
}

/**
 * Restamp a file's declared version.
 *
 * A version-1 file is byte-for-byte a version-2 file that happens to carry
 * none of the keys version 2 added — SPEC.md says exactly that — so this is
 * the whole difference, not an approximation of one.
 */
function withVersion(bytes: Uint8Array, version: number): Uint8Array {
  const copy = new Uint8Array(bytes)
  new DataView(copy.buffer).setUint32(VERSION_OFFSET, version, true)
  return copy
}

/** The CBOR items of a single-segment file: its header, then each event. */
function splitItems(file: Uint8Array): { preamble: Uint8Array; items: Uint8Array[] } {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const headerLength = view.getUint32(12, true)
  const items = [file.subarray(PREAMBLE_SIZE, PREAMBLE_SIZE + headerLength)]

  let offset = PREAMBLE_SIZE + headerLength
  while (offset < file.length) {
    const length = cborItemLength(file, offset)
    if (length == null) throw new Error(`incomplete CBOR item at byte ${offset}`)
    items.push(file.subarray(offset, offset + length))
    offset += length
  }
  return { preamble: file.subarray(0, PREAMBLE_SIZE), items }
}

/**
 * Re-encode every CBOR item of a file with a different encoder, keeping the
 * values but changing how they are written.
 *
 * The header length in the preamble is rewritten to match, since the header
 * is one of the items being re-encoded and its length changes.
 */
function reencode(
  file: Uint8Array,
  encoder: Encoder,
  mapValue: (value: unknown) => unknown,
): Uint8Array {
  const source = new Encoder({ useRecords: false, mapsAsObjects: true, tagUint8Array: false })
  const { preamble, items } = splitItems(file)
  const encoded = items.map((item) => encoder.encode(mapValue(source.decode(item))) as Uint8Array)

  // items[0] is the header; the preamble's length field must follow it.
  const header = encoded[0]
  if (header == null) throw new Error('a file with no header cannot be re-encoded')

  const total = preamble.length + encoded.reduce((sum, item) => sum + item.length, 0)
  const out = new Uint8Array(total)
  out.set(preamble, 0)
  let offset = preamble.length
  for (const item of encoded) {
    out.set(item, offset)
    offset += item.length
  }
  new DataView(out.buffer).setUint32(12, header.length, true)
  return out
}

/** Every bigint becomes a Number, so cbor-x writes the large ones as float64. */
function bigintsToNumbers(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) return value.map(bigintsToNumbers)
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, bigintsToNumbers(v)]),
    )
  }
  return value
}

const identity = (value: unknown): unknown => value

function main(): void {
  const dir = findCorpusDir()
  if (dir == null) throw new Error(CORPUS_MISSING_MESSAGE)
  console.log(`corpus: ${dir}`)

  for (const [name, trace] of Object.entries(AUTHORED_CASES)) {
    const bytes = writeMoqtrace(trace)
    write(dir, name, 'js.moqtrace', name === 'v1-basic' ? withVersion(bytes, 1) : bytes)
  }

  for (const [name, segments] of Object.entries(SEGMENTED_CASES)) {
    write(dir, name, 'js.moqtrace', writeMoqtraceSegments(segments))
  }

  const basic = writeMoqtrace(v2Basic)

  // Three bytes short of the end. The last event is longer than that, so the
  // cut is guaranteed to land inside it rather than on a clean boundary.
  write(dir, 'v2-truncated', 'js.moqtrace', basic.subarray(0, basic.length - 3))

  write(
    dir,
    'v2-float-ints',
    'js.moqtrace',
    reencode(
      basic,
      new Encoder({ useRecords: false, mapsAsObjects: true, tagUint8Array: false }),
      bigintsToNumbers,
    ),
  )

  write(
    dir,
    'v2-tag64',
    'js.moqtrace',
    // `tagUint8Array` left at its default, which is the whole point.
    reencode(basic, new Encoder({ useRecords: false, mapsAsObjects: true }), identity),
  )
}

main()
