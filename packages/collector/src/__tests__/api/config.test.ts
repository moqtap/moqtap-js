/**
 * `resolveConfig`, `DEFAULTS` and `DEFAULT_PROVENANCE`.
 *
 * The tests below are about behaviour a customer can observe, not about the
 * shape of the object: that every threshold has a default *and* a provenance
 * line, that automated mode really does ship off, that a mistyped key is
 * reported rather than swallowed, and that the two fatal misconfigurations fail
 * at the call site instead of producing a collector that uploads nowhere.
 */

import { describe, expect, it } from 'vitest'
import { type ConfigProblem, resolveConfig } from '../../api/config.js'
import {
  DEFAULT_LIMITS,
  DEFAULT_PROVENANCE,
  DEFAULT_UPLOAD,
  DEFAULTS,
  isElevated,
  LIMIT_PROVENANCE,
  levelIndex,
} from '../../api/defaults.js'
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
    // The 8-transport cap, the 32 KB / 60 s seal, the 5/15/45 s early flushes,
    // the 64 KB beacon cap, the 5,000/s control rate.
    expect(DEFAULT_LIMITS.maxConcurrentTransports).toBe(8)
    expect(DEFAULT_UPLOAD.byteThreshold).toBe(32 * 1024)
    expect(DEFAULT_UPLOAD.intervalMs).toBe(60_000)
    expect([...DEFAULT_UPLOAD.earlyFlushesMs]).toEqual([5_000, 15_000, 45_000])
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
    expect(c.flightRecorder.triggers.trackSwitch).toBeUndefined()
  })

  it('fills in the parameters of a trigger that IS named', () => {
    const c = resolveConfig({
      ...MINIMAL,
      flightRecorder: { triggers: { cadence: {} as never, trackSwitch: {} } },
    })
    // The cadence multiple and a warm-up are filled in, so a named trigger is
    // usable without the customer knowing every knob.
    expect(c.flightRecorder.triggers.cadence?.multiple).toBe(3)
    expect(c.flightRecorder.triggers.cadence?.minSamples).toBeGreaterThan(0)
    expect(c.flightRecorder.triggers.trackSwitch).toEqual({})
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

  it('drops an unsupported draft from the pin without emptying it', () => {
    const { problems, onProblem } = collect()
    const c = resolveConfig({ ...MINIMAL, drafts: [20, 14 as never] }, { onProblem })
    // An emptied pin reads as "no pin" to the loader, which would turn a typo
    // into "load anything" — the opposite of what a pin is for.
    expect([...c.drafts]).toEqual([20])
    expect(problems.map((p) => p.key)).toContain('drafts')
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

  it('leaves actorId and contentId absent rather than inventing them', () => {
    const c = resolveConfig(MINIMAL)
    expect(c.context.actorId).toBe('')
    expect(c.context.contentId).toBe('')
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
