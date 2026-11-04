/**
 * Bytes per connection, direction and second of device mono time: every
 * stream chunk and datagram as the page reads or writes it. QUIC and HTTP/3
 * framing never reach the page and are not counted.
 */

import type { BwInput } from '../envelope/contract.js'
import type { Mono } from '../types.js'

/** One connection's bytes in one direction since the last take. */
export type BwEntry = BwInput

interface Acc {
  readonly c: number
  readonly sent: boolean
  readonly secs: Map<number, number>
  pre: number
}

export class BwCounter {
  private acc = new Map<string, Acc>()

  constructor(
    /** The mono origin, ms, that times are taken from: the run recorder's. */
    private readonly origin: Mono,
  ) {}

  private of(c: number, sent: boolean): Acc {
    const k = sent ? `${c}:1` : `${c}:0`
    let a = this.acc.get(k)
    if (a === undefined) {
      a = { c, sent, secs: new Map(), pre: 0 }
      this.acc.set(k, a)
    }
    return a
  }

  /** `n` bytes at `at`. */
  add(c: number, sent: boolean, at: Mono, n: number): void {
    if (!(n > 0)) return
    this.addSecond(c, sent, Math.floor((at - this.origin) / 1000), n)
  }

  /** `n` bytes in device second `i`. */
  addSecond(c: number, sent: boolean, i: number, n: number): void {
    if (!(n > 0)) return
    const secs = this.of(c, sent).secs
    secs.set(i, (secs.get(i) ?? 0) + n)
  }

  /** Bytes no second places. */
  addPre(c: number, sent: boolean, n: number): void {
    if (n > 0) this.of(c, sent).pre += n
  }

  get empty(): boolean {
    return this.acc.size === 0
  }

  /** Everything since the last take, seconds ascending, ordered by connection then direction. */
  take(): BwEntry[] {
    const out: BwEntry[] = []
    for (const a of this.acc.values()) {
      const secs = [...a.secs].sort((x, y) => x[0] - y[0])
      if (secs.length === 0 && a.pre === 0) continue
      out.push({ c: a.c, sent: a.sent, secs, pre: a.pre })
    }
    this.acc = new Map()
    return out.sort((x, y) => x.c - y.c || Number(x.sent) - Number(y.sent))
  }

  /** A worker's forwarded entries, already on this timeline. */
  absorb(list: readonly BwEntry[]): void {
    for (const e of list) {
      for (const [i, n] of e.secs) this.addSecond(e.c, e.sent, i, n)
      this.addPre(e.c, e.sent, e.pre)
    }
  }
}
