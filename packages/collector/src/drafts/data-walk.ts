/**
 * The hand-rolled data-stream header walks, shared by all fourteen draft
 * adapters.
 *
 * No exported `@moqtap/codec` function reports a header's byte length without
 * materialising the payload, and this package's shape is "parse an object
 * header, update counters, discard" — O(1) memory per stream, payload bytes
 * skipped and never viewed. (Below `@moqtap/codec` 0.11.0
 * `createSubgroupStreamDecoder` is also wrong: a zero-length status object
 * desynchronises the stream silently.)
 *
 * Every reader takes a buffer and an offset, never throws, and returns
 * {@link NEED} when it cannot complete.
 *
 * {@link DraftAdapter}'s walk readers return `T | Need` with no failure variant,
 * so a structurally *invalid* header — a subgroup type outside the draft's set,
 * a fetch serialization flags value ≥ 0x80 that is not an End-of-Range marker, a
 * first fetch object missing its Group ID — is reported as `NEED` rather than as
 * a fault. The caller stays correct: the counting decoder caps unparsed header
 * slack at a few KB and declares `subgroup-desync` / `fetch-desync`, deferred by
 * up to that cap. Parsing on regardless would mean plausible wrong numbers
 * rather than a gap.
 *
 * One file for fourteen drafts because duplicating a wire-format constant has
 * already cost this workspace months
 * (`extension/src/detect/uni-control-prefix.ts`, where a duplicated `6f 00`
 * meant no draft-17+ control stream ever matched). Every delta is a named field
 * on {@link WalkDialect}, each read off that draft's own codec decoder and never
 * inferred from a neighbour: the wire is not monotonic, and the SUBGROUP_HEADER
 * stream type is a varint in draft-17, a single byte in draft-18 and draft-19,
 * and a varint again in draft-20.
 * `src/__tests__/drafts/walk-corpus.test.ts` holds every row there, walking
 * `@moqtap/test-vectors` and checking each object's ids, length and status
 * against the corpus — which a fixture built from our own encoder could not do.
 *
 * | drafts  | varints  | subgroup type | object ids | per-object block |
 * | ------- | -------- | ------------- | ---------- | ---------------- |
 * | 07      | RFC 9000 | `0x04` fixed  | absolute   | none             |
 * | 08      | RFC 9000 | `0x04` fixed  | absolute   | extension count  |
 * | 09-10   | RFC 9000 | `0x04` fixed  | absolute   | length, always   |
 * | 11-13   | RFC 9000 | flag ranges   | absolute   | length, bit 0    |
 * | 14-16   | RFC 9000 | flag ranges   | delta      | length, bit 0    |
 * | 17-20   | MoQT vi64| flag bits     | delta      | properties, bit 0|
 *
 * Imported **only** by `src/drafts/draftNN/index.ts`, each behind the dynamic
 * `import()` in `DRAFT_LOADERS`. Never re-export it from `src/draft/index.ts`:
 * that barrel is in the static graph, and pulling this file in moves per-draft
 * bytes into the static budget.
 */

import { NEED, type Need, type VarintValue } from '../draft/varint.js'
import type {
  FetchHeaderInfo,
  ObjectCursor,
  ObjectHeaderInfo,
  StreamKind,
  SubgroupHeaderInfo,
} from '../types.js'

/** A varint reader: buffer and offset in, value and next offset out. */
export type VarintFn = (b: Uint8Array, i: number) => VarintValue | Need

/**
 * How the optional per-object block is framed. Three encodings across the
 * drafts, and getting it wrong desynchronises the stream on the first object
 * rather than failing.
 */
export const BLOCK_NONE = 0
/** draft-08 only: a *count* of extension KVPs, each of which must be walked. */
export const BLOCK_COUNT = 1
/** A varint length and that many opaque bytes. Every draft from 09 on. */
export const BLOCK_LENGTH = 2

/** Whether the block is present at all, and on what condition. */
export const PRESENT_NEVER = 0
export const PRESENT_ALWAYS = 1
/** Bit 0 of the header type flags says so. */
export const PRESENT_BIT0 = 2

/**
 * Every place the fourteen drafts disagree on a data stream.
 *
 * One row per draft lives in `src/drafts/draftNN/index.ts`. Each field names the
 * codec decoder it was verified against; none was inferred from a neighbour.
 */
