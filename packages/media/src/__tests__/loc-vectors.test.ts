/**
 * The LOC property vectors of @moqtap/test-vectors, each read under the
 * profile its draft belongs to.
 *
 * Vectors come from MOQTAP_TEST_VECTORS, else the installed
 * @moqtap/test-vectors when it has the loc spec, else a `test-vectors`
 * checkout beside this repository.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  decodeLocProperties,
  type FrameMarking,
  type LocProfile,
  type LocPropertyResult,
} from '../loc'

function installedVectors(): string | null {
  let manifestPath: string
  try {
    manifestPath = createRequire(import.meta.url).resolve('@moqtap/test-vectors/manifest')
  } catch {
    return null
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    specs?: Record<string, unknown>
  }
  return manifest.specs?.loc !== undefined ? dirname(manifestPath) : null
}

function vectorsRoot(): string {
  const fromEnv = process.env.MOQTAP_TEST_VECTORS
  if (fromEnv) return resolve(fromEnv)
  const installed = installedVectors()
  if (installed !== null) return installed
  // packages/media/src/__tests__ -> the directory holding this repository
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../test-vectors')
}

type Fields = Record<string, string | boolean>

type Decoded =
  | ({ name: string } & Fields)
  | { name: string; candidates: Fields[] }
  | { name: string; uninterpreted: true }
  | { ambiguous: string[] }

interface PropertyVector {
  id: string
  property_type: string
  value?: string
  value_hex?: string
  decoded?: Decoded
  error?: 'invalid_length' | 'out_of_range'
}

interface VectorFile {
  name: string
  version: string
  profile: LocProfile
  vectors: PropertyVector[]
}

/** Manifest spec and version id to profile */
const PROFILES: Record<string, Record<string, LocProfile>> = {
  loc: {
    draft00: 'ietf-00/01',
    draft01: 'ietf-00/01',
    draft02: 'ietf-02',
    draft03: 'ietf-03',
    draft04: 'ietf-04',
  },
  'mzanaty-loc': { draft05: 'mzanaty-05' },
}

function jsonFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...jsonFiles(path))
    else if (entry.endsWith('.json')) out.push(path)
  }
  return out
}

function loadLocVectors(): { files: VectorFile[]; unmapped: string[] } {
  const root = vectorsRoot()
  const manifestPath = join(root, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(
      `No test vectors at ${root}. Clone moqtap/test-vectors beside this repository or set MOQTAP_TEST_VECTORS.`,
    )
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    specs: Record<string, { ietf_base?: string; versions: { id: string; path: string }[] }>
  }
  const files: VectorFile[] = []
  const unmapped: string[] = Object.entries(manifest.specs)
    .filter(([spec, s]) => PROFILES[spec] === undefined && /-moq-loc$/.test(s.ietf_base ?? ''))
    .map(([spec]) => spec)
  for (const [spec, byVersion] of Object.entries(PROFILES)) {
    for (const version of manifest.specs[spec]?.versions ?? []) {
      const profile = byVersion[version.id]
      if (profile === undefined) {
        unmapped.push(`${spec}/${version.id}`)
        continue
      }
      const dir = join(root, version.path)
      if (!existsSync(dir)) throw new Error(`Missing vector directory ${dir}`)
      for (const path of jsonFiles(dir)) {
        const data = JSON.parse(readFileSync(path, 'utf-8')) as { vectors?: PropertyVector[] }
        if (!Array.isArray(data.vectors)) continue
        const name =
          version.path +
          path
            .slice(dir.length + 1)
            .split('\\')
            .join('/')
        files.push({ name, version: `${spec}/${version.id}`, profile, vectors: data.vectors })
      }
    }
  }
  return { files, unmapped }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function frameMarkingFields(m: FrameMarking): Fields {
  const fields: Fields = {
    octets: String(m.octets),
    S: m.startOfFrame,
    E: m.endOfFrame,
    I: m.independent,
    D: m.discardable,
    B: m.baseLayerSync,
    TID: String(m.temporalId),
  }
  if (m.layerId !== undefined) fields.LID = String(m.layerId)
  if (m.tl0PicIdx !== undefined) fields.TL0PICIDX = String(m.tl0PicIdx)
  return fields
}

/** The result in the vectors' terms */
function asVector(r: LocPropertyResult): Pick<PropertyVector, 'decoded' | 'error'> {
  if (r.error !== undefined) return { error: r.error }
  if (r.ambiguous !== undefined) {
    return { decoded: { ambiguous: [...new Set(r.ambiguous.flatMap((a) => a.meanings))] } }
  }
  if (r.name === undefined) return {}
  const name = r.name
  if (r.uninterpreted) return { decoded: { name, uninterpreted: true } }
  if (r.meaning === 'video-config' || r.meaning === 'audio-config') {
    return { decoded: { name, length: String((r.raw as Uint8Array).length) } }
  }
  const d = r.decoded
  switch (d?.kind) {
    case 'capture-timestamp':
      return { decoded: { name, timestamp: String(d.microseconds) } }
    case 'timestamp':
      return { decoded: { name, timestamp: String(d.value) } }
    case 'timescale':
      return { decoded: { name, timescale: String(d.unitsPerSecond) } }
    case 'video-frame-marking':
      return d.candidates.length === 1
        ? { decoded: { name, ...frameMarkingFields(d.candidates[0]!) } }
        : { decoded: { name, candidates: d.candidates.map(frameMarkingFields) } }
    case 'audio-level':
      return { decoded: { name, voice_activity: d.voiceActivity, level: String(d.level) } }
    default:
      return { decoded: { name } }
  }
}

const { files, unmapped } = loadLocVectors()

describe('LOC vectors', () => {
  it('loads every LOC vector', () => {
    expect(unmapped).toEqual([])
    const counts: Record<string, number> = {}
    for (const f of files) counts[f.version] = (counts[f.version] ?? 0) + f.vectors.length
    expect(counts).toEqual({
      'loc/draft00': 20,
      'loc/draft01': 20,
      'loc/draft02': 17,
      'loc/draft03': 31,
      'loc/draft04': 29,
      'mzanaty-loc/draft05': 5,
    })
    expect(files.reduce((n, f) => n + f.vectors.length, 0)).toBe(122)
  })

  for (const file of files) {
    describe(file.name, () => {
      for (const vector of file.vectors) {
        it(vector.id, () => {
          const type = BigInt(vector.property_type)
          const property =
            vector.value !== undefined
              ? { type, value: BigInt(vector.value) }
              : { type, bytes: hexToBytes(vector.value_hex ?? '') }
          const [result] = decodeLocProperties([property], { profile: file.profile })
          const want: Pick<PropertyVector, 'decoded' | 'error'> =
            vector.error !== undefined ? { error: vector.error } : { decoded: vector.decoded! }
          expect(asVector(result!)).toEqual(want)
        })
      }
    })
  }
})
