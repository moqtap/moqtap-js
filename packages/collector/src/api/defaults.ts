/**
 * Every threshold this package has, as a named key with a recorded default and
 * a one-line provenance string.
 *
 * The rule this file exists to satisfy, rather than a handful of `const`s next
 * to the code that reads them:
 *
 * > **No threshold is a constant.** Every one ships as a named config key with
 * > a recorded default and its provenance in one line ("guess, pending field
 * > data" is legitimate; a silent constant is not), so the first customer's
 * > traffic sets the real number instead of our arguing about it.
 *
 * Every hard-coded number in the design lives here as a key: the concurrent
 * transport cap, the flush schedule and byte threshold, the beacon cap, the
 * control-plane rate ceiling, the cadence trigger's multiple, and the dormant
 * ring — which nothing else sizes at all.
 *
 * **`DEFAULT_PROVENANCE` is not decoration.** A default with no provenance is
 * indistinguishable from a measured one, and the whole point of the rule is
 * that the first customer's traffic — not an argument in a review — sets the
 * real number. "Guess, pending field data" is a legitimate entry and appears
 * many times below.
 *
 * **On the PURE annotations.** `Object.freeze` is a call, so a bundler must
 * assume it has side effects and keep it, along with everything it references.
 * That pinned all four provenance tables into every consumer's bundle — about
 * 2.4 KB gzipped of English prose that no runtime code reads — even for an
 * application importing nothing but `init`. The annotation tells the bundler
 * the call is pure, so the tables survive only where something actually names
 * them. Removing it silently re-adds the 2.4 KB, and `bun run size` will not
 * catch it, because that measurement holds every export alive on purpose.
 */

import {
  type CollectorConfig,
  DETAIL_LEVELS,
  type DetailLevel,
  type FlightRecorderConfig,
  type Limits,
  type MetricsConfig,
  type PrivacyConfig,
  type ResolvedConfig,
  type UploadConfig,
} from '../types.js'

/* ── the detail lattice ──────────────────────────────────────────────────── */

/**
 * Where a level sits on {@link DETAIL_LEVELS}. `-1` for anything unrecognised,
 * so `detail: 'headers+size'` is caught and reported rather than compared as a
 * string and silently treated as some level or other.
 */
export function levelIndex(l: DetailLevel | string | undefined): number {
  if (typeof l !== 'string') return -1
  return (DETAIL_LEVELS as readonly string[]).indexOf(l)
}

/** `true` when `l` ships more than {@link BASELINE} — i.e. when it is billable. */
export function isElevated(l: DetailLevel): boolean {
  return levelIndex(l) > 0
}

export const BASELINE: DetailLevel = 'baseline'

/* ── limits ──────────────────────────────────────────────────────────────── */

export const DEFAULT_LIMITS: Limits = /*#__PURE__*/ Object.freeze({
  maxConcurrentTransports: 8,
  controlRatePerSec: 5000,
  dormantRingBytes: 1024 * 1024,
  maxHeaderSlackBytes: 4096,
})

/** The delivery path. */
export const DEFAULT_UPLOAD: UploadConfig = /*#__PURE__*/ Object.freeze({
  intervalMs: 60_000,
  byteThreshold: 32 * 1024,
  earlyFlushesMs: /*#__PURE__*/ Object.freeze([5_000, 15_000, 45_000]),
  maxAttempts: 5,
  timeoutMs: 10_000,
  stopDrainDeadlineMs: 2_000,
  beaconMaxBytes: 64 * 1024,
})

/** One line per {@link UploadConfig} key. */
export const UPLOAD_PROVENANCE: { readonly [K in keyof UploadConfig]: string } =
  /*#__PURE__*/ Object.freeze({
    intervalMs:
      'Paired with byteThreshold, whichever comes first. Sets the "a crash loses at most 60 seconds" claim.',
    byteThreshold: 'Flush every 32 KB accumulated, or every intervalMs, whichever comes first.',
    earlyFlushesMs:
      'Front-loaded at ready, +5 s, +15 s and +45 s, because everything interesting about setup happens in the first seconds and a session that dies during establishment must not be lost.',
    maxAttempts:
      "Matches the flush module's own default. Guess, pending field data: the right number depends on how long ingest stays down, which nothing has observed.",
    timeoutMs:
      'Ingest being down, slow, or tarpitted must never affect the playback or publishing of the page the collector sits inside. `fetch` carries no timeout of its own, so a blackholed endpoint that accepts the socket and answers nobody leaves one request pending for the life of the page. Guess, pending field data — 10 s is orders of magnitude above a healthy upload (30 ms on the test harness) and well below the point at which a stalled request is still worth waiting for.',
    stopDrainDeadlineMs:
      'The bound a per-request timeout cannot give: maxAttempts requests at timeoutMs each, plus backoff, is minutes, and `stop()` is awaited by a page tearing down. Guess, pending field data — 2 s is what a teardown can absorb. Expiry is not loss: the chunk stays queued and persisted.',
    beaconMaxBytes:
      'sendBeacon caps around 64 KB and is best-effort. Platform-imposed, not chosen.',
  })