export interface WalkDialect {
  /* ── the varint family ────────────────────────────────────────────────── */

  /**
   * RFC 9000's 2-bit-prefix form for drafts 07-16, MoQT's leading-1-bits vi64
   * from draft-17 (`core/buffer-reader.ts`).
   *
   * The two **disagree on the same bytes** and the loser returns a plausible
   * wrong number rather than an error, which is why this is a field and not an
   * import: see `../draft/varint.ts`.
   */
  readonly readVarint: VarintFn

  /* ── control streams ──────────────────────────────────────────────────── */

  /**
   * First byte of a unidirectional control stream, or `-1` where the draft has
   * none.
   *
   * From draft-17 the control plane opens a unidirectional stream with SETUP's
   * type `0x2F00`, which in vi64 is `af 00`. Drafts 07-16 carry control on a
   * **bidirectional** stream the seam already stamps as control, so there is no
   * byte to sniff for and this is `-1`.
   */
  readonly controlOpener: number
  /**
   * Control frame length framing: a varint (drafts 07-10) or a 16-bit
   * big-endian field (drafts 11-20). `draft08/codec.ts` reads a varint payload
   * length; `draft11/codec.ts` reads two bytes and combines them. Reading one as
   * the other truncates or over-reads every control frame on the session.
   */
  readonly controlLengthIsVarint: boolean

  /* ── subgroup stream header ───────────────────────────────────────────── */

  /**
   * The stream type field's width. **Not monotonic across drafts** — varint in
   * 07-17, a single byte in 18 and 19, varint again in 20 (verified against each
   * draft's `readSubgroupHeader` / `decodeSubgroupStream`).
   */
  readonly subgroupTypeIsVarint: boolean
  /**
   * Whether a value is one of this draft's SUBGROUP_HEADER types.
   *
   * Five distinct shapes across the fourteen: `0x04` exactly (07-10),
   * `0x08-0x0D` (11), `0x10-0x15` plus `0x18-0x1D` (12-14), `0x10-0x1F` plus
   * `0x30-0x3F` with the reserved SUBGROUP_ID_MODE excluded (15-16), and
   * "under 0x80, bit 4 set, mode not reserved" (17-20).
   */
  readonly isSubgroupType: (v: number) => boolean
  /**
   * The Subgroup ID field is unconditionally present (drafts 07-10, which have
   * no type flags to make it conditional).
   *
   * From draft-11 it is present when bit 2 of the type is set. That single rule
   * covers 11 through 20: draft-17 onward spells it as SUBGROUP_ID_MODE `0b10`
   * in bits 2:1, which is `(t & 0x04) !== 0` for every value those drafts admit,
   * because the `0b11` mode is reserved and excluded by {@link isSubgroupType}.
   */
  readonly subgroupIdAlways: boolean
  /**
   * The Publisher Priority byte is unconditionally present (drafts 07-14).
   *
   * From draft-15 it is absent when bit 5 of the type is set — spelled
   * `streamType < 0x30` in `draft15/data-streams.ts` and `draft16`, and
   * DEFAULT_PRIORITY (`0x20`) from draft-17. The same bit, the same meaning.
   */
  readonly priorityAlways: boolean

  /* ── subgroup stream objects ──────────────────────────────────────────── */

  /**
   * Whether each object carries the optional block, and on what condition:
   * {@link PRESENT_NEVER} (07), {@link PRESENT_ALWAYS} (08-10) or
   * {@link PRESENT_BIT0} (11-20).
   */
  readonly objectBlock: number
  /**
   * How that block is framed: {@link BLOCK_COUNT} for draft-08's extension
   * count, {@link BLOCK_LENGTH} for everything from draft-09 on (Extension
   * Headers through draft-16, Object Properties from draft-17 — different names
   * for the same "varint length, then that many bytes I do not read").
   */
  readonly blockShape: number
  /**
   * The Object ID field is a **delta** (drafts 14-20) rather than an absolute
   * Object ID (07-13). `draft14/data-streams.ts` resolves
   * `isFirst ? delta : prevObjectId + 1n + delta`; `draft13` reads the id
   * outright. Reading one as the other gives object ids that are wrong and
   * monotonic — the shape a dashboard cannot tell from correct.
   */
  readonly objectIdIsDelta: boolean

