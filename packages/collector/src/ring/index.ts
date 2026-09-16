/**
 * The memory-only byte ring.
 *
 * One implementation, two configured instances: The dormant pre-key buffer,
 * which holds wire bytes from module-eval time until a key arrives, and the
 * flight recorder. Both are bounded in bytes and neither is ever persisted —
 * The rule, and a privacy guarantee rather than a performance choice, since
 * the ring holds media payloads.
 */

export type { RingEntry, RingOptions } from './byte-ring.js'
export { ByteRing, parseByteDepth } from './byte-ring.js'
