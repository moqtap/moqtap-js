/**
 * `@moqtap/test-vectors`, read the way the corpus tests need it.
 *
 * The corpus was written against the drafts by someone else: each vector is a
 * hex string and the fields it decodes to. Everything here reads those fields
 * and nothing of ours, so a test built on it checks our bytes-to-fields against
 * an outside answer.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { ALL_ADAPTERS } from '../../drafts/all.js'
import type { DraftAdapter, SupportedDraft } from '../../types.js'

const require_ = createRequire(import.meta.url)
const VECTORS = dirname(require_.resolve('@moqtap/test-vectors/manifest'))

export interface Vector {
  readonly id: string
  readonly description?: string
  readonly hex: string
  readonly error?: unknown
  readonly decoded?: Record<string, unknown>
}

export type CorpusFile = 'subgroup' | 'fetch-header' | 'datagram'

export function loadVectors(draft: SupportedDraft, file: CorpusFile): Vector[] {
  const path = resolve(VECTORS, `transport/draft${pad(draft)}/codec/data-streams/${file}.json`)
  const data = JSON.parse(readFileSync(path, 'utf8')) as { vectors: Vector[] }
  // Vectors carrying an `error` are the corpus's negative cases: bytes a
  // conforming decoder must reject. The walks have no failure variant to check
  // them with (see `data-walk.ts`), so they are skipped rather than asserted on
  // in a way that would pass for the wrong reason.
  return data.vectors.filter((v) => v.error === undefined && v.decoded !== undefined)
}

export function pad(d: number): string {
  return d < 10 ? `0${d}` : `${d}`
}

export function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) b[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16)
  return b
}

/** The corpus writes every integer as a decimal string. */
export function big(v: unknown): bigint | undefined {
  return typeof v === 'string' ? BigInt(v) : undefined
}

export function num(v: unknown): number | undefined {
  return typeof v === 'string' ? Number(v) : undefined
}

/** What one object should look like, read out of the corpus and not out of us. */
export interface Expected {
  readonly groupId?: bigint
  readonly objectId?: bigint
  readonly payloadLength?: number
  readonly status?: bigint
  /** An End-of-Range marker on a fetch stream: walked, never counted. */
  readonly marker: boolean
  /** Publisher Priority, or -1 where the corpus states none. */
  readonly priority: number
  /** Subgroup ID, or `null` where the object has none. */
  readonly subgroupId: bigint | null
}

/**
 * The corpus spells the status two ways, and one of them lies.
 *
 * Drafts 07-14 write `object_status`; 15 on write `status`. Both are read,
 * because reading one name would silently skip the assertion on seven drafts and
 * a skipped assertion is indistinguishable from a passing one.
 *
 * The lie is in drafts 07-10, where `object_status: "0"` is reported on objects
 * that carry a payload and therefore **have no status field on the wire** —
 * `subgroup-single-object` is `04 01 00 00 80 | 00 04 deadbeef`, eleven bytes
 * with nowhere for a status to sit. It is the corpus stating a default, not the
 * bytes.
 *
 * So the wire rule decides, and it is the same rule in every draft: the
 * Object Status occupies the position a payload would, so it is present exactly
 * when the Payload Length is zero. Verified across the whole corpus — no vector
 * in any draft reports a status alongside a non-zero length except those four
 * defaults.
 */
function expectedStatus(o: Record<string, unknown>): bigint | undefined {
  if (num(o.payload_length) !== 0) return undefined
  return big(o.status) ?? big(o.object_status)
}

/**
 * The objects a vector decodes to. On a subgroup stream the header's group,
 * priority and subgroup stand for every object; on a fetch stream each object
 * states its own.
 */
export function expectedObjects(decoded: Record<string, unknown>, header?: Expected): Expected[] {
  const raw = decoded.objects
  if (!Array.isArray(raw)) return []
  return raw.map((o: Record<string, unknown>) => {
    const flags = typeof o.serialization_flags === 'string' ? Number(o.serialization_flags) : 0
    const e: Record<string, unknown> = {
      objectId: big(o.object_id),
      payloadLength: num(o.payload_length),
      groupId: big(o.group_id) ?? header?.groupId,
      marker: flags >= 0x80,
      priority: header?.priority ?? num(o.publisher_priority) ?? -1,
      subgroupId: header === undefined ? (big(o.subgroup_id) ?? null) : header.subgroupId,
    }
    const status = expectedStatus(o)
    if (status !== undefined) e.status = status
    return e as unknown as Expected
  })
}

/** A subgroup header's fields, standing for each of its objects. */
export function expectedHeader(decoded: Record<string, unknown>): Expected {
  return {
    groupId: big(decoded.group_id) as bigint,
    marker: false,
    priority: num(decoded.publisher_priority) ?? -1,
    subgroupId: big(decoded.subgroup_id) ?? null,
  }
}

const ADAPTERS = new Map<SupportedDraft, DraftAdapter>(ALL_ADAPTERS.map((a) => [a.draft, a]))

export function adapterFor(draft: SupportedDraft): DraftAdapter {
  const adapter = ADAPTERS.get(draft)
  if (adapter === undefined) throw new Error(`no adapter for draft ${draft}`)
  return adapter
}
