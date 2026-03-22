import type { Trace } from "./types.js";

/**
 * Serialize a trace to human-readable JSON.
 *
 * Handles bigint → hex string and Uint8Array → hex string.
 * This is a one-way export for human inspection and debugging.
 * For lossless round-tripping, use the binary .moqtrace format
 * (`writeMoqtrace` / `readMoqtrace`).
 */
export function traceToJSON(trace: Trace): string {
  return JSON.stringify(
    trace,
    (_key, value) => {
      if (typeof value === "bigint") {
        return `0x${value.toString(16)}`;
      }
      if (value instanceof Uint8Array) {
        return Array.from(value)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      return value;
    },
    2,
  );
}
