/**
 * First-object arrival per group, for a receive track's `ga` field. A group
 * is reported once, when its id is `0 mod 2^k`; `k` follows the producer
 * monitor's rate rule, so this sample is a subset of the producer's.
 */

import type { GroupArrivalsWire, Mono } from '../types.js'

/** Groups a second a track that sampling aims at. Shared with `moqtap_monitor::TARGET_GROUPS_PER_SEC`. */
export const GA_TARGET_GROUPS_PER_SEC = 10

/** Whole seconds before the current one that a track's rate is measured over. Shared with `moqtap_monitor::RATE_WINDOW_SECS`. */
export const GA_RATE_WINDOW_SECS = 10

/** The largest sampling exponent the wire allows. */
export const GA_MAX_K = 20

/** Recently seen group ids a track remembers, to report each group once. */
export const GA_SEEN_WINDOW = 64

const LEVELS = GA_MAX_K + 1
const SLOTS = GA_RATE_WINDOW_SECS + 1

/** A track's rate window: groups started per second, at `second mod SLOTS`, by level. */
export const newRateWindow = (): Uint16Array => new Uint16Array(SLOTS * LEVELS)

/**
 * Move the window `w` from second `head` to the second holding `at`, and
 * return the new head. A head of -1 is a window that has seen nothing.
 */
export function rateAdvance(w: Uint16Array, head: number, at: Mono): number {
  const s = Math.floor(at / 1000)
  if (s <= head) return head
  for (let x = Math.max(head + 1, s - GA_RATE_WINDOW_SECS); x <= s; x++) {
    w.fill(0, (x % SLOTS) * LEVELS, ((x % SLOTS) + 1) * LEVELS)
  }
  return s
}

/** Count `group` in second `head`. */
export function rateAdd(w: Uint16Array, head: number, group: bigint): void {
  const i = (head % SLOTS) * LEVELS + level(group)
  if (head >= 0 && w[i]! < 0xffff) w[i]!++
}

/** Groups of the whole seconds before `head` that `k` keeps. */
export function rateKept(w: Uint16Array, head: number, k: number): number {
  let n = 0
  for (let x = 1; x <= GA_RATE_WINDOW_SECS; x++) {
    const at = ((head - x + SLOTS) % SLOTS) * LEVELS
    for (let l = k; l < LEVELS; l++) n += w[at + l]!
  }
  return n
}

/** The rate rule: the smallest `k` keeping at most the target over the window. */
export function rateRoundUp(w: Uint16Array, head: number): number {
  let k = 0
  while (k < GA_MAX_K && rateKept(w, head, k) > GA_TARGET_GROUPS_PER_SEC * GA_RATE_WINDOW_SECS) k++
  return k
}

/** The per-track group limit per interval, and the connection's `ga.dropped`/`ga.late` counters. */
export class ArrivalBudget {
  /** In-sample groups refused with `k` already at {@link GA_MAX_K}. */
  dropped = 0
  /** In-sample groups not reported for being older than every remembered one. */
  late = 0

  constructor(
    /** Groups a track may hold per interval. */
    readonly perTrack: number,
  ) {}

  static forInterval(intervalMs: number): ArrivalBudget {
    return new ArrivalBudget(
      Math.max(1, Math.ceil((GA_TARGET_GROUPS_PER_SEC * Math.max(intervalMs, 1)) / 1000)),
    )
  }
}

export class GroupArrivals {
  private readonly seen: bigint[] = new Array<bigint>(GA_SEEN_WINDOW).fill(-1n)
  private seenHead = 0
  /** The largest id evicted from {@link seen}; at or below it, a group may have been reported. */
  private floor = -1n
  private last = -1n

  private k = 0
  private readonly rate = newRateWindow()
  private sec = -1
  private rateK = 0
  private groups: bigint[] = []
  private objects: bigint[] = []
  private ats: Mono[] = []

  constructor(private readonly budget: ArrivalBudget) {}