  /* ── fetch streams ────────────────────────────────────────────────────── */

  /**
   * Fetch objects carry a Serialization Flags field (drafts 15-20).
   *
   * Drafts 07-14 write every field on every object — Group ID, Subgroup ID,
   * Object ID, Publisher Priority — with no flags byte at all.
   */
  readonly fetchFlagged: boolean
  /**
   * The per-object block on an **unflagged** fetch object (drafts 07-14), which
   * is present unconditionally where it exists at all: absent in 07, an
   * extension count in 08, a length from 09 on — including in 11-13, where the
   * *subgroup* stream makes the same block conditional and the fetch stream does
   * not (`draft11/data-streams.ts` reads `extensionHeadersLength` with no flag
   * test).
   */
  readonly fetchPlainBlock: number
  /** Fetch Serialization Flags are a varint (16-20) rather than one byte (15). */
  readonly fetchFlagsIsVarint: boolean
  /**
   * End-of-Range marker values. Empty for draft-15, which reserves the top two
   * flag bits and has no markers at all; `0x8C` Non-Existent and `0x10C` Unknown
   * for 16-19; draft-20 adds `0x20C` Timed-Out and moves the FILL_TIMEOUT
   * outcome onto it.
   */
  readonly fetchMarkers: ReadonlySet<number>
  /** Flag bit 6 selects DATAGRAM mode, which omits the Subgroup ID (16-20). */
  readonly fetchDatagramMode: boolean
  /**
   * A fetch object with a zero Payload Length carries an Object Status (07-15);
   * from draft-16 it does not, which is the one way the two copies of a
   * doubly-delivered object differ. Reading a status that is not there consumes
   * the next object's first field.
   */
  readonly fetchHasStatus: boolean
  /**
   * A fetch object's Group ID field is absolute (15-17) rather than a delta
   * resolved against the prior object (18-20). `draft17/data-streams.ts` reads
   * the id outright; `draft18` reads a delta and resolves it — one line apart in
   * two otherwise near-identical files.
   */
  readonly fetchGroupIsAbsolute: boolean
  /**
   * On an End-of-Range marker, the Group ID is absolute (16-19) rather than
   * delta-resolved (20).
   *
   * Separate from {@link fetchGroupIsAbsolute} because draft-20 changed the two
   * independently: ordinary objects went to deltas at draft-18, markers at
   * draft-20.
   */
  readonly markerGroupIsAbsolute: boolean
  /**
   * A fetch object's Object ID Delta field is an absolute Object ID (15-19).
   *
   * draft-20 resolves it — absolute when a Group ID Delta is present on the same
   * object, `prior + delta` when it is not.
   */
  readonly fetchObjectIdIsAbsolute: boolean
}

/* ── stream sniff ─────────────────────────────────────────────────── */

const FETCH_STREAM_TYPE = 0x05

/**
 * First-byte stream sniff. **Heuristic, not authoritative** — `'unknown'` is an
 * ordinary outcome.
 *
 * `0x05` opens a FETCH_HEADER in every draft 07 through 20. The subgroup set is
 * per draft. {@link WalkDialect.controlOpener} is `0xaf` from draft-17 and `-1`
 * before it, where control travels bidirectionally and the dispatcher knows that
 * from the seam rather than from a byte.
 *
 * A draft-20 subgroup header may legally arrive with its type flags in a
 * non-minimal two-byte encoding, whose first byte is ≥ 0x80 and sniffs as
 * `'unknown'`. That is why {@link readSubgroupHeader} re-reads the field rather
 * than trusting the sniff.
 */
export function sniffStream(d: WalkDialect, firstByte: number): StreamKind {
  if (firstByte === d.controlOpener) return 'control'
  if (firstByte === FETCH_STREAM_TYPE) return 'fetch'
  if (d.isSubgroupType(firstByte)) return 'subgroup'
  return 'unknown'
}

/* ── subgroup streams ────────────────────────────────────────────────────── */

