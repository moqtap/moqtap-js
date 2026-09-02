import type { Trace } from './types.js'

/**
 * Serialize a trace to human-readable JSON.
 *
 * Handles bigint → hex string and Uint8Array → hex string.
 * This is a one-way export for human inspection and debugging.
 * For lossless round-tripping, use the binary .moqtrace format
 * (`writeMoqtrace` / `readMoqtrace`).
 *
 * The unrecognised-key stores are part of the rendering rather than filtered
 * out of it: `extra` appears on the header, on `segment`, on `sampling` and on
 * each event, nested values and all. A view that showed only the keys this
 * version names would reintroduce, for anyone reading a trace through it,
 * exactly the loss the binary reader stopped making — and it is the view
 * someone reaches for precisely when they suspect a key went missing.
 */
export function traceToJSON(trace: Trace): string {
  return JSON.stringify(
    trace,
    (_key, value) => {
      if (typeof value === 'bigint') {
        return `0x${value.toString(16)}`
      }
      if (value instanceof Uint8Array) {
        return Array.from(value)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
      }
      return value
    },
    2,
  )
}
