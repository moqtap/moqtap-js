/**
 * `resolveConfig`, `DEFAULTS` and `DEFAULT_PROVENANCE`.
 *
 * The tests below are about behaviour a customer can observe, not about the
 * shape of the object: that every threshold has a default *and* a provenance
 * line, that automated mode really does ship off, that a mistyped key is
 * reported rather than swallowed, and that the two fatal misconfigurations fail
 * at the call site instead of producing a collector that uploads nowhere.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ConfigProblem,
  isStorableSessionId,
  MAX_SESSION_ID_BYTES,
  resolveConfig,
} from '../../api/config.js'
import {
  DEFAULT_LIMITS,
  DEFAULT_PROVENANCE,
  DEFAULT_UPLOAD,
  DEFAULTS,
  isElevated,
  LIMIT_PROVENANCE,
  levelIndex,
} from '../../api/defaults.js'
import { MQ1113 } from '../../codes.js'
import { DETAIL_LEVELS } from '../../types.js'

const MINIMAL = { apiKey: 'pk_test', endpoint: 'https://ingest.test/v1/ingest' }

function collect(): { problems: ConfigProblem[]; onProblem: (p: ConfigProblem) => void } {
  const problems: ConfigProblem[] = []
  return { problems, onProblem: (p) => problems.push(p) }
}

describe('the two fatal misconfigurations', () => {
  it('refuses a config with no apiKey', () => {
    expect(() => resolveConfig({ endpoint: 'https://x.test' } as never)).toThrow(/MQ1002/)
  })

  it('refuses an endpoint that was supplied and is unusable', () => {
    // A typo in an override, not an absence. Defaulting past it would send a
    // customer's traffic somewhere they did not choose.
    expect(() => resolveConfig({ apiKey: 'k', endpoint: '' } as never)).toThrow(/MQ1003/)
    expect(() => resolveConfig({ apiKey: 'k', endpoint: 42 } as never)).toThrow(/MQ1003/)
  })

  it('falls back to the hosted ingest when none is given', () => {
    expect(resolveConfig({ apiKey: 'k' } as never).endpoint).toBe(DEFAULTS.endpoint)
  })

  it('keeps an endpoint the caller did supply', () => {
    expect(resolveConfig({ apiKey: 'k', endpoint: 'https://own.test/i' } as never).endpoint).toBe(
      'https://own.test/i',
    )
  })

  it('refuses a non-object', () => {
    expect(() => resolveConfig(null as never)).toThrow()
  })

  it('accepts nothing else as fatal — a mistyped bound is reported, not thrown', () => {
    const { problems, onProblem } = collect()
    const c = resolveConfig({ ...MINIMAL, upload: { intervalMs: -1 } }, { onProblem })
    expect(c.upload.intervalMs).toBe(DEFAULT_UPLOAD.intervalMs)
    expect(problems.map((p) => p.key)).toContain('upload.intervalMs')
  })
})

describe('no threshold is a constant', () => {
  it('gives every resolved key a provenance line', () => {
    for (const key of Object.keys(DEFAULTS)) {
      const line = (DEFAULT_PROVENANCE as Record<string, string | undefined>)[key]
      expect(line, `no provenance for ${key}`).toBeTypeOf('string')
      expect((line as string).length, `empty provenance for ${key}`).toBeGreaterThan(10)
    }
  })

  it('gives every limit its own provenance line', () => {
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      const line = (LIMIT_PROVENANCE as Record<string, string | undefined>)[key]
      expect(line, `no provenance for limits.${key}`).toBeTypeOf('string')
      expect((line as string).length).toBeGreaterThan(10)
    }
  })

  it('carries the numbers the spec hard-codes rather than hiding them in code', () => {
    // The 8-transport cap, the 32 KB / 60 s seal, the +45 s early flush,
    // the 64 KB beacon cap, the 5,000/s control rate.
    expect(DEFAULT_LIMITS.maxConcurrentTransports).toBe(8)
    expect(DEFAULT_UPLOAD.byteThreshold).toBe(32 * 1024)
    expect(DEFAULT_UPLOAD.intervalMs).toBe(60_000)
    expect([...DEFAULT_UPLOAD.earlyFlushesMs]).toEqual([45_000])
    expect(DEFAULT_UPLOAD.beaconMaxBytes).toBe(64 * 1024)
    expect(DEFAULT_LIMITS.controlRatePerSec).toBe(5_000)
  })

  it('sizes the dormant ring, which the spec never does', () => {
    expect(DEFAULT_LIMITS.dormantRingBytes).toBeGreaterThan(0)
    expect(LIMIT_PROVENANCE.dormantRingBytes).toMatch(/guess/i)
  })
})

describe('automated mode ships off', () => {
  it('configures no trigger by default', () => {
    const c = resolveConfig(MINIMAL)
    expect(c.flightRecorder.triggers).toEqual({})
  })

  it('starts at baseline by default', () => {
    expect(resolveConfig(MINIMAL).detail).toBe('baseline')
  })

  it('does not invent a trigger the customer did not name', () => {
    const c = resolveConfig({
      ...MINIMAL,
      flightRecorder: { triggers: { stall: { afterMs: 500 } } },
    })
    expect(c.flightRecorder.triggers.stall).toEqual({ afterMs: 500 })
    expect(c.flightRecorder.triggers.cadence).toBeUndefined()
  })

  it('fills in the parameters of a trigger that IS named', () => {
    const c = resolveConfig({
      ...MINIMAL,
      flightRecorder: { triggers: { cadence: {} as never } },
    })
    // The cadence multiple and a warm-up are filled in, so a named trigger is
    // usable without the customer knowing every knob.
    expect(c.flightRecorder.triggers.cadence?.multiple).toBe(3)
    expect(c.flightRecorder.triggers.cadence?.minSamples).toBeGreaterThan(0)
  })

  it('reports the string-array form rather than silently ignoring it', () => {
    const { problems, onProblem } = collect()
    const c = resolveConfig(
      { ...MINIMAL, flightRecorder: { triggers: ['stall'] as never } },
      { onProblem },
    )
    expect(c.flightRecorder.triggers).toEqual({})
    expect(problems.some((p) => p.key === 'flightRecorder.triggers')).toBe(true)
  })
})

describe('typos are reported, not swallowed', () => {
  it('names an unknown top-level key', () => {
    const { problems, onProblem } = collect()
    resolveConfig({ ...MINIMAL, detial: 'headers' } as never, { onProblem })
    expect(problems.map((p) => p.key)).toContain('detial')
  })

  it('names an unknown detail level and stays at baseline', () => {
    const { problems, onProblem } = collect()
    const c = resolveConfig({ ...MINIMAL, detail: 'everything' as never }, { onProblem })
    expect(c.detail).toBe('baseline')
    expect(problems.map((p) => p.key)).toContain('detail')
  })
})

describe('identity', () => {
  it('mints a session id when none is given', () => {
    const a = resolveConfig(MINIMAL)
    const b = resolveConfig(MINIMAL)
    expect(a.sessionId).not.toBe('')
    expect(a.sessionId).not.toBe(b.sessionId)
  })

  it('keeps a customer-supplied session id verbatim', () => {
    expect(resolveConfig({ ...MINIMAL, sessionId: 'sess-1' }).sessionId).toBe('sess-1')
  })

  it('mints a session id in place of an empty one', () => {
    expect(resolveConfig({ ...MINIMAL, sessionId: '' }).sessionId).not.toBe('')
  })

  it('leaves actorId and contentId absent rather than inventing them', () => {
    const c = resolveConfig(MINIMAL)
    expect(c.context.actorId).toBe('')
    expect(c.context.contentId).toBe('')
  })
})

/**
 * The session ids ingest can store. Ingest refuses, without storing any of the
 * session, an upload whose id is longer than 128 UTF-8 bytes, holds a control
 * character, or is not well-formed UTF-16, so each of those is refused here,
 * at `init()`, where the customer is looking -- reported, and replaced by a
 * minted id so the session survives.
 */
