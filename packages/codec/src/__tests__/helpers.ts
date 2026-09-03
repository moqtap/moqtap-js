/**
 * Test helpers for converting between test vector JSON and codec types.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require_ = createRequire(import.meta.url)
const VECTORS_BASE = dirname(require_.resolve('@moqtap/test-vectors/manifest'))

/**
 * Load all test vector JSON files from a directory inside @moqtap/test-vectors.
 * @param subpath - relative path under the package root, e.g. "transport/draft14/codec/messages"
 */
export function loadVectorDir(subpath: string): { file: string; data: TestVectorFile }[] {
  const dir = resolve(VECTORS_BASE, subpath)
  return readdirSync(dir)
    .filter((f: string) => f.endsWith('.json'))
    .sort()
    .map((f: string) => ({
      file: f,
      data: JSON.parse(readFileSync(resolve(dir, f), 'utf-8')) as TestVectorFile,
    }))
}

/** Convert a hex string to a Uint8Array */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

/** Convert a Uint8Array to a hex string */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    hex += (bytes[i] as number).toString(16).padStart(2, '0')
  }
  return hex
}

/** Test vector schema */
export interface TestVectorFile {
  message_type: string
  message_type_id?: string
  spec_section?: string
  vectors: TestVector[]
}

export interface TestVector {
  id: string
  description: string
  hex: string
  canonical?: boolean
  decoded?: Record<string, unknown>
  error?: string
  error_detail?: string
}

/**
 * Normalize a decoded message for comparison with test vector JSON.
 * Converts bigints to strings, strips the `type` field, and normalizes params.
 */
export function normalizeDecoded(msg: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(msg)) {
    // Skip the internal `type` discriminator — test vectors don't include it
    if (key === 'type') continue

    if (typeof value === 'bigint') {
      result[key] = value.toString()
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === 'bigint') return item.toString()
        if (typeof item === 'object' && item !== null) {
          return normalizeDecoded(item as Record<string, unknown>)
        }
        return item
      })
    } else if (value instanceof Uint8Array) {
      result[key] = bytesToHex(value)
    } else if (typeof value === 'object' && value !== null) {
      result[key] = normalizeDecoded(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }

  return result
}

/**
 * Flatten a FETCH's `standalone` / `joining` sub-structure up to the top level.
 *
 * The codec groups those fields because only one set is present at a time, and
 * which one is decided by `fetch_type`. The test vectors spell them flat, the
 * way the wire lays them out. Neither is wrong, so the two are reconciled here
 * rather than in each draft's runner.
 *
 * A no-op for any message without the sub-structures, including draft-07's
 * FETCH, which predates joining fetch and is genuinely flat.
 */
export function flattenFetch(msg: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(msg)) {
    if ((key === 'standalone' || key === 'joining') && value && typeof value === 'object') {
      Object.assign(result, value)
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * Normalize draft-14 params for comparison with test vector JSON.
 * Test vectors use: { "max_request_id": "0", "path": "/moq", "unknown": [...] }
 * Our codec uses: Draft14Params { role?: bigint, path?: string, max_request_id?: bigint, unknown?: UnknownParam[] }
 */
export function normalizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'bigint') {
      result[key] = value.toString()
    } else if (key === 'unknown' && Array.isArray(value)) {
      result[key] = value.map((u) => {
        const item = u as Record<string, unknown>
        return {
          id: item.id,
          length: String(item.length),
          raw_hex: item.raw_hex,
        }
      })
    } else {
      result[key] = value
    }
  }

  return result
}

/**
 * A vector's Key-Value-Pair block, collapsed to the map this codec decodes into.
 *
 * The corpus spells a block as a list of entries in wire order,
 * `{ type, name?, value | raw_hex }`, which is what the wire carries. This
 * codec keys its parameters by name, so the two are reconciled here.
 *
 * A name with one slot cannot hold a type that arrives twice. `repeated` names
 * any that do, and the runners assert it is empty, so a parameter this codec
 * cannot represent fails rather than overwriting itself.
 */
/**
 * The parameter names this codec decodes into a list rather than a single value.
 *
 * Two definitions permit a repeat: AUTHORIZATION_TOKEN on drafts 11 and later,
 * and the five Range Filters on drafts 19 and 20.
 */
const REPEATABLE_PARAMS = new Set([
  'authorization_token',
  'subgroup_filter',
  'objectid_filter',
  'priority_filter',
  'object_property_filter',
  'track_property_filter',
])

export function vectorParamsToMap(entries: unknown): {
  named: Record<string, unknown>
  repeated: string[]
} {
  const named: Record<string, unknown> = {}
  const unknown: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  const repeated: string[] = []

  for (const raw of (entries ?? []) as Array<Record<string, unknown>>) {
    const name = raw.name as string | undefined
    if (name === undefined) {
      // An entry with no name is a type the draft assigns nothing. This codec
      // keeps those in an `unknown` array, with the length the old shape spelled
      // out and this one leaves to the bytes.
      const rawHex = (raw.raw_hex as string | undefined) ?? ''
      unknown.push({
        id: raw.type as string,
        length: String(rawHex.length / 2),
        raw_hex: rawHex,
      })
      continue
    }
    const value = 'value' in raw ? raw.value : raw.raw_hex
    if (REPEATABLE_PARAMS.has(name)) {
      // This codec models the repeatable types as lists, so a single instance
      // is a one-element list and a repeat needs no special case here either.
      named[name] = [...((named[name] as unknown[]) ?? []), value]
      continue
    }
    if (seen.has(name)) {
      repeated.push(name)
      continue
    }
    seen.add(name)
    named[name] = value
  }

  if (unknown.length > 0) named.unknown = unknown
  return { named, repeated }
}
