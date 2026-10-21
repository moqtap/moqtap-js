/**
 * `resolveConfig` — the `init()` argument, defaulted and validated.
 *
 * Configuration comes from the `init()` argument alone: nothing here reads
 * `globalThis`, an environment variable, a `data-` attribute or a build-time
 * define. The one thing it reaches for is `crypto.randomUUID()`, to mint a
 * session id the customer did not supply, and that is a value rather than
 * configuration.
 *
 * Detect, never silently truncate. An out-of-range number is reported and then
 * replaced by the default, never clamped: `flushIntervalMs: -1` is a bug, and a
 * collector quietly running at 60 s has hidden it. An unknown key is reported
 * too — `detial: 'headers'` type-checks nowhere useful once the object has been
 * through JSON, and a typo that silently does nothing looks exactly like a
 * feature the customer believes they enabled.
 */

import {
  MQ1001,
  MQ1002,
  MQ1003,
  MQ1101,
  MQ1102,
  MQ1103,
  MQ1104,
  MQ1105,
  MQ1108,
  MQ1109,
  MQ1110,
  MQ1111,
  MQ1112,
  MQ1113,
} from '../codes.js'
import {
  type BudgetConfig,
  type CollectorConfig,
  DETAIL_LEVELS,
  type DetailLevel,
  type FlightRecorderConfig,
  type Limits,
  type MetricsConfig,
  type PrivacyConfig,
  type ResolvedConfig,
  type StorageConfig,
  type TriggerConfig,
  type UploadConfig,
} from '../types.js'
import { CONFIG_KEYS, DEFAULT_FLIGHT_RECORDER, DEFAULTS, TRIGGER_DEFAULTS } from './defaults.js'

/** A problem with the supplied config. Reported; never thrown except for the two fatals. */
export interface ConfigProblem {
  /** The dotted config path, e.g. `upload.intervalMs`. */
  readonly key: string
  /** A code from `src/codes.ts`. Its wording is in `error-codes.json`. */
  readonly code: string
  /**
   * The offending value, stringified — absent where the code is the whole
   * story. The prose lives in the registry; the value is what it cannot carry.
   */
  readonly got?: string
}

export interface ResolveOptions {
  /** Every {@link ConfigProblem} lands here. Never throws onward. */
  readonly onProblem?: (p: ConfigProblem) => void
  /** Session-id source. Injected so the suite is deterministic. */
  readonly mintSessionId?: () => string
}

/** A fresh random id: a UUID where `crypto` has one. Never contains a colon. */
export function mintId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof c?.randomUUID === 'function') {
    try {
      return c.randomUUID()
    } catch {
      // Falls through. randomUUID throws on some insecure-context polyfills.
    }
  }
  // Not a UUID and not pretending to be one, and weaker than one: it is
  // reached only where `crypto` is absent entirely. A collision would merge two
  // sessions, though never two bodies, since each instance keys its own.
  let r = ''
  for (let i = 0; i < 4; i += 1) r += Math.floor(Math.random() * 0x1_0000_0000).toString(16)
  return `s-${Date.now().toString(16)}-${r}`
}

/**
 * The longest supplied session id kept, in UTF-8 bytes.
 *
 * Ingest refuses, without storing any of the session, an upload whose id is
 * longer than this. It is the bound ingest enforces, restated here because the
 * collector and ingest ship separately. A minted id is a 36 B UUID, or under
 * 50 B without `crypto`, so it is never in reach.
 */
export const MAX_SESSION_ID_BYTES = 128

/**
 * Whether ingest can store `id`: at most {@link MAX_SESSION_ID_BYTES} UTF-8
 * bytes, well-formed UTF-16, and no C0 or C1 control character or DEL.
 *
 * One pass over the code units, measuring the bytes as it goes, rather than
 * `String.prototype.isWellFormed`: that is ES2024, newer than the oldest
 * runtime this package supports.
 */
export function isStorableSessionId(id: string): boolean {
  // Every code unit is at least one UTF-8 byte, so a longer string is refused
  // before it is walked.
  if (id.length === 0 || id.length > MAX_SESSION_ID_BYTES) return false
  let bytes = 0
  for (let i = 0; i < id.length; i += 1) {
    const c = id.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return false
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      // A high surrogate must be followed by a low one; past the end of the
      // string `charCodeAt` is NaN, which fails the range check too.
      const next = id.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      bytes += 4
      i += 1
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
    else bytes += 3
  }
  return bytes <= MAX_SESSION_ID_BYTES
}