describe('a supplied session id ingest could not store', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Resolve with `sessionId` and a fixed mint, collecting the reported problems. */
  function resolveWith(sessionId: string): { sessionId: string; problems: ConfigProblem[] } {
    const { problems, onProblem } = collect()
    const c = resolveConfig({ ...MINIMAL, sessionId }, { onProblem, mintSessionId: () => 'minted' })
    return { sessionId: c.sessionId, problems }
  }

  function expectRefused(sessionId: string, bytes: number): void {
    const r = resolveWith(sessionId)
    expect(r.sessionId).toBe('minted')
    expect(r.problems).toEqual([{ key: 'sessionId', code: MQ1113, got: String(bytes) }])
  }

  function expectKept(sessionId: string): void {
    const r = resolveWith(sessionId)
    expect(r.sessionId).toBe(sessionId)
    expect(r.problems).toEqual([])
  }

  it('bounds the id at 128 bytes, the bound ingest enforces', () => {
    expect(MAX_SESSION_ID_BYTES).toBe(128)
  })

  it('keeps an id of exactly 128 bytes', () => {
    expectKept('a'.repeat(128))
  })

  it('refuses an id of 129 bytes and mints one in its place', () => {
    expectRefused('a'.repeat(129), 129)
  })

  it('counts the bound in UTF-8 bytes, not in characters or code units', () => {
    // U+00E9 is one code unit and two bytes, U+20AC one code unit and three,
    // U+1F600 two code units and four.
    const two = 'é'
    const three = '€'
    const four = '\u{1f600}'
    expectKept(two.repeat(64))
    expectRefused(`${two.repeat(64)}a`, 129)
    expectKept(`${three.repeat(42)}ab`)
    expectRefused(three.repeat(43), 129)
    expectKept(four.repeat(32))
    expectRefused(`${four.repeat(32)}a`, 129)
  })

  it('refuses a C0 control character, DEL and a C1 control character', () => {
    for (const c of ['\u0000', '\t', '\n', '\u001f', '\u007f', '\u0080', '\u009f']) {
      expectRefused(`sess-${c}-1`, c < '\u0080' ? 8 : 9)
    }
  })

  it('keeps the characters either side of the control ranges', () => {
    // U+0020 and U+007E border the C0 range and DEL; U+00A0 follows C1.
    expectKept('sess- ~-1')
    expectKept('sess-\u00a0-1')
  })

  it('refuses a lone high surrogate, a lone low surrogate and a reversed pair', () => {
    // The encoder that measures the reported length writes each lone surrogate
    // as U+FFFD, three bytes.
    expectRefused('sess-\ud83d', 8)
    expectRefused('\ud83dsess', 7)
    expectRefused('sess-\ude00-1', 10)
    expectRefused('sess-\ude00\ud83d', 11)
  })

  it('reports the length, never the id, so the message cannot carry the refused id', () => {
    const r = resolveWith(`x${'\u0000'.repeat(300)}`)
    expect(r.problems).toEqual([{ key: 'sessionId', code: MQ1113, got: '301' }])
  })

  it('accepts every id the collector mints from crypto.randomUUID', () => {
    for (let i = 0; i < 200; i += 1) {
      const { problems, onProblem } = collect()
      const c = resolveConfig(MINIMAL, { onProblem })
      expect(isStorableSessionId(c.sessionId), c.sessionId).toBe(true)
      expect(problems).toEqual([])
    }
  })

  it('accepts the longest id the collector mints without crypto', () => {
    // Every random word at its widest and a clock far past today's, so the
    // fallback id is as long as it can get.
    vi.stubGlobal('crypto', undefined)
    vi.spyOn(Math, 'random').mockReturnValue(0.999_999_999)
    vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER)
    const { problems, onProblem } = collect()
    const c = resolveConfig(MINIMAL, { onProblem })
    expect(c.sessionId).toMatch(/^s-[0-9a-f]+-[0-9a-f]{32}$/)
    expect(isStorableSessionId(c.sessionId)).toBe(true)
    expect(problems).toEqual([])
  })
})