/**
 * SUBGROUP_HEADER: Type Flags, Track Alias, Group ID, optional Subgroup ID,
 * optional Publisher Priority.
 *
 * `propertiesPresent` is carried out because **every object on the stream then
 * carries a block** the per-object walk must skip; without it the walk
 * desynchronises on the first object. Named for draft-17's Object Properties; in
 * drafts 08-16 it is the Extension Headers block — the same question with a
 * different name on the wire.
 */
export function readSubgroupHeader(
  d: WalkDialect,
  b: Uint8Array,
  i: number,
): SubgroupHeaderInfo | Need {
  let p = i
  let flags: number
  if (d.subgroupTypeIsVarint) {
    const t = d.readVarint(b, p)
    if (t === NEED) return NEED
    // A non-minimal encoding is legal where the varint is, so read the value
    // then judge the value.
    if (t.value >= 0x80n) return NEED
    flags = Number(t.value)
    p = t.next
  } else {
    const t = b[p]
    if (t === undefined) return NEED
    flags = t
    p += 1
  }
  // No failure variant: see this file's header. An invalid header becomes a
  // desync at the caller's slack cap rather than a parse of nonsense.
  if (!d.isSubgroupType(flags)) return NEED

  const alias = d.readVarint(b, p)
  if (alias === NEED) return NEED
  p = alias.next

  const group = d.readVarint(b, p)
  if (group === NEED) return NEED
  p = group.next

  // Where the field is conditional, bit 2 is the condition in every draft that
  // has one. Modes that resolve the id from context (0, or the first object's
  // Object ID) put nothing on the wire, and the id itself is not carried out of
  // this walk, so neither needs distinguishing here.
  if (d.subgroupIdAlways || (flags & 0x04) !== 0) {
    const sub = d.readVarint(b, p)
    if (sub === NEED) return NEED
    p = sub.next
  }

  // DEFAULT_PRIORITY (bit 5) set ⇒ the Publisher Priority byte is absent.
  if (d.priorityAlways || (flags & 0x20) === 0) {
    if (p + 1 > b.length) return NEED
    p += 1
  }

  return {
    trackAlias: alias.value,
    groupId: group.value,
    propertiesPresent: blockPresent(d, flags),
    headerBytes: p - i,
    next: p,
  }
}

function blockPresent(d: WalkDialect, flags: number): boolean {
  if (d.objectBlock === PRESENT_NEVER) return false
  if (d.objectBlock === PRESENT_ALWAYS) return true
  return (flags & 0x01) !== 0
}

/**
 * One object on a subgroup stream: Object ID, optional block, Object Payload
 * Length, and — **only when that length is 0** — an Object Status varint in the
 * position a payload would have. That last branch is the one
 * `createSubgroupStreamDecoder` omits, and why this walk exists.
 *
 * `next` points past the payload and may be **beyond `b.length`**: the payload
 * is skipped, never buffered, so the caller advances across chunk boundaries by
 * arithmetic. Only the header itself must be present to return a value. `prev`
 * is advanced on success.
 */
export function readSubgroupObject(
  d: WalkDialect,
  b: Uint8Array,
  i: number,
  st: SubgroupHeaderInfo,
  prev: ObjectCursor,
): ObjectHeaderInfo | Need {
  let p = i

  const id = d.readVarint(b, p)
  if (id === NEED) return NEED
  p = id.next
  // Drafts 07-13 write the Object ID outright. From draft-14 the first object's
  // field IS its Object ID and every later one is `prior + delta + 1`.
  const objectId = d.objectIdIsDelta
    ? prev.first
      ? id.value
      : prev.prevObjectId + 1n + id.value
    : id.value

  if (st.propertiesPresent) {
    const skipped = skipBlock(d, d.blockShape, b, p)
    if (skipped === NEED) return NEED
    p = skipped
  }

  const len = d.readVarint(b, p)
  if (len === NEED) return NEED
  p = len.next
  const payloadLength = Number(len.value)

  let status: bigint | undefined
  if (payloadLength === 0) {
    const s = d.readVarint(b, p)
    if (s === NEED) return NEED
    status = s.value
    p = s.next
  }

  const info: ObjectHeaderInfo = {
    objectId,
    groupId: st.groupId,
    payloadLength,
    headerBytes: p - i,
    next: p + payloadLength,
  }
  prev.first = false
  prev.prevObjectId = objectId
  prev.prevGroupId = st.groupId
  return status === undefined ? info : { ...info, status }
}

