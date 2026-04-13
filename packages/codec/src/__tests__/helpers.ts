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