describe('the detail lattice', () => {
  it('orders baseline lowest', () => {
    expect(levelIndex('baseline')).toBe(0)
    expect(levelIndex(DETAIL_LEVELS[DETAIL_LEVELS.length - 1])).toBe(DETAIL_LEVELS.length - 1)
  })

  it('treats an unrecognised level as off the lattice', () => {
    expect(levelIndex('nonsense')).toBe(-1)
  })

  it('counts everything above baseline as elevated', () => {
    expect(isElevated('baseline')).toBe(false)
    for (const l of DETAIL_LEVELS.slice(1)) expect(isElevated(l)).toBe(true)
  })
})

describe('masking auth parameters is the default, not an option', () => {
  it('is on for a config that says nothing about privacy', () => {
    // The whole decision. A customer who reads no documentation and sets no
    // options does not send us their bearer tokens.
    const { onProblem } = collect()
    expect(resolveConfig(MINIMAL, { onProblem }).privacy.maskAuthParams).toBe(true)
  })

  it('is on for a config that supplies an empty privacy bag', () => {
    const { onProblem } = collect()
    expect(resolveConfig({ ...MINIMAL, privacy: {} }, { onProblem }).privacy.maskAuthParams).toBe(
      true,
    )
  })

  it('turns off only for a real boolean false', () => {
    const { onProblem } = collect()
    const c = resolveConfig({ ...MINIMAL, privacy: { maskAuthParams: false } }, { onProblem })
    expect(c.privacy.maskAuthParams).toBe(false)
  })

  it('stays on, and complains, for a value that merely looks false', () => {
    // `'false'` out of JSON or an environment variable is the way a safety
    // default gets silently disabled. It reports and stays on.
    const { problems, onProblem } = collect()
    const c = resolveConfig({ ...MINIMAL, privacy: { maskAuthParams: 'false' } } as never, {
      onProblem,
    })
    expect(c.privacy.maskAuthParams).toBe(true)
    expect(problems.map((p) => p.key)).toEqual(['privacy.maskAuthParams'])
  })

  it('stays on when the whole bag is the wrong shape', () => {
    const { problems, onProblem } = collect()
    const c = resolveConfig({ ...MINIMAL, privacy: 'off' } as never, { onProblem })
    expect(c.privacy.maskAuthParams).toBe(true)
    expect(problems.map((p) => p.key)).toEqual(['privacy'])
  })

  it('records its provenance as a decision rather than a guess', () => {
    // Asserted on the substance, not on a citation: the line has to say the
    // default is a decision. Matching a section number instead would pass for
    // any line that happened to quote one, and tell a reader nothing.
    expect(DEFAULT_PROVENANCE.privacy).toMatch(/not a guess/i)
    expect(DEFAULT_PROVENANCE.privacy).toMatch(/decision/i)
    expect(DEFAULT_PROVENANCE.privacy.length).toBeGreaterThan(20)
  })
})