/* ── fetch streams ───────────────────────────────────────────────────────── */

/**
 * FETCH_HEADER: stream type `0x05` and one id, nothing else, in every draft from
 * 07 to 20.
 *
 * The id is spelled `subscribe_id` through draft-10 and `request_id` from
 * draft-11, and it is **not necessarily a FETCH's**: from draft-19 a fill fetch
 * stream carries the Request ID of the SUBSCRIBE or REQUEST_UPDATE that asked
 * for the fill. So `kind: 'fetch'` buckets need no epoch — the id is the only
 * thing on the stream and ingest chains it back through the ctrl records.
 */
export function readFetchHeader(d: WalkDialect, b: Uint8Array, i: number): FetchHeaderInfo | Need {
  let p = i
  const t = d.readVarint(b, p)
  if (t === NEED) return NEED
  if (t.value !== BigInt(FETCH_STREAM_TYPE)) return NEED
  p = t.next

  const req = d.readVarint(b, p)
  if (req === NEED) return NEED
  p = req.next

  return { requestId: req.value, headerBytes: p - i, next: p }
}

/**
 * One object on a fetch stream.
 *
 * Two shapes, split by {@link WalkDialect.fetchFlagged}. Drafts 07-14 write
 * every field on every object. Drafts 15-20 put a Serialization Flags field
 * first and make the rest conditional on it.
 *
 * As with the subgroup walk, `next` may point past `b.length` and `prev` is
 * advanced on success.
 */
export function readFetchObject(
  d: WalkDialect,
  b: Uint8Array,
  i: number,
  prev: ObjectCursor,
): ObjectHeaderInfo | Need {
  return d.fetchFlagged
    ? readFlaggedFetchObject(d, b, i, prev)
    : readPlainFetchObject(d, b, i, prev)
}

/**
 * Drafts 07-14: Group ID, Subgroup ID, Object ID, Publisher Priority, the
 * optional block, Object Payload Length, and a status where that length is 0.
 * Every field is present on every object, so nothing resolves from the prior
 * one; `prev` is carried only to keep the caller's cursor meaningful across the
 * two shapes.
 */
function readPlainFetchObject(
  d: WalkDialect,
  b: Uint8Array,
  i: number,
  prev: ObjectCursor,
): ObjectHeaderInfo | Need {
  let p = i

  const group = d.readVarint(b, p)
  if (group === NEED) return NEED
  p = group.next

  const sub = d.readVarint(b, p)
  if (sub === NEED) return NEED
  p = sub.next

  const obj = d.readVarint(b, p)
  if (obj === NEED) return NEED
  p = obj.next

  // Publisher Priority, one byte, unconditional in this generation.
  if (p + 1 > b.length) return NEED
  p += 1

  if (d.fetchPlainBlock !== BLOCK_NONE) {
    const skipped = skipBlock(d, d.fetchPlainBlock, b, p)
    if (skipped === NEED) return NEED
    p = skipped
  }

  const len = d.readVarint(b, p)
  if (len === NEED) return NEED
  p = len.next
  const payloadLength = Number(len.value)

  let status: bigint | undefined
  if (payloadLength === 0 && d.fetchHasStatus) {
    const s = d.readVarint(b, p)
    if (s === NEED) return NEED
    status = s.value
    p = s.next
  }

  const info = finishFetchObject(prev, i, p, group.value, obj.value, payloadLength)
  return status === undefined ? info : { ...info, status }
}

/**
 * Drafts 15-20, behind one Serialization Flags field.
 *
 *  - `>= 0x80` — an End-of-Range marker. Group ID, Object ID and an Object
 *    Payload Length encoded as 0 (the length field IS present; omitting a field
 *    the figure marks mandatory is what desynchronises a fetch stream).
 *    Draft-15 has no markers and reserves these bits.
 *  - bit 6 set — DATAGRAM mode: no Subgroup ID field. Draft-15 reserves this bit
 *    too.
 *  - otherwise — subgroup mode, where flag bits 0-1 encode the Subgroup ID as
 *    absent / prior / prior+1 / an explicit field.
 */