/** The rollup. */
export const DEFAULT_METRICS: MetricsConfig = /*#__PURE__*/ Object.freeze({
  intervalMs: 10_000,
  maxTracks: 1024,
})

/** One line per {@link MetricsConfig} key. */
export const METRICS_PROVENANCE: { readonly [K in keyof MetricsConfig]: string } =
  /*#__PURE__*/ Object.freeze({
    intervalMs:
      'Guess, pending field data. 10 s keeps a rollup inside each of the front-loaded flushes (+5/+15/+45 s), which a 60 s interval would leave empty.',
    maxTracks:
      "Matches the decode module's DEFAULT_MAX_BUCKETS. Guess, pending field data — a five-rendition ladder with audio uses tens, so 1024 only fires on a relay flapping aliases.",
  })

/** One line per {@link Limits} key. */
export const LIMIT_PROVENANCE: { readonly [K in keyof Limits]: string } =
  /*#__PURE__*/ Object.freeze({
    maxConcurrentTransports:
      'Real clients are genuinely bounded near 8, so the cap only ever fires on something wrong. Cumulative use is deliberately uncapped.',
    controlRatePerSec:
      'Guess in origin, but it is the number the overrun record quotes ("control-plane rate exceeded 5,000/s"), so the client and the record agree by construction.',
    dormantRingBytes:
      'Nothing else sizes the dormant ring. Guess, pending field data — 1 MB is a few seconds of a single 2 Mb/s track, and it is paid by every page that imports the package, keyed or not.',
    maxHeaderSlackBytes:
      "Matches the decode module's DEFAULT_HEADER_SLACK_BYTES. A subgroup header is tens of bytes; 4 KB is a chunk-boundary allowance, not a buffer. Over it the stream is declared desynchronised rather than buffered further.",
  })

/* ── flight recorder ─────────────────────────────────────────────────────── */

export const DEFAULT_FLIGHT_RECORDER: FlightRecorderConfig = /*#__PURE__*/ Object.freeze({
  // An unvalidated default: it ships as a config key so field data can correct
  // it, rather than as a constant nobody can see.
  depth: '32MB',
  // Automated capture ships OFF: a fresh install can never generate spend the
  // customer did not ask for. Absent means off for all three triggers.
  triggers: /*#__PURE__*/ Object.freeze({}),
  // The post-event timeout — the backstop for a developer who arms a trigger
  // and never calls resolve(). 15 s, decided rather than guessed, and short on
  // purpose: the pre-trigger ring already holds what a longer window could not
  // recover anyway.
  windowMs: 15_000,
})

/**
 * The trigger defaults a customer gets when they name a trigger but not its
 * parameters. Never applied to an absent trigger — absent stays off.
 */
export const TRIGGER_DEFAULTS = /*#__PURE__*/ Object.freeze({
  /** No stall figure is fixed anywhere. Guess, pending field data. */
  stallAfterMs: 2_000,
  /** The cadence trigger fires at 3x the observed median. */
  cadenceMultiple: 3,
  /** The cadence trigger needs a warm-up. Guess, pending field data. */
  cadenceMinSamples: 20,
})

/* ── the whole resolved config ───────────────────────────────────────────── */

/**
 * Masking defaults to ON, and the default is the whole decision.
 *
 * A customer who reads no documentation and sets no options does not send us
 * their bearer tokens. Every other arrangement makes the safe outcome depend on
 * somebody having thought about it, and the people least likely to have thought
 * about it are the ones running a trial on production traffic.
 */
export const DEFAULT_PRIVACY: PrivacyConfig = /*#__PURE__*/ Object.freeze({
  maskAuthParams: true,
})

/**
 * Where uploads go when `init()` names no endpoint.
 *
 * Its own origin rather than a path on the marketing site, so the two can be
 * rate-limited, moved and blocked independently of each other.
 */
export const DEFAULT_ENDPOINT = 'https://ingest.moqtap.com/v1/ingest'

