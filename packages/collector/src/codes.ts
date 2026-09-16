/**
 * Every error code this package can emit.
 *
 * The wording lives in `error-codes.json`, not here: messages are string
 * literals and string literals ship, and the prose these codes stand in for
 * comes to roughly 2 KB gzipped in every page that loads the collector. A
 * runtime message is the code and the offending value and nothing else —
 * `MQ2101: 1.5`. The prose is recoverable from the registry; which input was
 * rejected is not. Where there is no offending value the code is the message.
 *
 * Blocks: `1xxx` configuration, `2xxx` envelope, `3xxx` ring and flight
 * recorder, `4xxx` customer metrics, `5xxx` flush/upload/beacon, `6xxx`
 * transport seam and draft negotiation.
 *
 * Rules, all enforced by `codes.test.ts`: a code is permanent — retire it by
 * removing the constant and marking the registry entry `retired`, never by
 * reusing the number; never write a bare `MQ####` at a call site, import the
 * constant; every constant has a registry entry and vice versa.
 *
 * These are `const` string literals rather than one frozen object so that a
 * bundler drops the ones a given consumer cannot reach.
 */

/* ── 1xxx — configuration ────────────────────────────────────────────────── */

/** `init()` was given something that is not a config object. Fatal. */
export const MQ1001 = 'MQ1001'
/** `init()` was given no `apiKey`. Fatal. */
export const MQ1002 = 'MQ1002'
/** `init()` was given an `endpoint` that is not a usable string. Fatal. */
export const MQ1003 = 'MQ1003'
/** `init()` was called while an earlier collector was still running. */
export const MQ1004 = 'MQ1004'
/** A number option was not a finite number at or above its minimum. */
export const MQ1101 = 'MQ1101'
/** A boolean option was not a boolean. */
export const MQ1102 = 'MQ1102'
/** A string option was not a string. */
export const MQ1103 = 'MQ1103'
/** An option that must be an object was not one. */
export const MQ1104 = 'MQ1104'
/** `detail` was not one of the levels on the lattice. */
export const MQ1105 = 'MQ1105'
/** `drafts` was not an array. */
export const MQ1106 = 'MQ1106'
/** A draft in the pin is not one this build supports. Dropped, pin kept. */
export const MQ1107 = 'MQ1107'
/** `flightRecorder.triggers` was an array; it must be an object keyed by kind. */
export const MQ1108 = 'MQ1108'
/** A key under `flightRecorder.triggers` is not a trigger kind. Ignored. */
export const MQ1109 = 'MQ1109'
/** `upload.earlyFlushesMs` was not an array of positive offsets. */
export const MQ1110 = 'MQ1110'
/** `flightRecorder.depth` was neither a size string nor a byte count. */
export const MQ1111 = 'MQ1111'
/** An unrecognised top-level config key. Ignored. */
export const MQ1112 = 'MQ1112'

/* ── 2xxx — envelope ─────────────────────────────────────────────────────── */

/** A frame payload is longer than a 31-bit length prefix can carry. */
export const MQ2001 = 'MQ2001'
/** `readFrames` was handed a whole body, preamble included, not a frame stream. */
export const MQ2002 = 'MQ2002'
/** A frame's 4-byte length prefix is cut short. */
export const MQ2003 = 'MQ2003'
/** A frame declares more bytes than the body still holds. */
export const MQ2004 = 'MQ2004'
/** `segmentSeq` was not a non-negative safe integer. */
export const MQ2101 = 'MQ2101'
/** `crypto.subtle` is unavailable, so the key cannot be derived asynchronously. */
export const MQ2102 = 'MQ2102'
/** `CompressionStream('gzip')` is unavailable in this environment. */
export const MQ2201 = 'MQ2201'

/* ── 3xxx — ring and flight recorder ─────────────────────────────────────── */

/** `maxBytes` was not a positive byte count. */
export const MQ3001 = 'MQ3001'
/** `maxEntries` was below one. */
export const MQ3002 = 'MQ3002'
/** A byte depth resolved to a non-positive count. */
export const MQ3003 = 'MQ3003'
/** A byte depth was neither a size string nor a byte count. */
export const MQ3004 = 'MQ3004'
/** A byte depth used a unit suffix this parser does not know. */
export const MQ3005 = 'MQ3005'

/* ── 4xxx — customer metrics ─────────────────────────────────────────────── */

/** `defineMetric` was given an empty name. */
export const MQ4001 = 'MQ4001'
/** `defineMetric` was given an aggregation that is not sum, gauge or histogram. */
export const MQ4002 = 'MQ4002'
/** `defineMetric` re-registered a live metric with different terms. */
export const MQ4003 = 'MQ4003'
/** `defineMetric` would exceed the per-session metric cap. */
export const MQ4004 = 'MQ4004'
/** `defineMetric` was given bucket boundaries that are not finite and ascending. */
export const MQ4005 = 'MQ4005'
/** `observe` named a metric that was never registered. */
export const MQ4006 = 'MQ4006'
/** `observe` was given more labels than one series may carry. */
export const MQ4007 = 'MQ4007'
/** Further metric errors this session are suppressed. */
export const MQ4008 = 'MQ4008'

/* ── 5xxx — flush, upload, beacon ────────────────────────────────────────── */

/** The tail segment was refused by both `sendBeacon` and keepalive `fetch`. */
export const MQ5001 = 'MQ5001'
/** A drain deadline expired; the attempt was abandoned, the chunk kept. */
export const MQ5002 = 'MQ5002'

/* ── 6xxx — transport seam and drafts ────────────────────────────────────── */

/** A `WebTransport` collection this hook needs exposes no `values()`. */
export const MQ6001 = 'MQ6001'
