/**
 * The MSF and CMSF catalog vectors of @moqtap/test-vectors.
 *
 * Profiles: `validator` sees every problem; `reader` only `error` problems. A
 * vector with no profiles binds both.
 *
 * Vectors come from MOQTAP_TEST_VECTORS, else the installed
 * @moqtap/test-vectors, else a `test-vectors` checkout beside this repository.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  applyCatalogObject,
  type CatalogDraft,
  type CatalogProblem,
  catalogProblemFound,
  catalogProblemRemedy,
  catalogProblemTitle,
  createCatalogState,
  type JsonObject,
  parseCatalog,
  severityOf,
  specLabel,
} from '../catalog'

// ─── Locating the vectors ────────────────────────────────────────────

/** The installed @moqtap/test-vectors, when it holds catalog vectors */
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
  return manifest.specs?.msf !== undefined && manifest.specs.cmsf !== undefined
    ? dirname(manifestPath)
    : null
}

function vectorsRoot(): string {
  const fromEnv = process.env.MOQTAP_TEST_VECTORS
  if (fromEnv) return resolve(fromEnv)
  const installed = installedVectors()
  if (installed !== null) return installed
  // packages/media/src/__tests__ -> the directory holding this repository
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../test-vectors')
}

interface Payload {
  text?: string
  hex?: string
}

interface CatalogVector {
  id: string
  description: string
  input: Payload
  steps?: Payload[]
  resolved?: JsonObject
  error?: string
  error_at?: number
  profiles?: Profile[]
  tolerant?: true
}

type Profile = 'validator' | 'reader'

interface VectorFile {
  /** e.g. msf/draft01/catalog/delta.json */
  name: string
  draft: CatalogDraft
  vectors: CatalogVector[]
}

/** Every catalog vector file the manifest's msf and cmsf versions hold */
function loadCatalogVectors(): VectorFile[] {
  const root = vectorsRoot()
  const manifestPath = join(root, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(
      `No catalog vectors: the installed @moqtap/test-vectors has none and there is no test-vectors checkout at ${root}. Clone moqtap/test-vectors beside this repository or set MOQTAP_TEST_VECTORS.`,
    )
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    specs: Record<string, { versions: { id: string; path: string }[] }>
  }
  const files: VectorFile[] = []
  for (const spec of ['msf', 'cmsf'] as const) {
    for (const version of manifest.specs[spec]?.versions ?? []) {
      // draft00 -> msf-00
      const draft = `${spec}-${version.id.slice(-2)}` as CatalogDraft
      const dir = join(root, version.path, 'catalog')
      if (!existsSync(dir)) continue
      for (const file of readdirSync(dir).sort()) {
        if (!file.endsWith('.json')) continue
        const data = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as {
          vectors: CatalogVector[]
        }
        files.push({ name: `${version.path}catalog/${file}`, draft, vectors: data.vectors })
      }
    }
  }
  return files
}

// ─── Running one vector ──────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/** A `text` payload goes in as a string, a `hex` one as its bytes */
function payloadInput(payload: Payload): string | Uint8Array {
  return payload.text !== undefined ? payload.text : hexToBytes(payload.hex!)
}

/**
 * Each object's problems, parse and apply together, and the final catalog.
 * `draft` null reads every object by its shape alone, and leaves out its
 * `ambiguous_draft` warnings.
 */
function run(vector: CatalogVector, draft: CatalogDraft | null) {
  let state = createCatalogState()
  const problems: CatalogProblem[][] = []
  for (const payload of [vector.input, ...(vector.steps ?? [])]) {
    const parsed = parseCatalog(payloadInput(payload), draft === null ? {} : { draft })
    const update = applyCatalogObject(state, parsed)
    const found = [...parsed.problems, ...update.problems]
    if (draft === null && (parsed.kind === 'independent' || parsed.kind === 'delta')) {
      const ambiguous = parsed.draft === null && parsed.candidates.length > 0
      expect(found.filter((p) => p.category === 'ambiguous_draft').length).toBe(ambiguous ? 1 : 0)
    }
    problems.push(draft === null ? found.filter((p) => p.category !== 'ambiguous_draft') : found)
    state = update.state
  }
  return { problems, document: state.document }
}

function view(problems: CatalogProblem[], profile: Profile): CatalogProblem[] {
  return profile === 'reader' ? problems.filter((p) => p.severity === 'error') : problems
}

function describeProblems(problems: CatalogProblem[]): string {
  return problems.map((p) => `${p.category} at ${p.path || '(root)'} (${p.section})`).join('; ')
}

/**
 * A catalog compared as the vectors define it: JSON values, with tracks as a
 * set keyed by namespace and name.
 */
function comparable(document: JsonObject | null) {
  if (document === null) return null
  const { tracks, ...rest } = document
  const keyed = Array.isArray(tracks)
    ? tracks
        .map((t) => {
          const track = t as JsonObject
          return [JSON.stringify([track.namespace ?? null, track.name ?? null]), track] as const
        })
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    : tracks
  return { rest, tracks: keyed }
}