/**
 * The session id: the supplied one when ingest can store it, otherwise a
 * minted one.
 *
 * Replaced rather than thrown, like every other non-fatal option: the session
 * is collected regardless, under an id `vitals.ids()` reports. Kept as given, a
 * refused id would cost the whole session at ingest, where nobody integrating
 * the collector would look.
 */
function sessionIdOf(v: unknown, mint: () => string, report: (p: ConfigProblem) => void): string {
  const supplied = str(v, '', 'sessionId', report)
  if (supplied === '') return mint()
  if (!isStorableSessionId(supplied)) {
    // The byte length, not the id: the id is what may hold a control character
    // or be arbitrarily long, and the message lands in the customer's logs.
    report({
      key: 'sessionId',
      code: MQ1113,
      got: String(new TextEncoder().encode(supplied).byteLength),
    })
    return mint()
  }
  return supplied
}

/* ── scalar readers ──────────────────────────────────────────────────────── */

function posInt(
  v: unknown,
  fallback: number,
  key: string,
  report: (p: ConfigProblem) => void,
  min = 1,
): number {
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
    report({ key, code: MQ1101, got: JSON.stringify(v) })
    return fallback
  }
  return Math.floor(v)
}

/**
 * A boolean option, with the fallback used for anything that is not one.
 *
 * Falling back rather than throwing matters because the only flag using this is
 * a safety default: `maskAuthParams: 'false'` — a string, out of JSON or an
 * environment variable — must not read as "off". It reports and stays on.
 */
function flag(
  v: unknown,
  fallback: boolean,
  key: string,
  report: (p: ConfigProblem) => void,
): boolean {
  if (v === undefined) return fallback
  if (typeof v !== 'boolean') {
    report({ key, code: MQ1102, got: JSON.stringify(v) })
    return fallback
  }
  return v
}

function str(
  v: unknown,
  fallback: string,
  key: string,
  report: (p: ConfigProblem) => void,
): string {
  if (v === undefined) return fallback
  if (typeof v !== 'string') {
    report({ key, code: MQ1103, got: typeof v })
    return fallback
  }
  return v
}

function detailOf(v: unknown, report: (p: ConfigProblem) => void): DetailLevel {
  if (v === undefined) return DEFAULTS.detail
  if (typeof v !== 'string' || !(DETAIL_LEVELS as readonly string[]).includes(v)) {
    report({ key: 'detail', code: MQ1105 })
    return DEFAULTS.detail
  }
  return v as DetailLevel
}

/* ── trigger config ─────────────────────────────────────────── */

/**
 * Absent stays absent.
 *
 * Automated capture ships off, so a trigger the customer did not name is never
 * defaulted into existence — {@link TRIGGER_DEFAULTS} only fills in the
 * parameters of a trigger they did name.
 */
function triggersOf(v: unknown, report: (p: ConfigProblem) => void): TriggerConfig {
  if (v === undefined) return DEFAULT_FLIGHT_RECORDER.triggers
  // Arrays first: `typeof [] === 'object'`, so an array would reach the object
  // branch and read silently as a trigger set with no keys.
  if (Array.isArray(v)) {
    // The array form is a plausible mistake, so it is reported rather than
    // leaving the customer to guess which shape survived.
    report({ key: 'flightRecorder.triggers', code: MQ1108 })
    return DEFAULT_FLIGHT_RECORDER.triggers
  }
  if (typeof v !== 'object' || v === null) {
    report({ key: 'flightRecorder.triggers', code: MQ1104 })
    return DEFAULT_FLIGHT_RECORDER.triggers
  }
  const t = v as Record<string, unknown>
  const out: {
    stall?: { readonly afterMs: number }
    trackSwitch?: Record<string, never>
    cadence?: { readonly multiple: number; readonly minSamples: number }
  } = {}

  if (t.stall !== undefined) {
    const s = (typeof t.stall === 'object' && t.stall !== null ? t.stall : {}) as {
      afterMs?: unknown
    }
    out.stall = {
      afterMs: posInt(
        s.afterMs,
        TRIGGER_DEFAULTS.stallAfterMs,
        'flightRecorder.triggers.stall.afterMs',
        report,
      ),
    }
  }
  if (t.trackSwitch !== undefined) out.trackSwitch = {}
  if (t.cadence !== undefined) {
    const c = (typeof t.cadence === 'object' && t.cadence !== null ? t.cadence : {}) as {
      multiple?: unknown
      minSamples?: unknown
    }
    out.cadence = {
      multiple: posInt(
        c.multiple,
        TRIGGER_DEFAULTS.cadenceMultiple,
        'flightRecorder.triggers.cadence.multiple',
        report,
      ),
      minSamples: posInt(
        c.minSamples,
        TRIGGER_DEFAULTS.cadenceMinSamples,
        'flightRecorder.triggers.cadence.minSamples',
        report,
      ),
    }
  }
  for (const k of Object.keys(t)) {
    if (k !== 'stall' && k !== 'trackSwitch' && k !== 'cadence') {
      report({ key: `flightRecorder.triggers.${k}`, code: MQ1109 })
    }
  }
  return Object.freeze(out)
}