function readFlaggedFetchObject(
  d: WalkDialect,
  b: Uint8Array,
  i: number,
  prev: ObjectCursor,
): ObjectHeaderInfo | Need {
  let p = i

  let flags: number
  if (d.fetchFlagsIsVarint) {
    const f = d.readVarint(b, p)
    if (f === NEED) return NEED
    p = f.next
    // Markers reach 0x20C, so this is genuinely a varint and not a byte.
    if (f.value > 0xffffn) return NEED
    flags = Number(f.value)
  } else {
    const f = b[p]
    if (f === undefined) return NEED
    // draft-15 reserves bits 6 and 7 and its decoder refuses them outright.
    if ((f & 0xc0) !== 0) return NEED
    flags = f
    p += 1
  }

  let groupId = prev.prevGroupId
  // Absent an Object ID Delta, the Object ID is the prior object's plus one.
  let objectId = prev.prevObjectId + 1n

  if (flags >= 0x80) {
    if (!d.fetchMarkers.has(flags)) return NEED

    const gd = d.readVarint(b, p)
    if (gd === NEED) return NEED
    p = gd.next
    groupId = d.markerGroupIsAbsolute
      ? gd.value
      : resolveGroup(prev.first, gd.value, prev.prevGroupId)

    const od = d.readVarint(b, p)
    if (od === NEED) return NEED
    p = od.next
    objectId = od.value

    const len = d.readVarint(b, p)
    if (len === NEED) return NEED
    p = len.next
    return finishFetchObject(prev, i, p, groupId, objectId, Number(len.value))
  }

  const datagramMode = d.fetchDatagramMode && (flags & 0x40) !== 0
  const subgroupEncoding = flags & 0x03
  const objectIdPresent = (flags & 0x04) !== 0
  const groupIdPresent = (flags & 0x08) !== 0
  const priorityPresent = (flags & 0x10) !== 0
  const blockIsPresent = (flags & 0x20) !== 0

  if (groupIdPresent) {
    const gd = d.readVarint(b, p)
    if (gd === NEED) return NEED
    p = gd.next
    groupId = d.fetchGroupIsAbsolute
      ? gd.value
      : resolveGroup(prev.first, gd.value, prev.prevGroupId)
  } else if (prev.first && !datagramMode) {
    // "First fetch object must include groupId" — a violation in every codec
    // from draft-15 on.
    return NEED
  }

  if (!datagramMode) {
    if (subgroupEncoding === 0x03) {
      const sg = d.readVarint(b, p)
      if (sg === NEED) return NEED
      p = sg.next
    } else if (subgroupEncoding !== 0x00 && prev.first) {
      // 0b01 and 0b10 name the *prior* object's Subgroup ID; there is none.
      return NEED
    }
  }

  if (objectIdPresent) {
    const od = d.readVarint(b, p)
    if (od === NEED) return NEED
    p = od.next
    objectId = d.fetchObjectIdIsAbsolute
      ? od.value
      : groupIdPresent
        ? od.value
        : prev.prevObjectId + od.value
  } else if (prev.first && !datagramMode) {
    return NEED
  }

  if (priorityPresent) {
    if (p + 1 > b.length) return NEED
    p += 1
  }

  if (blockIsPresent) {
    const skipped = skipBlock(d, BLOCK_LENGTH, b, p)
    if (skipped === NEED) return NEED
    p = skipped
  }

  const len = d.readVarint(b, p)
  if (len === NEED) return NEED
  p = len.next
  const payloadLength = Number(len.value)

  let status: bigint | undefined
  if (payloadLength === 0 && d.fetchHasStatus) {
    const s = d.readVarint(b, p)
    if (s === NEED) return NEED
    status = s.value
    p = s.next
  }

  const info = finishFetchObject(prev, i, p, groupId, objectId, payloadLength)
  return status === undefined ? info : { ...info, status }
}

/**
 * The first object's Group ID Delta IS the absolute Group ID; on any later
 * object the Group ID is `prior + delta + 1` for ascending group order. Group
 * Order is a control-plane parameter this decoder never sees, so ascending is
 * assumed — the same assumption the codec documents.
 */
function resolveGroup(first: boolean, delta: bigint, prevGroupId: bigint): bigint {
  return first ? delta : prevGroupId + delta + 1n
}