/** Why the vector fails under the profile, or null when it passes */
function evaluate(
  vector: CatalogVector,
  draft: CatalogDraft | null,
  profile: Profile,
): string | null {
  const { problems, document } = run(vector, draft)
  if (vector.error !== undefined) {
    const at = vector.error_at ?? 0
    for (let k = 0; k < at; k++) {
      const before = view(problems[k]!, profile)
      if (before.length > 0) return `object ${k}, before the error: ${describeProblems(before)}`
    }
    const found = view(problems[at]!, profile)
    if (!found.some((p) => p.category === vector.error)) {
      const saw = found.length > 0 ? describeProblems(found) : 'nothing'
      return `object ${at}: expected ${vector.error}, saw ${saw}`
    }
    return null
  }
  const reported = problems.flatMap((p, k) =>
    view(p, profile).map((problem) => ({ ...problem, path: `[${k}] ${problem.path}` })),
  )
  if (reported.length > 0) return `expected no problems, saw ${describeProblems(reported)}`
  const got = JSON.stringify(comparable(document))
  const want = JSON.stringify(comparable(vector.resolved!))
  // JSON.stringify keeps member order; compare as values instead.
  try {
    expect(comparable(document)).toEqual(comparable(vector.resolved!))
  } catch {
    return `resolved differs:\n  got  ${got}\n  want ${want}`
  }
  return null
}

/**
 * Vectors that hold only when the reader is told the draft: a version of the
 * other draft's JSON type is, by shape, a catalog of the other draft.
 */
const NEEDS_DRAFT = new Set([
  'msf/draft00/catalog/invalid.json#version-string',
  'msf/draft01/catalog/invalid.json#version-number',
])

// ─── The run ─────────────────────────────────────────────────────────

const files = loadCatalogVectors()

describe('catalog vectors', () => {
  it('loads every catalog vector', () => {
    const counts = Object.fromEntries(
      ['msf-00', 'msf-01', 'cmsf-00', 'cmsf-01'].map((draft) => [
        draft,
        files.filter((f) => f.draft === draft).reduce((n, f) => n + f.vectors.length, 0),
      ]),
    )
    expect(counts).toEqual({ 'msf-00': 47, 'msf-01': 66, 'cmsf-00': 12, 'cmsf-01': 23 })
  })

  it('names only vectors that exist', () => {
    const ids = new Set(files.flatMap((f) => f.vectors.map((v) => `${f.name}#${v.id}`)))
    for (const key of NEEDS_DRAFT) expect(ids).toContain(key)
  })

  it('words every problem as a sentence', () => {
    for (const file of files) {
      for (const vector of file.vectors) {
        for (const problem of run(vector, file.draft).problems.flat()) {
          expect(problem.message, `${file.name}#${vector.id}`).toMatch(/^[A-Z].*[^.]$/s)
        }
      }
    }
  })

  it('gives every problem an id, a reference pinned to its draft, and its wording', () => {
    for (const file of files) {
      for (const vector of file.vectors) {
        for (const p of run(vector, file.draft).problems.flat()) {
          const at = `${file.name}#${vector.id}: ${p.id}`
          expect(p.id, at).toMatch(/^catalog\.[a-zA-Z0-9.-]+$/)
          expect(p.message, at).toBe(catalogProblemTitle([p]))
          expect(p.message.length, at).toBeLessThanOrEqual(70)
          expect(catalogProblemRemedy([p]), at).not.toMatch(/\n/)
          expect(catalogProblemFound([p]), at).not.toBe('')
          expect(p.section, at).toBe(specLabel(p.spec))
          expect(p.readAs.drafts, at).toContain(file.draft)
          // A CMSF rule cites CMSF; every other rule the MSF draft of the same revision.
          expect(`${p.spec.draft}-${p.spec.revision}`, at).toMatch(
            new RegExp(`^c?msf-${file.draft.slice(-2)}$`),
          )
          expect(['error', 'warning', 'info'], at).toContain(severityOf(p))
        }
      }
    }
  })

  for (const file of files) {
    describe(file.name, () => {
      for (const vector of file.vectors) {
        for (const profile of vector.profiles ?? (['validator', 'reader'] as const)) {
          it(`${vector.id} (${profile})`, () => {
            expect(evaluate(vector, file.draft, profile)).toBeNull()
          })
        }
      }
    })
  }
})

// The same vectors with no draft given: the shape tells MSF-00 from MSF-01,
// MSF and CMSF are told apart or reported as ambiguous, and a delta of the
// wrong shape is caught against the catalog it would apply to.
describe('catalog vectors, draft read from the shape', () => {
  for (const file of files) {
    describe(file.name, () => {
      for (const vector of file.vectors) {
        if (NEEDS_DRAFT.has(`${file.name}#${vector.id}`)) continue
        for (const profile of vector.profiles ?? (['validator', 'reader'] as const)) {
          it(`${vector.id} (${profile})`, () => {
            expect(evaluate(vector, null, profile)).toBeNull()
          })
        }
      }
    })
  }
})