/** A nested bag that must be an object if present at all. */
function bagOf(
  v: unknown,
  key: string,
  report: (p: ConfigProblem) => void,
): Record<string, unknown> | null {
  if (v === undefined) return null
  if (typeof v !== 'object' || v === null) {
    report({ key, code: MQ1104 })
    return null
  }
  return v as Record<string, unknown>
}

function limitsOf(v: unknown, report: (p: ConfigProblem) => void): Limits {
  const d = DEFAULTS.limits
  const l = bagOf(v, 'limits', report)
  if (l === null) return d
  return Object.freeze({
    maxConcurrentTransports: posInt(
      l.maxConcurrentTransports,
      d.maxConcurrentTransports,
      'limits.maxConcurrentTransports',
      report,
    ),
    controlRatePerSec: posInt(
      l.controlRatePerSec,
      d.controlRatePerSec,
      'limits.controlRatePerSec',
      report,
    ),
    dormantRingBytes: posInt(
      l.dormantRingBytes,
      d.dormantRingBytes,
      'limits.dormantRingBytes',
      report,
      1024,
    ),
    maxHeaderSlackBytes: posInt(
      l.maxHeaderSlackBytes,
      d.maxHeaderSlackBytes,
      'limits.maxHeaderSlackBytes',
      report,
    ),
    linkTimeoutMs: posInt(l.linkTimeoutMs, d.linkTimeoutMs, 'limits.linkTimeoutMs', report),
  })
}

function metricsOf(v: unknown, report: (p: ConfigProblem) => void): MetricsConfig {
  const d = DEFAULTS.metrics
  const m = bagOf(v, 'metrics', report)
  if (m === null) return d
  return Object.freeze({
    intervalMs: posInt(m.intervalMs, d.intervalMs, 'metrics.intervalMs', report, 100),
    maxTracks: posInt(m.maxTracks, d.maxTracks, 'metrics.maxTracks', report),
  })
}

function budgetOf(v: unknown, report: (p: ConfigProblem) => void): BudgetConfig {
  const d = DEFAULTS.budget
  const b = bagOf(v, 'budget', report)
  if (b === null) return d
  return Object.freeze({
    elevatedMinutes: posInt(
      b.elevatedMinutes,
      d.elevatedMinutes,
      'budget.elevatedMinutes',
      report,
      0,
    ),
  })
}

function storageOf(v: unknown, report: (p: ConfigProblem) => void): StorageConfig {
  const d = DEFAULTS.storage
  const s = bagOf(v, 'storage', report)
  if (s === null) return d
  return Object.freeze({
    quotaBytes: posInt(s.quotaBytes, d.quotaBytes, 'storage.quotaBytes', report, 0),
  })
}

function privacyOf(v: unknown, report: (p: ConfigProblem) => void): PrivacyConfig {
  const d = DEFAULTS.privacy
  const p = bagOf(v, 'privacy', report)
  if (p === null) return d
  return Object.freeze({
    maskAuthParams: flag(p.maskAuthParams, d.maskAuthParams, 'privacy.maskAuthParams', report),
  })
}

function uploadOf(v: unknown, report: (p: ConfigProblem) => void): UploadConfig {
  const d = DEFAULTS.upload
  const u = bagOf(v, 'upload', report)
  if (u === null) return d
  let early = d.earlyFlushesMs
  if (u.earlyFlushesMs !== undefined) {
    if (
      Array.isArray(u.earlyFlushesMs) &&
      u.earlyFlushesMs.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
    ) {
      early = Object.freeze([...(u.earlyFlushesMs as number[])].sort((a, b) => a - b))
    } else {
      report({ key: 'upload.earlyFlushesMs', code: MQ1110 })
    }
  }
  return Object.freeze({
    intervalMs: posInt(u.intervalMs, d.intervalMs, 'upload.intervalMs', report),
    byteThreshold: posInt(u.byteThreshold, d.byteThreshold, 'upload.byteThreshold', report),
    earlyFlushesMs: early,
    maxAttempts: posInt(u.maxAttempts, d.maxAttempts, 'upload.maxAttempts', report),
    timeoutMs: posInt(u.timeoutMs, d.timeoutMs, 'upload.timeoutMs', report),
    drainDeadlineMs: posInt(u.drainDeadlineMs, d.drainDeadlineMs, 'upload.drainDeadlineMs', report),
    beaconMaxBytes: posInt(u.beaconMaxBytes, d.beaconMaxBytes, 'upload.beaconMaxBytes', report),
  })
}

