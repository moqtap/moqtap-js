/**
 * LEB128 columns of the v2 records: `u` unsigned LEB128, `z` zigzag of a
 * wrapping 64-bit difference, `t` zigzag of a signed integer. Every encoding
 * is minimal, so two writers given the same values agree byte for byte.
 */

const U64 = (1n << 64n) - 1n
const TWO_63 = 1n << 63n
const TWO_64 = 1n << 64n

export class LebWriter {
  private _buf: Uint8Array
  private _len = 0

  constructor(initialBytes = 256) {
    this._buf = new Uint8Array(Math.max(16, initialBytes))
  }

  get byteLength(): number {
    return this._len
  }

  byte(b: number): void {
    if (this._len === this._buf.length) {
      const next = new Uint8Array(this._buf.length * 2)
      next.set(this._buf)
      this._buf = next
    }
    this._buf[this._len++] = b & 0xff
  }

  /** A non-negative safe integer or a u64 bigint. */
  u(v: number | bigint): void {
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`u: ${v} is not a u64`)
      if (v < 0x8000_0000) {
        let n = v
        while (n >= 0x80) {
          this.byte((n & 0x7f) | 0x80)
          n >>>= 7
        }
        this.byte(n)
        return
      }
      v = BigInt(v)
    }
    if (v < 0n || v > U64) throw new RangeError(`u: ${v} is not a u64`)
    if (v < 0x8000_0000n) {
      this.u(Number(v))
      return
    }
    let n = v
    while (n >= 0x80n) {
      this.byte(Number(n & 0x7fn) | 0x80)
      n >>= 7n
    }
    this.byte(Number(n))
  }

  /** `to - from` mod 2^64, read as signed, zigzag. */
  z(to: bigint, from: bigint): void {
    const d = (to - from) & U64
    const s = d >= TWO_63 ? d - TWO_64 : d
    this.u(s >= 0n ? s << 1n : (-s << 1n) - 1n)
  }

  /** A signed safe integer, zigzag. */
  t(v: number): void {
    if (!Number.isSafeInteger(v)) throw new RangeError(`t: ${v} is not a safe integer`)
    if (v >= 0 && v < 0x4000_0000) this.u(v * 2)
    else if (v < 0 && v > -0x4000_0000) this.u(-v * 2 - 1)
    else {
      const b = BigInt(v)
      this.u(b >= 0n ? b << 1n : (-b << 1n) - 1n)
    }
  }

  bytes(): Uint8Array {
    return this._buf.slice(0, this._len)
  }
}