/**
 * Every default, in one frozen object.
 *
 * `apiKey` has no meaningful default and is empty here: `resolveConfig` refuses
 * a config without one rather than inventing it, because there is nothing to
 * authorise with and nobody to attribute the bytes to.
 *
 * `endpoint` does have one, and it is the hosted ingest. It stays overridable,
 * so a deployment sending to its own collector sets it and everyone else says
 * nothing. An endpoint that was supplied and is unusable is still fatal -- that
 * is a typo in an override, not an absence, and defaulting past it would send a
 * customer's traffic somewhere they did not choose.
 *
 * The empty strings on `sessionId`, `actorId`, `contentId`, `environment` and
 * `release` mean *absent*, not *empty*: every field of `ResolvedConfig` is
 * required, so there is no way to express absence and the sentinel is read back
 * as absence at every use site.
 */
export const DEFAULTS: ResolvedConfig = /*#__PURE__*/ Object.freeze({
  apiKey: '',
  endpoint: DEFAULT_ENDPOINT,
  sessionId: '',
  detail: BASELINE,
  drafts: /*#__PURE__*/ Object.freeze([]),
  context: /*#__PURE__*/ Object.freeze({
    actorId: '',
    contentId: '',
    environment: '',
    release: '',
  }),
  metrics: DEFAULT_METRICS,
  flightRecorder: DEFAULT_FLIGHT_RECORDER,
  budget: /*#__PURE__*/ Object.freeze({ elevatedMinutes: 60 }),
  upload: DEFAULT_UPLOAD,
  storage: /*#__PURE__*/ Object.freeze({ quotaBytes: 8 * 1024 * 1024 }),
  limits: DEFAULT_LIMITS,
  privacy: DEFAULT_PRIVACY,
}) as ResolvedConfig

/** One line per top-level {@link ResolvedConfig} key. */
export const DEFAULT_PROVENANCE: { readonly [K in keyof ResolvedConfig]: string } =
  /*#__PURE__*/ Object.freeze({
    apiKey:
      'No default. `init()` throws without one — there is nowhere to send to and nothing to authorise.',
    endpoint:
      'Defaults to the hosted ingest at https://ingest.moqtap.com/v1/ingest and stays overridable for a self-hosted or proxied collector. Upload is a `fetch()` POST, so whichever origin is in force is the one connect-src entry a page needs.',
    sessionId:
      'Minted with crypto.randomUUID(). Feeds sha256(sessionId:segmentSeq), and ingest dedupes exactly, so a colliding id is a silently discarded and under-billed session. A customer-supplied constant cannot be prevented here.',
    detail:
      'Baseline is always on and always the same. Elevation is billable, so the default can only be baseline.',
    drafts:
      'Empty means no pin: one chunk fetched at session time for the negotiated draft. A pin makes the import eager and costs both chunks — 10.6 KB gz against 5.3 — so it ships off.',
    context:
      'Every field absent. actorId is accepted raw, never hashed, and treated as personal data — the one field with real privacy weight, where no default can be right. contentId, environment and release are absent for the ordinary reason that only the customer knows them; their cardinality is bounded nowhere, and ingest alarms on growth rate instead.',
    metrics: 'See METRICS_PROVENANCE — one line per key.',
    flightRecorder:
      'depth 32MB, unvalidated; triggers all absent, so automated capture ships off; windowMs 15 s, decided rather than guessed.',
    budget:
      'elevatedMinutes 60. The ceiling is denominated in elevated minutes; the number itself is a guess, pending field data.',
    upload: 'See UPLOAD_PROVENANCE — one line per key.',
    storage:
      'quotaBytes 8 MB. Guess, pending field data — the observed backlog distribution sets the real number. Explicitly NOT derived from flightRecorder.depth.',
    privacy:
      'Masking defaults to ON. Not a guess and not pending field data — the default IS the decision, because a safe outcome that depends on having read the documentation is not a safe outcome.',
    limits: 'See LIMIT_PROVENANCE — one line per key.',
  })

/**
 * The keys `CollectorConfig` accepts. Anything else is a typo, and a typo in a
 * config object is silent by default — `detial: 'headers'` type-checks against
 * an excess-property check only at a literal call site, and not at all when the
 * object arrives from JSON.
 */
export const CONFIG_KEYS: readonly (keyof CollectorConfig)[] = /*#__PURE__*/ Object.freeze([
  'apiKey',
  'endpoint',
  'sessionId',
  'detail',
  'drafts',
  'context',
  'metrics',
  'flightRecorder',
  'budget',
  'upload',
  'storage',
  'limits',
  'privacy',
  'onInternalError',
])
