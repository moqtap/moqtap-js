/**
 * The `moq-00` draft resolution, against real SETUP frames.
 *
 * Eight drafts — 07 through 14 — negotiate the same ALPN, so for those the
 * protocol string says nothing and the draft has to come off the wire. This is
 * the test that the reading is right, because getting it wrong is silent in the
 * worst way: the wrong adapter parses the same bytes and reports plausible wrong
 * numbers rather than failing.
 *
 * Frames come from `@moqtap/test-vectors`, which was written against the drafts
 * by someone else. Nothing here builds a SETUP frame by hand, because a
 * hand-built one would encode this module's own idea of the framing and then
 * confirm it.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { draftOfSetupFrame } from '../../draft/setup-probe.js'

const require_ = createRequire(import.meta.url)
const VECTORS = dirname(require_.resolve('@moqtap/test-vectors/manifest'))

/** The drafts that share the `moq-00` ALPN and settle the version in band. */
const LEGACY_DRAFTS = [7, 8, 9, 10, 11, 12, 13, 14] as const

interface Vector {
  readonly id: string
  readonly hex: string
  readonly error?: unknown
  readonly decoded?: Record<string, unknown>
}

function pad(d: number): string {
  return d < 10 ? `0${d}` : `${d}`
}

function load(draft: number, file: string): Vector[] {
  const path = resolve(VECTORS, `transport/draft${pad(draft)}/codec/messages/${file}.json`)
  const data = JSON.parse(readFileSync(path, 'utf8')) as { vectors: Vector[] }
  return data.vectors.filter((v) => v.error === undefined && v.decoded !== undefined)
}

function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) b[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16)
  return b
}

describe.each(
  LEGACY_DRAFTS.map((d) => ({ draft: d, name: `draft-${pad(d)}` })),
)('$name SERVER_SETUP', ({ draft }) => {
  const vectors = load(draft, 'server-setup')

  it('has vectors to read', () => {
    expect(vectors.length).toBeGreaterThan(0)
  })

  for (const v of vectors) {
    it(`reads the draft out of ${v.id}`, () => {
      expect(draftOfSetupFrame(hexToBytes(v.hex))).toBe(draft)
    })
  }
})

describe.each(
  LEGACY_DRAFTS.map((d) => ({ draft: d, name: `draft-${pad(d)}` })),
)('$name CLIENT_SETUP', ({ draft }) => {
  const vectors = load(draft, 'client-setup')

  it('has vectors to read', () => {
    expect(vectors.length).toBeGreaterThan(0)
  })

  for (const v of vectors) {
    it(`reads ${v.id} only when it offers one version`, () => {
      const versions = (v.decoded as { supported_versions?: unknown }).supported_versions
      const count = Array.isArray(versions) ? versions.length : 0
      const got = draftOfSetupFrame(hexToBytes(v.hex))
      if (count === 1) {
        // One offered version and a running session: there was no alternative
        // to choose between, so this is the version that was selected.
        expect(got).toBe(draft)
      } else {
        // Two or more, and this frame does not say which was picked. Refusing
        // is the point — a pick here would be a guess, and the whole
        // draft-loading path exists to not guess.
        expect(got).toBeUndefined()
      }
    })
  }
})

describe('what it refuses', () => {
  it('reads nothing out of an empty or truncated frame', () => {
    expect(draftOfSetupFrame(new Uint8Array(0))).toBeUndefined()
    expect(draftOfSetupFrame(new Uint8Array([0x21]))).toBeUndefined()
    expect(draftOfSetupFrame(new Uint8Array([0x21, 0x00]))).toBeUndefined()
    // The header is complete and the version is not.
    expect(draftOfSetupFrame(new Uint8Array([0x21, 0x00, 0x09, 0xc0, 0x00]))).toBeUndefined()
  })

  it('reads nothing out of a frame that is not a SETUP', () => {
    // SUBSCRIBE (0x03) in draft-14's framing, carrying bytes that would read as
    // a version if the type were not checked.
    const notSetup = new Uint8Array([
      0x03, 0x00, 0x09, 0xc0, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x0e, 0x00,
    ])
    expect(draftOfSetupFrame(notSetup)).toBeUndefined()
  })

  it('reads nothing out of a version it has no decoder for', () => {
    // draft-06: real, deployed, and below `@moqtap/codec`'s floor of 07. The
    // right answer is `undefined` and not "close enough to 07" — a version
    // table rather than arithmetic on 0xff000000 is what makes it so.
    const draft06 = new Uint8Array([
      0x21, 0x00, 0x09, 0xc0, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x06, 0x00,
    ])
    expect(draftOfSetupFrame(draft06)).toBeUndefined()

    // draft-99, which does not exist. Arithmetic would have produced 99.
    const draft99 = new Uint8Array([
      0x21, 0x00, 0x09, 0xc0, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x63, 0x00,
    ])
    expect(draftOfSetupFrame(draft99)).toBeUndefined()
  })

  it('does not mistake one framing generation for the other', () => {
    // draft-07's SERVER_SETUP type `0x41` is written as the two-byte varint
    // `40 41` and its length is a varint; draft-11's is the one-byte `0x21`
    // with a 16-bit length. Feeding one shape with the other's length framing
    // must not resolve to anything.
    const wrongFraming = new Uint8Array([
      0x40, 0x41, 0x00, 0x09, 0xc0, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x07,
    ])
    // The varint length reads `0x00`, so the version is read from the next
    // byte: `0x09`, which is not a MoQT version and is refused.
    expect(draftOfSetupFrame(wrongFraming)).toBeUndefined()
  })
})