function finishFetchObject(
  prev: ObjectCursor,
  start: number,
  headerEnd: number,
  groupId: bigint,
  objectId: bigint,
  payloadLength: number,
): ObjectHeaderInfo {
  prev.first = false
  prev.prevGroupId = groupId
  prev.prevObjectId = objectId
  return {
    objectId,
    groupId,
    payloadLength,
    headerBytes: headerEnd - start,
    next: headerEnd + payloadLength,
  }
}

/**
 * Skip the optional per-object block without decoding it.
 *
 * The bytes must be *present* — the Object Payload Length after them is what the
 * walk is after — so a length larger than the buffer returns `NEED`, making a
 * hostile or corrupt length a desync at the caller's header-slack cap rather
 * than an allocation.
 *
 * {@link BLOCK_COUNT} is draft-08's shape alone: a count of extension headers,
 * each an even type with a varint value or an odd type with a length-prefixed
 * one, walked rather than skipped because nothing states its total size.
 */
function skipBlock(d: WalkDialect, shape: number, b: Uint8Array, i: number): number | Need {
  if (shape === BLOCK_COUNT) return skipExtensionCount(d, b, i)

  const len = d.readVarint(b, i)
  if (len === NEED) return NEED
  const n = Number(len.value)
  if (!Number.isSafeInteger(n) || n < 0) return NEED
  if (len.next + n > b.length) return NEED
  return len.next + n
}

function skipExtensionCount(d: WalkDialect, b: Uint8Array, i: number): number | Need {
  const count = d.readVarint(b, i)
  if (count === NEED) return NEED
  const n = Number(count.value)
  // A count is bounded by the frame it sits in; anything past that is corrupt,
  // and looping on it would be the allocation this walk exists to avoid.
  if (!Number.isSafeInteger(n) || n < 0 || n > b.length) return NEED
  let p = count.next
  for (let k = 0; k < n; k++) {
    const type = d.readVarint(b, p)
    if (type === NEED) return NEED
    p = type.next
    if ((type.value & 1n) === 0n) {
      const value = d.readVarint(b, p)
      if (value === NEED) return NEED
      p = value.next
    } else {
      const skipped = skipBlock(d, BLOCK_LENGTH, b, p)
      if (skipped === NEED) return NEED
      p = skipped
    }
  }
  return p
}

/* ── control frames ──────────────────────────────────────────────────────── */

/** What `decodeMessage` returns, narrowed to what a counting decoder needs. */
export type ControlDecodeResult =
  | { readonly ok: true; readonly value: object; readonly bytesRead: number }
  | { readonly ok: false }

/**
 * End offset of the control frame starting at `i`, or {@link NEED} when the
 * buffer does not yet hold all of it.
 *
 * Control frames are `varint type` + length + payload throughout, but the length
 * field is a varint in drafts 07-10 and a 16-bit big-endian field from draft-11
 * ({@link WalkDialect.controlLengthIsVarint}); reading one as the other
 * mis-frames every control message on the session.
 */
export function controlFrameEnd(d: WalkDialect, b: Uint8Array, i: number): number | Need {
  const t = d.readVarint(b, i)
  if (t === NEED) return NEED
  if (d.controlLengthIsVarint) {
    const len = d.readVarint(b, t.next)
    if (len === NEED) return NEED
    const n = Number(len.value)
    if (!Number.isSafeInteger(n) || n < 0) return NEED
    return len.next + n
  }
  const hi = b[t.next]
  const lo = b[t.next + 1]
  if (hi === undefined || lo === undefined) return NEED
  return t.next + 2 + ((hi << 8) | lo)
}

/**
 * The byte length of one already-framed control frame, from its own header.
 *
 * Lets the framer skip a frame it could not decode instead of killing the
 * control plane for the session, which is what the codec's own
 * `createStreamDecoder` does by calling `controller.error()` on
 * `UNKNOWN_MESSAGE_TYPE`. The frame is complete by construction here, so a
 * header that will not parse falls back to the whole frame.
 */
export function controlFrameLength(d: WalkDialect, frame: Uint8Array): number {
  const end = controlFrameEnd(d, frame, 0)
  if (end === NEED) return frame.byteLength
  return end > frame.byteLength ? frame.byteLength : end
}