  /** One object. Bounded work; allocates only for a group's first arrival. */
  onObject(group: bigint, object: bigint, at: Mono): void {
    if (group === this.last) return
    this.last = group
    for (let i = 0; i < GA_SEEN_WINDOW; i++) if (this.seen[i] === group) return
    const evicted = this.seen[this.seenHead]!
    if (evicted > this.floor) this.floor = evicted
    this.seen[this.seenHead] = group
    this.seenHead = (this.seenHead + 1) % GA_SEEN_WINDOW
    const sec = rateAdvance(this.rate, this.sec, at)
    if (sec > this.sec && this.sec >= 0) this.rateK = rateRoundUp(this.rate, sec)
    this.sec = sec
    rateAdd(this.rate, sec, group)
    while (this.k < this.rateK) this.raise()
    if (!inSample(group, this.k)) return
    if (group <= this.floor) {
      this.budget.late++
      return
    }
    this.groups.push(group)
    this.objects.push(object)
    this.ats.push(at)
    while (this.groups.length > this.budget.perTrack && this.k < GA_MAX_K) this.raise()
    const n = this.groups.length
    if (n > this.budget.perTrack && this.groups[n - 1] === group) {
      this.groups.pop()
      this.objects.pop()
      this.ats.pop()
      this.budget.dropped++
    }
  }

  /**
   * The interval's `ga` field, or undefined when it holds no group. Groups past
   * a gap too wide for a JSON number are left out, and counted when `closing`.
   */
  field(start: Mono, origin: Mono, closing: boolean): GroupArrivalsWire | undefined {
    const n = this.groups.length
    if (n === 0) return undefined
    const order = Array.from({ length: n }, (_, i) => i)
    const g = this.groups
    order.sort((a, b) => (g[a]! < g[b]! ? -1 : g[a]! > g[b]! ? 1 : 0))
    const dg: number[] = []
    const at: number[] = []
    const ob: [number, string][] = []
    let contiguous = true
    let prev = Math.round(start - origin)
    for (let i = 0; i < n; i++) {
      const j = order[i]!
      const gap = i === 0 ? 0n : g[j]! - g[order[i - 1]!]!
      if (gap > MAX_SAFE) {
        if (closing) this.budget.dropped += n - i
        break
      }
      const d = Number(gap)
      if (d !== 1 && i > 0) contiguous = false
      dg.push(d)
      const t = Math.round(this.ats[j]! - origin)
      at.push(t - prev)
      prev = t
      const o = this.objects[j]!
      if (o !== 0n) ob.push([i, o.toString()])
    }
    return {
      g: g[order[0]!]!.toString(),
      ...(contiguous ? {} : { dg }),
      at,
      ...(ob.length > 0 ? { ob } : {}),
      ...(this.k === 0 ? {} : { k: this.k }),
    }
  }

  /** End the interval. What was seen stays remembered. */
  reset(): void {
    this.groups = []
    this.objects = []
    this.ats = []
    this.k = 0
  }

  /**
   * End the interval without reporting what it holds: those groups are
   * forgotten, so a later object of one is reported then.
   */
  forget(): void {
    for (const g of this.groups) {
      const i = this.seen.indexOf(g)
      if (i >= 0) this.seen[i] = -1n
    }
    this.last = -1n
    this.reset()
  }

  /** Raise `k` by one, keeping only the held groups still in sample. */
  raise(): void {
    this.k++
    let w = 0
    for (let r = 0; r < this.groups.length; r++) {
      if (!inSample(this.groups[r]!, this.k)) continue
      this.groups[w] = this.groups[r]!
      this.objects[w] = this.objects[r]!
      this.ats[w] = this.ats[r]!
      w++
    }
    this.groups.length = w
    this.objects.length = w
    this.ats.length = w
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const LOW_BITS = (1n << BigInt(GA_MAX_K)) - 1n

/** The largest `k` whose sample holds `group`. */
function level(group: bigint): number {
  const low = Number(group & LOW_BITS)
  return low === 0 ? GA_MAX_K : 31 - Math.clz32(low & -low)
}

function inSample(group: bigint, k: number): boolean {
  return k === 0 || (group & ((1n << BigInt(k)) - 1n)) === 0n
}