function flightRecorderOf(v: unknown, report: (p: ConfigProblem) => void): FlightRecorderConfig {
  if (v === undefined) return DEFAULT_FLIGHT_RECORDER
  if (typeof v !== 'object' || v === null) {
    report({ key: 'flightRecorder', code: MQ1104 })
    return DEFAULT_FLIGHT_RECORDER
  }
  const f = v as { depth?: unknown; triggers?: unknown; windowMs?: unknown }
  let depth: string | number = DEFAULT_FLIGHT_RECORDER.depth
  if (f.depth !== undefined) {
    if (typeof f.depth === 'string' || typeof f.depth === 'number') depth = f.depth
    else report({ key: 'flightRecorder.depth', code: MQ1111 })
  }
  return Object.freeze({
    depth,
    triggers: triggersOf(f.triggers, report),
    windowMs: posInt(
      f.windowMs,
      DEFAULT_FLIGHT_RECORDER.windowMs,
      'flightRecorder.windowMs',
      report,
      1000,
    ),
  })
}

/* ── the whole thing ─────────────────────────────────────────────────────── */

/**
 * Apply every default and validate what the customer supplied.
 *
 * Throws exactly twice — a missing `apiKey`, and an `endpoint` that was
 * supplied and is unusable — because both leave the collector unable to upload,
 * and failing at the call site beats running happily and uploading nowhere. An
 * absent `endpoint` is not one of them: it resolves to the hosted ingest.
 * Everything else is reported through `onProblem` and replaced by its default:
 * a dependency inside someone else's player does not get to throw over a
 * mistyped bucket cap.
 */
export function resolveConfig(c: CollectorConfig, opts: ResolveOptions = {}): ResolvedConfig {
  const report = (p: ConfigProblem): void => {
    try {
      opts.onProblem?.(p)
    } catch {
      // A customer callback that throws must not become this package's throw.
    }
  }

  if (typeof c !== 'object' || c === null) {
    throw new TypeError(`${MQ1001}: ${typeof c}`)
  }
  if (typeof c.apiKey !== 'string' || c.apiKey.length === 0) {
    throw new TypeError(MQ1002)
  }
  // Absent means "the hosted ingest". Supplied-but-unusable stays fatal: that is
  // a typo in an override, and quietly defaulting past it would send a
  // customer's traffic somewhere they did not choose.
  if (c.endpoint !== undefined && (typeof c.endpoint !== 'string' || c.endpoint.length === 0)) {
    throw new TypeError(MQ1003)
  }
  const endpoint = c.endpoint ?? DEFAULTS.endpoint

  for (const k of Object.keys(c)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(k)) {
      report({ key: k, code: MQ1112 })
    }
  }

  const mint = opts.mintSessionId ?? mintId
  let minted = false
  const sessionId = sessionIdOf(
    c.sessionId,
    () => {
      minted = true
      return mint()
    },
    report,
  )

  const ctx = bagOf(c.context, 'context', report) ?? {}
  const d = DEFAULTS.context

  // Every bag is resolved by its own function and every field is required in
  // `ResolvedConfig`, so a bag left unfilled is a compile error rather than an
  // `undefined` a consumer papers over with `??`.
  return Object.freeze({
    apiKey: c.apiKey,
    endpoint,
    sessionId,
    idSource: minted ? 'minted' : 'supplied',
    detail: detailOf(c.detail, report),
    context: Object.freeze({
      actorId: str(ctx.actorId, d.actorId, 'context.actorId', report),
      contentId: str(ctx.contentId, d.contentId, 'context.contentId', report),
      environment: str(ctx.environment, d.environment, 'context.environment', report),
      release: str(ctx.release, d.release, 'context.release', report),
    }),
    metrics: metricsOf(c.metrics, report),
    flightRecorder: flightRecorderOf(c.flightRecorder, report),
    budget: budgetOf(c.budget, report),
    upload: uploadOf(c.upload, report),
    storage: storageOf(c.storage, report),
    limits: limitsOf(c.limits, report),
    privacy: privacyOf(c.privacy, report),
  })
}
