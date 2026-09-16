/**
 * Non-interference, made falsifiable.
 *
 * The guarantee: ingest being down, slow, or tarpitted must never affect the
 * customer's playback or publishing. "Zero effect" is not a testable claim —
 * every number below is measured on a machine with a garbage collector, a
 * scheduler and other tenants, so two identical arms never produce identical
 * distributions, and a test written against literal zero either fails constantly
 * or is written so loosely that nothing can fail it. So the experiment is stated
 * instead, and every number in it is named in {@link DESIGN} below:
 *
 * - **Baseline**: the same collector, the same player, against a **healthy**
 *   ingest. Not "no collector" — the guarantee under test is that *ingest health*
 *   does not reach the page, so ingest health is the only variable that moves.
 *   The no-collector arm is measured too, and reported, but it answers a
 *   different question (what the collector itself costs) and asserts nothing.
 * - **Treatments**: `blackhole`, `tarpit`, and `500` (the retry-with-backoff
 *   path), each a real socket-level fault from `fault-server.ts`.
 * - **Sample size**: {@link SAMPLE} objects per direction per arm, taken as
 *   {@link ROUNDS} independent blocks of {@link SAMPLE_PER_ROUND}, each after
 *   discarding the first {@link WARMUP}.
 * - **Tolerance**: {@link TOLERANCE_FLOOR}, per metric and per statistic,
 *   absolute, measured on this runner, widened at run time by the noise this
 *   run actually showed and hard-capped at {@link AUTO_MAX_FACTOR}× the floor.
 * - **Zero-tolerance assertions**: object counts. Not one object may be lost,
 *   delayed out of the run, or duplicated, under any fault, in any round. That
 *   part of "zero effect" *is* exactly testable, so it is tested exactly.
 *
 * ── Arm order is the loudest variable, so it is counterbalanced
 *
 * Run as one long block per arm, position in the run dominates the treatment.
 * Measured that way, `writeCall` p50 by slot: 0.091 / 0.091 / 0.075 / 0.072 /
 * 0.061 / 0.058 ms — monotone in **slot**, because the process keeps getting
 * faster over the first half-minute of its life (tiering up, warmed caches). The
 * same curve put two *identical* healthy arms 0.900 ms apart on `writeCall` p95
 * against a 1 ms tolerance: 90% of the budget spent on nothing but running order.
 *
 * So the arms are **interleaved**:
 *
 * - {@link ROUNDS} rounds of the whole arm set, {@link SAMPLE_PER_ROUND}
 *   measured objects each, and an arm's reported statistic is the **median
 *   across its rounds**. A single bad round — a GC, a background process, one
 *   missed timer tick — is outvoted rather than averaged in.
 * - Odd rounds run the arm list forwards, even rounds backwards. Over four
 *   rounds every arm occupies the same *sum* of run positions (54 slots) **and**
 *   the same sum for the middle two rounds (27), which is what the median of
 *   four actually reads: drift that is linear in time cancels between arms
 *   exactly, instead of landing on whichever arm ran late.
 * - What is **asserted** is the median of the four *per-round* differences, not
 *   the difference of the two medians — {@link pairedExcess}. Only the first
 *   cancels a round that was slow for everyone: measured under load, one round
 *   pushed every arm's `ready` p50 by 20 ms at once, which the paired form
 *   subtracts away and the unpaired form keeps in whichever arm the median
 *   happened to land on.
 *
 * ── Four properties that keep this from being a test that cannot fail
 *
 * 1. **The fault is proved to have engaged**, in every round. Each treatment arm
 *    asserts the server actually saw requests in that mode. A collector that
 *    never uploaded would sail through every latency comparison.
 * 2. **The instrument is calibrated.** A final arm injects a known
 *    {@link SENSITIVITY_STALL_MS} ms of synchronous work per object on the
 *    page's data path and asserts the harness **catches** it against these same
 *    tolerances. If that arm ever passes the non-interference check, the
 *    tolerances have gone slack and every other result in the file is worthless.
 * 3. **The tolerances cannot drift upwards without bound.** They are derived at
 *    run time from this run's noise, but only ever between the measured floor
 *    and {@link AUTO_MAX_FACTOR}× it, and the calibration stall is larger than
 *    any `writeCall` tolerance that clamp can produce — asserted in "the harness
 *    can fail" below rather than left to arithmetic in a comment.
 * 4. **The baseline is proved stable.** The healthy arm runs twice in every
 *    round and the two must agree within the tolerance the file asserts with.
 *    Because that tolerance is capped, the check still bites: it fails when the
 *    machine's own noise is so large that a tolerance covering it would no
 *    longer catch interference, rather than passing anyway.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import type { Collector } from '../../api/init.js'
import { init } from '../../index.js'
import { type FaultMode, type FaultServer, startFaultServer } from './fault-server.js'
import {
  installFakeWebTransport,
  type PlayerMetrics,
  round,
  runReferencePlayer,
  type Summary,
  summarise,
} from './reference-player.js'

/* ── the experiment, stated ──────────────────────────────────────────────── */

/**
 * How many times the whole arm set runs.
 *
 * **Four, doing three jobs at once.** ≥ 3 so a median outvotes a single bad
 * round rather than averaging it in; **even** so the forwards/backwards
 * counterbalance gives every arm the same mean position in the run; and no
 * larger because this file cannot afford it — at {@link OBJECTS} objects an arm
 * and ~26 ms of wall clock per object on this runner (the publish sink is paced
 * by `setTimeout`, whose granularity here is ~15.6 ms), 29 arm runs cost 36 s
 * and the whole file 43 s, measured over five runs.
 */
const ROUNDS = 4
/**
 * Samples discarded from the head of every series, in every round.
 *
 * The first objects of a *session* pay for things that happen exactly once: JIT
 * of the decode path, the dynamic `import()` of the draft-20 chunk, the first
 * rollup tick, and the first front-loaded flush. The process-wide half of that
 * is paid by the discarded warm-up arm; what is left for a per-arm warm-up to
 * cover is the collector instance's own start-up, whose last scheduled event is
 * the third early flush at +260 ms — 20 objects at the {@link CADENCE_MS} ms
 * receive cadence is 320 ms, past it with margin.
 *
 * **Measured.** Recomputing one run's healthy arms with warm-ups of 0, 10, 20
 * and 30 moved nothing this file asserts: `writeCall` p50 0.089/0.090/0.090/
 * 0.091 ms with p95 0.276 ms flat for `baseline`, and 0.058 ms with p95
 * 0.188 ms flat for `baseline-2`. There is no per-arm transient left to discard
 * once the warm-up *arm* has run, so these 20 are margin for slower hardware
 * rather than a correction — paid {@link ROUNDS} times per arm, which is what
 * makes the size of this number matter.
 */
const WARMUP = 20
/** Measured samples per series per arm **per round**. */
const SAMPLE_PER_ROUND = 25
/** Objects per direction per arm per round, before warm-up is discarded. */
const OBJECTS = WARMUP + SAMPLE_PER_ROUND
/** Measured samples per series per arm, over the whole run. */
const SAMPLE = SAMPLE_PER_ROUND * ROUNDS

/**
 * Milliseconds between the peer's object emissions — about 62 objects/s, which
 * is a plausible video track.
 *
 * **Above the runner's timer granularity, deliberately.** Windows' default
 * timer resolution is ~15.6 ms, so a 4 ms cadence is not a cadence: every
 * `setTimeout` lands a tick late, the producer runs at a quarter of the rate
 * it asked for, and every arm — including the one with no collector in it —
 * shows unbounded "lateness" that no collector caused. Measured, not assumed:
 * at a 4 ms cadence `readyLatencyMs` had a p50 of 15.2 ms in every arm,
 * including `no-collector`, which is the granularity and nothing else.
 */
const CADENCE_MS = 16
/**
 * Milliseconds the publish sink takes per object.
 *
 * Set equal to the production cadence so the publisher is genuinely
 * backpressured for the whole arm: `desiredSize` sits at or below zero, which
 * is the condition the `writer.ready` sampling exists for and the only state
 * in which `readyLatencyMs` is a measurement rather than a row of zeroes.
 */
const DRAIN_MS = 16
const PAYLOAD_BYTES = 200

/** The three page-observable series this file compares between arms. */
type Metric = 'writeCall' | 'ready' | 'arrival'
type Stat = 'p50' | 'mean' | 'p95'
type Tolerances = Readonly<Record<Metric, Readonly<Partial<Record<Stat, number>>>>>

const METRICS = ['writeCall', 'ready', 'arrival'] as const

/**
 * Per-metric absolute tolerance **floor**, in milliseconds, on a treatment arm's
 * excess over the baseline arm, with the provenance of each number.
 *
 * **Measured, then rounded up.** Four full runs of this file on the development
 * machine (Windows 11, Node 24) put the worst excess of any fault arm over its
 * healthy baseline at: `writeCall` p50 0.000 / mean 0.001 / p95 0.023 ms,
 * `ready` p50 0.393 ms, `arrival` p50 0.004 / mean 0.002 / p95 0.045 ms. Every
 * number below is the next round number above that. They are a property of the
 * runner rather than of the collector — {@link deriveTolerances} adapts them
 * upwards within a cap, and the calibration arm is what says so when they have
 * been loosened too far.
 *
 * **`writeCall` is guarded hardest** because it measures a synchronous section:
 * no timer, no event loop, no sink. The hook's patched `write` runs `onChunk`
 * and only then delegates, so the whole of the collector's per-object cost on
 * the page's own thread of control is inside this number. It is the metric a
 * regression moves first.
 *
 * **`ready` is asserted on its p50 only, a limit of the runner rather than
 * leniency.** The publish sink is paced by `setTimeout` and the runner's timer
 * is quantised — ~15.6 ms on Windows — so `readyLatencyMs` is two-humped and
 * only its median is stable. Its **p95** moves by a whole tick when one tick is
 * missed: one run in four showed a tarpit arm at 48.99 ms against a 31.27 ms
 * baseline, in an arm that had made precisely one upload attempt in its whole
 * life, and a p95 tolerance big enough to survive that (20 ms) is too big to
 * catch anything real. Its **mean** sits well below its median (25–27 ms against
 * 30 ms) because the left hump — writes that were not backpressured — moves with
 * event loop phase rather than with anything the collector does; its worst
 * arm-to-arm excess over four runs was 1.89 ms against the 2 ms it would have
 * been given, which is a coin toss rather than headroom.
 *
 * Both are reported and neither is asserted. The p50 is asserted at 5 ms: stable
 * to 0.4 ms when this file runs alone, drifting 2.02 ms between two identical
 * healthy arms when the whole package suite competes for a core, and still under
 * a third of the 15.6 ms tick that paces the series — `ready` cannot be guarded
 * more tightly than the timer underneath it. `writeCall` is where the guard has
 * teeth: unpaced, it holds to 0.03 ms even under contention, and the calibration
 * arm moves it by 3 ms.
 *
 * `writeCall` and `arrival` are not timer-paced, so their means and tails are
 * asserted too — but see {@link ARM_STAT} for *which* tail: a single run's p95
 * is one of five tail values and is mostly noise, so what is asserted is the
 * median of the per-round p95s.
 */
const TOLERANCE_FLOOR: Tolerances = {
  writeCall: { p50: 0.3, mean: 0.3, p95: 1 },
  ready: { p50: 5 },
  arrival: { p50: 0.5, mean: 0.5, p95: 1.5 },
}

/**
 * How much of the run's own noise a tolerance is allowed to be.
 *
 * The two healthy arms differ by the machine and nothing else, so
 * `NOISE_FACTOR ×` that difference is a tolerance scaled to the hardware this
 * run is on rather than to the hardware the floors were measured on. Two,
 * because a tolerance equal to the observed noise would be breached by noise
 * about half the time, and because doubling is the largest step that still fits
 * under {@link AUTO_MAX_FACTOR} for every statistic here. Chosen, not measured.
 */
const NOISE_FACTOR = 2
/**
 * The hard cap on run-time widening: a tolerance may never exceed this multiple
 * of its {@link TOLERANCE_FLOOR}.
 *
 * **The anti-slack guard, and what makes the widening safe.** The largest
 * `writeCall` tolerance it can produce is 2 × 0.3 = 0.6 ms for p50 and for the
 * mean and 2 × 1 = 2 ms for p95, all below {@link SENSITIVITY_STALL_MS}, so the
 * calibration arm still breaches whatever the noise on the day — asserted on
 * every run by `the tolerances stay sharper than the stall they must catch`
 * rather than left to the reader.
 *
 * A machine noisy enough to want more than 2× does not get it: it gets a failed
 * drift check saying the comparisons on it are not trustworthy. Chosen so the
 * widest `writeCall` p50 tolerance stays a fifth of the stall it has to catch,
 * not measured.
 */
const AUTO_MAX_FACTOR = 2

/**
 * The tolerances the run actually asserts with: {@link deriveTolerances} of the
 * two healthy arms, clamped between {@link TOLERANCE_FLOOR} and
 * `AUTO_MAX_FACTOR ×` it. Replaced once, in `beforeAll`, before any assertion
 * reads it; it starts at the floor so a crash mid-set-up cannot leave the file
 * *more* permissive than the committed numbers.
 */
let TOLERANCE: Tolerances = TOLERANCE_FLOOR

/**
 * Synchronous work injected per object in the calibration arm.
 *
 * Chosen above every p50 tolerance so the arm must breach: it is a known
 * interference of known size, and its only job is to show these tolerances can
 * still catch one.
 */
const SENSITIVITY_STALL_MS = 3

/** How long `abort()` may take under a fault before it counts as interference. */
const TEARDOWN_DEADLINE_MS = 2_000

/**
 * How a per-round statistic becomes an arm's statistic: the median over rounds.
 *
 * **Including the p95, and that is the point.** A p95 of 100 samples is the
 * fifth largest value in the run — a tail order statistic, so asserting on one
 * is asserting on the loudest thing the machine did while it ran: measured here,
 * two identical healthy arms 0.900 ms apart on `writeCall` p95 against a 1 ms
 * tolerance, from nothing but running order and scheduler noise. The tail is
 * still worth guarding, since an interference that stalls one object in twenty
 * moves the p95 and barely moves the p50, so it is taken as the median of
 * {@link ROUNDS} independent p95s: not a quantile of anything, but four separate
 * estimates of the same quantile with the outlier voted out.
 *
 * This is how an arm is *reported*. What is *asserted* takes the median one step
 * later, over the per-round differences between two arms — {@link pairedExcess}.
 */
const ARM_STAT = 'median of the per-round value' as const

const DESIGN = {
  rounds: ROUNDS,
  perRound: { objects: OBJECTS, warmup: WARMUP, sample: SAMPLE_PER_ROUND },
  sample: SAMPLE,
  armStat: ARM_STAT,
  cadenceMs: CADENCE_MS,
  drainMs: DRAIN_MS,
  payloadBytes: PAYLOAD_BYTES,
  toleranceFloor: TOLERANCE_FLOOR,
  noiseFactor: NOISE_FACTOR,
  autoMaxFactor: AUTO_MAX_FACTOR,
  sensitivityStallMs: SENSITIVITY_STALL_MS,
} as const

/* ── collector configuration for an arm ──────────────────────────────────── */

/**
 * A flush schedule compressed so an arm actually uploads.
 *
 * The shipped schedule is `+5 s / +15 s / +45 s`, then 60 s or 32 KB. An arm
 * lasts about a second, so under that schedule the fault would never be reached
 * and every treatment would pass by never having tried. Same named keys
 * (`limits.earlyFlushesMs`, `limits.flushIntervalMs`,
 * `limits.flushByteThreshold`), same meanings, turned down — possible only
 * because they are named keys rather than constants.
 */
const FLUSH_UPLOAD = {
  earlyFlushesMs: [40, 120, 260],
  intervalMs: 150,
  byteThreshold: 1024,
} as const

/** One arm, run once, in one round. */
interface RoundResult {
  readonly round: number
  readonly metrics: PlayerMetrics
  /** Requests the ingest server saw during this round. Proof the fault engaged. */
  readonly requests: number
  readonly answered: number
  readonly teardownMs: number
  readonly internalErrors: number
  readonly writeCall: Summary
  readonly ready: Summary
  readonly arrival: Summary
}

/** One arm, over all {@link ROUNDS} rounds. */
interface ArmResult {
  readonly name: string
  readonly mode: FaultMode | 'none'
  readonly rounds: readonly RoundResult[]
  /** Summed over rounds. */
  readonly requests: number
  readonly answered: number
  /** The worst round's, not the average: a deadline is a worst case. */
  readonly teardownMs: number
  readonly internalErrors: number
  /** {@link ARM_STAT} — each field is the median of that field over the rounds. */
  readonly writeCall: Summary
  readonly ready: Summary
  readonly arrival: Summary
}

interface ArmSpec {
  readonly name: string
  readonly mode: FaultMode | 'none'
  readonly stallMs?: number
}

const ARMS: readonly ArmSpec[] = [
  { name: 'baseline', mode: 'ok' },
  { name: 'blackhole', mode: 'blackhole' },
  { name: 'tarpit', mode: 'tarpit' },
  { name: 'error-500', mode: '500' },
  { name: 'baseline-2', mode: 'ok' },
  { name: 'no-collector', mode: 'none' },
  { name: 'calibration', mode: 'ok', stallMs: SENSITIVITY_STALL_MS },
]

const settle = async (turns = 6): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve()
  await new Promise<void>((r) => {
    setTimeout(r, 0)
  })
  for (let i = 0; i < turns; i += 1) await Promise.resolve()
}

let server: FaultServer
let wallMs = 0
const arms = new Map<string, ArmResult>()

/**
 * Run one arm end to end, once.
 *
 * `mode: 'none'` runs the player with no collector at all — the reference for
 * "what does the collector cost", which is reported and never asserted.
 */
async function runArm(
  _name: string,
  o: { mode: FaultMode | 'none'; stallMs?: number },
  roundIndex: number,
): Promise<RoundResult> {
  // A clean slate. `resetDormantForTest` only forgets the module singleton, so
  // the previous arm's hook has to be uninstalled first or `ensureDormantHook`
  // would find it in the install map and re-point it at the *previous* arm's
  // fake constructor.
  teardownDormant()
  resetDormantForTest()

  const restore = installFakeWebTransport({ drainMs: DRAIN_MS })
  const before = server.stats.requests
  const beforeAnswered = server.stats.answered
  let internalErrors = 0
  let collector: Collector | null = null

  if (o.mode !== 'none') {
    server.mode = o.mode
    collector = init(
      {
        apiKey: 'harness-key',
        endpoint: server.url,
        metrics: { intervalMs: 100 },
        upload: { ...FLUSH_UPLOAD },
        onInternalError: () => {
          // Expected under every fault: a blackholed socket that is finally
          // released rejects, and `Uploader` reports it. Counted, not asserted
          // on — the collector is required to keep these off the page, not to
          // have none.
          internalErrors += 1
        },
      },
      { persist: false, noLifecycleListeners: true },
    )
    // `init()` returns synchronously and finishes attaching behind that; the
    // hook is already installed by then, but the live observer is not, and an
    // arm that started here would measure a dormant collector.
    await settle()
  }

  const metrics = await runReferencePlayer({
    url: 'https://relay.invalid/moq',
    protocol: 'moqt-20',
    objects: OBJECTS,
    cadenceMs: CADENCE_MS,
    drainMs: DRAIN_MS,
    payloadBytes: PAYLOAD_BYTES,
    ...(o.stallMs === undefined ? {} : { stallMs: o.stallMs }),
  })

  const t0 = performance.now()
  // `abort()`, not `stop()`. `stop()` awaits `#drainOutbox`, which awaits an
  // `Uploader.send` that has no request timeout, so under a blackhole it never
  // resolves — recorded as a defect, and tested for separately below rather
  // than being allowed to hang every arm.
  if (collector !== null) await collector.abort()
  const teardownMs = performance.now() - t0

  // Read the counters before `release()`, which answers held requests and would
  // otherwise credit the fault arm with responses the fault never gave.
  //
  // `requests` is a wall-clock delta, so a retry left sleeping in backoff by
  // the *previous* arm can land inside this one — the `no-collector` arm
  // occasionally shows one request for that reason, and every assertion on it
  // is therefore a lower bound. `answered` has no such hazard: a response is
  // counted when it is sent, and in a fault mode nothing is sent at all until
  // `release()`, which runs after this line.
  const requests = server.stats.requests - before
  const answered = server.stats.answered - beforeAnswered

  // Cleanup, after the measurement: answer whatever the fault is still holding
  // so no upload stays pinned into the next arm.
  server.release()
  server.mode = 'ok'
  await settle()

  restore()
  teardownDormant()
  resetDormantForTest()

  return {
    round: roundIndex,
    metrics,
    requests,
    answered,
    teardownMs,
    internalErrors,
    writeCall: summarise(metrics.writeCallMs, WARMUP),
    ready: summarise(metrics.readyLatencyMs, WARMUP),
    arrival: summarise(metrics.arrivalLatencyMs, WARMUP),
  }
}

/* ── from rounds to an arm ───────────────────────────────────────────────── */

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2
}

/**
 * {@link ARM_STAT}: each field is the median of that field across the rounds.
 *
 * Deliberately **not** a summary of the pooled samples. Pooling would let one
 * slow round supply the whole of the tail — every arm's p95 would then be a
 * measurement of that round rather than of that arm — where a median over
 * rounds outvotes it. `n` is the pooled count, because that is what `n` means.
 */
const medianOfRounds = (rs: readonly Summary[]): Summary => ({
  n: rs.reduce((t, r) => t + r.n, 0),
  p50: median(rs.map((r) => r.p50)),
  p95: median(rs.map((r) => r.p95)),
  max: median(rs.map((r) => r.max)),
  mean: median(rs.map((r) => r.mean)),
})

function aggregate(spec: ArmSpec, rs: readonly RoundResult[]): ArmResult {
  const sum = (f: (r: RoundResult) => number): number => rs.reduce((t, r) => t + f(r), 0)
  return {
    name: spec.name,
    mode: spec.mode,
    rounds: rs,
    requests: sum((r) => r.requests),
    answered: sum((r) => r.answered),
    teardownMs: Math.max(...rs.map((r) => r.teardownMs)),
    internalErrors: sum((r) => r.internalErrors),
    writeCall: medianOfRounds(rs.map((r) => r.writeCall)),
    ready: medianOfRounds(rs.map((r) => r.ready)),
    arrival: medianOfRounds(rs.map((r) => r.arrival)),
  }
}

const arm = (name: string): ArmResult => {
  const a = arms.get(name)
  if (a === undefined) throw new Error(`arm ${name} did not run`)
  return a
}

/** The asserted statistics of a metric, with their floors, in report order. */
const assertedStats = (metric: Metric): [Stat, number][] =>
  Object.entries(TOLERANCE_FLOOR[metric]) as [Stat, number][]

/**
 * The tolerance this run asserts with: the noise the run itself showed, scaled,
 * and clamped into `[floor, AUTO_MAX_FACTOR × floor]`.
 *
 * The two healthy arms are the same experiment run twice, so what separates them
 * — the median of their {@link pairedExcess}, the quantity every assertion here
 * uses — is the machine and nothing else. Deriving from it lets this file run on
 * hardware the floors were not measured on **without anyone editing a constant
 * to get green**, and the clamp stops that from becoming a tolerance no
 * interference could breach. Both bounds matter: the floor means a quiet machine
 * cannot silently make the file stricter than the committed numbers, the ceiling
 * means a loud one cannot make it slacker than the calibration arm can detect.
 */
function deriveTolerances(a: ArmResult, b: ArmResult): Tolerances {
  const out: Record<Metric, Partial<Record<Stat, number>>> = {
    writeCall: {},
    ready: {},
    arrival: {},
  }
  for (const metric of METRICS) {
    for (const [stat, floor] of assertedStats(metric)) {
      const spread = Math.abs(median(pairedExcess(a, b, metric, stat)))
      out[metric][stat] = Math.min(floor * AUTO_MAX_FACTOR, Math.max(floor, spread * NOISE_FACTOR))
    }
  }
  return out
}

const toleranceOf = (metric: Metric, stat: Stat): number => TOLERANCE[metric][stat] ?? 0

/**
 * One statistic's excess of `a` over `b`, **within each round**, in round order.
 *
 * The asserted quantity is the median of these, and the pairing is the point:
 * the two arms in a round ran seconds apart on the same machine in the same
 * state, so whatever was true of the machine that round is true of both and
 * subtracts out. Differencing the two arms' *medians* instead leaves a round
 * that was slow for everyone in whichever arm's median it landed in — measured
 * under six competing processes, one round moved every arm's `ready` p50
 * together by 20 ms and the unpaired difference read 10.9 ms of that as a
 * disagreement between two identical healthy arms.
 *
 * It costs nothing in detection power: an arm that really interferes is slower
 * in *every* round, so every paired difference is positive and their median is
 * the interference — which is what the calibration arm's 3 ms shows up as.
 */
const pairedExcess = (a: ArmResult, b: ArmResult, metric: Metric, stat: Stat): number[] =>
  a.rounds.map((r, i) => {
    const other = b.rounds[i]
    return other === undefined ? 0 : r[metric][stat] - other[metric][stat]
  })

/**
 * What the runner did to a known quantity, as a multiple of that quantity.
 *
 * The calibration arm spins for exactly {@link SENSITIVITY_STALL_MS} ms of wall
 * clock per object, so its `writeCall` p50 is the one number here whose true
 * value is known before the run starts: the stall, plus the collector's
 * ~0.06 ms, plus the call. Anything beyond that is time the operating system
 * took the thread away *inside a 3 ms spin* — a direct reading of how
 * oversubscribed the machine was, and the number to look at first when a result
 * here is surprising.
 *
 * Measured on this runner: **1.03×** with the machine to itself (3.09 ms), and
 * **3.9× to 4.8×** (11.7–14.3 ms) while six unrelated `node` processes held all
 * 16 cores at 99.6% — conditions under which a fault arm showed a `writeCall`
 * mean excess large enough to fail, from a stall the collector had no part in.
 * Reported and deliberately **not** asserted on: a threshold here would be a
 * second guess at what the drift check already guesses at, with no measurement
 * behind the number.
 */
const runnerOversubscription = (): number => arm('calibration').writeCall.p50 / SENSITIVITY_STALL_MS

/* ── reporting ───────────────────────────────────────────────────────────── */

function report(): string {
  const cell = (s: Summary): string => `${round(s.p50)}/${round(s.mean)}/${round(s.p95)}`
  const head = ['arm', 'mode', 'req', 'writeCall', 'ready', 'arrival']
  const rows = [
    `${head.join(' | ')}   (each cell: p50/mean/p95 ms, ${ARM_STAT} over ${ROUNDS} rounds)`,
  ]
  for (const a of arms.values()) {
    rows.push(
      [
        a.name.padEnd(12),
        a.mode.padEnd(9),
        String(a.requests).padStart(3),
        cell(a.writeCall),
        cell(a.ready),
        cell(a.arrival),
      ].join(' | '),
    )
  }
  return rows.join('\n')
}

/**
 * The healthy-arm spread, the tolerance derived from it, and how much of that
 * tolerance the spread ate.
 *
 * The table to read when the file fails: whether each tolerance was derived
 * (spread × {@link NOISE_FACTOR}), floored, or clamped at the ceiling, and what
 * fraction of the budget two *identical* arms consumed.
 *
 * `spread` is the disagreement between the two healthy arms — the median of the
 * per-round differences printed in the last column, which every assertion here
 * is measured against. The per-round column is there because the median hides
 * its own evidence: four differences of the same sign and size are a real
 * effect, one large difference among three small ones is the machine, and only
 * one of those is worth investigating.
 */
function noiseReport(): string {
  const a = arm('baseline')
  const b = arm('baseline-2')
  const rows = [
    'healthy-arm spread → tolerance   (baseline vs baseline-2: the same experiment, twice)',
    ['statistic'.padEnd(16), 'baseline', 'baseline-2', ' spread', '  floor', '    tol']
      .join(' | ')
      .concat(' | ceiling | used    | per-round excess (baseline-2 − baseline)'),
  ]
  for (const metric of METRICS) {
    for (const [stat, floor] of assertedStats(metric)) {
      const per = pairedExcess(b, a, metric, stat)
      const spread = Math.abs(median(per))
      const tol = toleranceOf(metric, stat)
      const source = tol >= floor * AUTO_MAX_FACTOR ? 'CLAMPED' : tol > floor ? 'derived' : 'floor'
      rows.push(
        [
          `${metric}.${stat}`.padEnd(16),
          String(round(a[metric][stat])).padStart(8),
          String(round(b[metric][stat])).padStart(10),
          String(round(spread)).padStart(7),
          String(floor).padStart(7),
          String(round(tol)).padStart(7),
          String(floor * AUTO_MAX_FACTOR).padStart(7),
          `${Math.round((spread / tol) * 100)}% ${source}`.padEnd(7),
          per.map(round).join(' / '),
        ].join(' | '),
      )
    }
  }
  rows.push(
    `runner: the known ${SENSITIVITY_STALL_MS} ms calibration stall measured ` +
      `${round(arm('calibration').writeCall.p50)} ms — ` +
      `${Math.round(runnerOversubscription() * 100) / 100}× oversubscribed ` +
      '(1× is a machine with nothing else on it; see runnerOversubscription)',
  )
  return rows.join('\n')
}

beforeAll(async () => {
  const started = performance.now()
  server = await startFaultServer('ok')

  // A discarded arm first. Everything in this package is cold on the first run
  // — the decode path, the codec chunk, the gzip stream, `crypto.subtle` — and
  // whichever arm ran first would otherwise carry all of it. One arm and not one
  // whole round: the rest of that warm-up curve is handled by measuring every
  // arm at every point on it rather than by trying to outwait it.
  await runArm('warmup', { mode: 'ok' }, -1)

  const collected = new Map<string, RoundResult[]>()
  for (const spec of ARMS) collected.set(spec.name, [])

  for (let r = 0; r < ROUNDS; r += 1) {
    // Forwards, backwards, forwards, backwards — see the note at the top of this
    // file. Over an even number of rounds this gives every arm the same sum of
    // run positions, and the same sum over the middle two rounds that the median
    // actually reads, so a drift that is linear in time cancels between arms
    // instead of landing on whichever arm ran last.
    const order = r % 2 === 0 ? ARMS : [...ARMS].reverse()
    for (const spec of order) {
      const { name, ...rest } = spec
      ;(collected.get(name) as RoundResult[]).push(await runArm(name, rest, r))
    }
  }

  for (const spec of ARMS) arms.set(spec.name, aggregate(spec, collected.get(spec.name) ?? []))

  // Before any assertion reads it, and from the two arms that differ only by the
  // machine they ran on.
  TOLERANCE = deriveTolerances(arm('baseline'), arm('baseline-2'))
  wallMs = performance.now() - started

  console.log(
    `\nnon-interference — ${JSON.stringify(DESIGN)}\n` +
      `${ROUNDS} rounds × ${arms.size} arms in ${Math.round(wallMs / 100) / 10} s\n` +
      `${report()}\n\n${noiseReport()}\n`,
  )
}, 300_000)

afterAll(async () => {
  await server?.close()
})

/* ── assertions ──────────────────────────────────────────────────────────── */

const TREATMENTS = ['blackhole', 'tarpit', 'error-500'] as const

/**
 * Every asserted statistic of `a`, within tolerance of `b`.
 *
 * Returns the breaches rather than a verdict, so a failure names the number
 * that moved and by how much.
 */
function breaches(a: ArmResult, b: ArmResult): string[] {
  const out: string[] = []
  for (const metric of METRICS) {
    for (const [stat] of assertedStats(metric)) {
      const limit = toleranceOf(metric, stat)
      const per = pairedExcess(a, b, metric, stat)
      const excess = median(per)
      if (excess > limit) {
        out.push(
          `${metric}.${stat}: ${round(a[metric][stat])} ms vs baseline ` +
            `${round(b[metric][stat])} ms (excess ${round(excess)} ms > tolerance ` +
            `${round(limit)} ms; per round ${per.map(round).join(' / ')})`,
        )
      }
    }
  }
  return out
}

describe('the fault is real', () => {
  it('every treatment arm actually reached the ingest endpoint, in every round', () => {
    // Without this the whole file is a test that cannot fail: a collector that
    // uploaded nothing would satisfy every latency comparison below. Per round
    // rather than in total, because a fault that engaged in one round out of
    // four would leave three rounds of a healthy arm inside the median.
    for (const name of TREATMENTS) {
      for (const r of arm(name).rounds) {
        expect
          .soft(r.requests, `${name} made no upload attempt in round ${r.round + 1}`)
          .toBeGreaterThan(0)
      }
    }
  })

  it('a blackholed request is accepted and never answered', () => {
    for (const r of arm('blackhole').rounds) {
      expect.soft(r.requests, `round ${r.round + 1}`).toBeGreaterThan(0)
      // Answered only by `release()`, after the measurement — during the arm the
      // socket was open, healthy, and silent.
      expect.soft(r.answered, `round ${r.round + 1}`).toBe(0)
    }
  })

  it('a 500 is retried rather than dropped', () => {
    // the compressed schedule seals several chunks per arm and `Uploader`
    // retries a 5xx with backoff, so a working retry path shows up as more
    // requests than the blackhole arm, which can only ever have one in flight —
    // that is, exactly one per round, which is the bar this clears.
    expect(arm('error-500').requests).toBeGreaterThan(arm('blackhole').requests)
    expect(arm('error-500').requests).toBeGreaterThan(ROUNDS)
  })
})

describe('no object is lost, under any fault', () => {
  for (const name of [...TREATMENTS, 'baseline', 'baseline-2', 'no-collector', 'calibration']) {
    it(`${name}: every object sent, delivered and accounted for`, () => {
      // The one part of "zero effect" that is exactly testable, so it is tested
      // exactly: no tolerance, no percentile, and now once per round rather than
      // once per arm.
      for (const r of arm(name).rounds) {
        const where = `round ${r.round + 1}`
        expect.soft(r.metrics.objectsReceived, where).toBe(OBJECTS)
        expect.soft(r.metrics.objectsSent, where).toBe(OBJECTS)
        expect.soft(r.metrics.arrivalLatencyMs, where).toHaveLength(OBJECTS)
        expect.soft(r.metrics.readyLatencyMs, where).toHaveLength(OBJECTS)
        // Not the same claim as `objectsSent`: `write()` is never awaited, so
        // that counts what the page handed over. This counts what reached the
        // far side of the seam — the objects plus the subgroup header.
        expect.soft(r.metrics.chunksSunk, where).toBe(OBJECTS + 1)
        // And every byte the peer sent came back out, so nothing was truncated,
        // coalesced or re-split on the way through the hook's relay.
        expect.soft(r.metrics.bytesReceived, where).toBe(r.metrics.bytesPushed)
      }
    })
  }
})

describe('the baseline is stable enough to compare against', () => {
  it('two healthy arms agree within the same tolerance', () => {
    const forward = breaches(arm('baseline-2'), arm('baseline'))
    const backward = breaches(arm('baseline'), arm('baseline-2'))
    expect(
      [...forward, ...backward],
      'the two healthy arms disagree by more than the tolerance this file ' +
        "asserts against. That tolerance is already derived from this run's own " +
        'noise, so reaching here means the noise hit the ceiling — ' +
        `${AUTO_MAX_FACTOR}× the measured floor — and a tolerance wide enough to ` +
        'cover it would no longer catch the calibration stall. The machine ' +
        'drifted during the run and the treatment comparisons below are not ' +
        'trustworthy. Re-measure the tolerances on this hardware, or quiet the ' +
        `machine, rather than loosening them to fit.\n${noiseReport()}`,
    ).toEqual([])
  })
})

describe('ingest health does not reach the page', () => {
  for (const name of TREATMENTS) {
    it(`${name}: object arrival and writer.ready are unaffected`, () => {
      const found = breaches(arm(name), arm('baseline'))
      expect(found, `${name} vs healthy baseline\n${report()}\n\n${noiseReport()}`).toEqual([])
    })
  }

  it('abort() under a fault does not block the page', () => {
    for (const name of TREATMENTS) {
      expect
        .soft(arm(name).teardownMs, `${name}: abort() blocked the caller (worst round)`)
        .toBeLessThan(TEARDOWN_DEADLINE_MS)
    }
  })
})

/**
 * Neither teardown verb may make ingest's health the page's problem. `abort()`
 * is measured above; `stop()` awaits `#drainOutbox`, which awaits
 * `Uploader.send`, and a blackholed or tarpitted endpoint accepts the socket and
 * answers nobody — so without a deadline that `fetch` never settles and the
 * promise `stop()` hands the page never resolves, hanging any player that awaits
 * `collector.stop()` in its own teardown.
 *
 * `src/flush/deadline.ts` and its two callers bound it: one `AbortSignal`, made
 * by `stop()` from `Limits.stopDrainDeadlineMs`, threaded through `#drainOutbox`
 * into every `Uploader.send`, where it is composed with that call's own
 * `Limits.uploadTimeoutMs` per-request timer. Not two racing timers — a timer
 * racing the drain would resolve `stop()` while the upload carried on behind it,
 * which is the same hang with the evidence removed. An expired deadline is a
 * *transient* failure, so the chunk stays queued and persisted and the next page
 * load sends it: the deadline gives up on the attempt, never on the data.
 *
 * The deadline below is 10 s so that the *bounded* failure — five attempts with
 * backoff against a 5xx, measured at 6.6 s — passes it and only an unbounded
 * wait fails. It is deliberately not tightened to fit: a deadline chosen to make
 * a test pass is not a guarantee.
 */
describe('stop() must settle even when ingest never answers', () => {
  /** Generous: the current retry-to-exhaustion path takes 6.6 s and is allowed. */
  const STOP_DEADLINE_MS = 10_000

  async function stopAgainst(mode: FaultMode): Promise<{ outcome: string; ms: number }> {
    const own = await startFaultServer(mode)
    teardownDormant()
    resetDormantForTest()
    const restore = installFakeWebTransport({ drainMs: 8 })
    const collector = init(
      { apiKey: 'harness-key', endpoint: own.url, metrics: { intervalMs: 100 } },
      { persist: false, noLifecycleListeners: true },
    )
    await settle()
    // Short, and on the shipped flush schedule (+5 s / +15 s / +45 s), so no
    // automatic flush has happened yet and `stop()` owns the first upload —
    // which is the case a page hits when it tears down early.
    await runReferencePlayer({ objects: 20, cadenceMs: 8, drainMs: 8 })

    const t0 = performance.now()
    const outcome = await Promise.race([
      collector.stop().then(() => 'settled'),
      new Promise<string>((r) => {
        setTimeout(() => r('still pending'), STOP_DEADLINE_MS)
      }),
    ])
    const ms = performance.now() - t0

    own.release()
    await collector.abort()
    restore()
    teardownDormant()
    resetDormantForTest()
    await own.close()
    return { outcome, ms }
  }

  it('healthy ingest: stop() settles at once', async () => {
    const { outcome, ms } = await stopAgainst('ok')
    console.log(`stop() vs healthy ingest: ${outcome} after ${Math.round(ms)} ms`)
    expect(outcome).toBe('settled')
  }, 60_000)

  // The assertion message states the guarantee and names the bound that holds
  // it, because that message is what a regression prints.
  it('blackholed ingest: stop() settles', async () => {
    const { outcome, ms } = await stopAgainst('blackhole')
    console.log(
      `stop() vs blackholed ingest: ${outcome} after ` +
        `${Math.round(ms)} ms. See the note above this test and the directory README.`,
    )
    expect(
      outcome,
      'NON-INTERFERENCE VIOLATION: stop() did not settle against a blackholed ingest.\n' +
        'CollectorRuntime.stop() -> #drainOutbox -> Uploader.send -> fetch(). A ' +
        'blackholed endpoint accepts the socket and never answers, so without a ' +
        'deadline the fetch never settles and the promise stop() gave the page never ' +
        'resolves.\n' +
        'The bound is Limits.stopDrainDeadlineMs, built in src/flush/deadline.ts and ' +
        'threaded through the drain into every Uploader.send, where it composes with ' +
        "that call's own Limits.uploadTimeoutMs. If this fails, that signal is no " +
        'longer reaching the fetch. Do not relax this test — it is the guarantee.',
    ).toBe('settled')
  }, 60_000)

  // The harder of the two faults: a tarpit stalls with request bytes still
  // owed, so the fetch has not even finished sending. A `stop()` bounded only
  // against a blackhole would be bounded against only one of the two.
  it('tarpitted ingest: stop() settles', async () => {
    const { outcome, ms } = await stopAgainst('tarpit')
    console.log(`stop() vs tarpitted ingest: ${outcome} after ${Math.round(ms)} ms.`)
    expect(
      outcome,
      'A tarpitted endpoint withholds its answer with the request body ' +
        'still undrained, and `stop()` must resolve anyway. The fix is a ' +
        'deadline on the drain, not a shorter one on this test.',
    ).toBe('settled')
  }, 60_000)
})

describe('the harness can fail', () => {
  it(`catches a known ${SENSITIVITY_STALL_MS} ms per-object stall at the seam`, () => {
    const found = breaches(arm('calibration'), arm('baseline'))
    // If this ever comes back empty, the tolerances above have gone slack and
    // every passing result in this file means nothing.
    expect(
      found.length,
      'the calibration arm burns SENSITIVITY_STALL_MS of synchronous work per ' +
        'object on the page data path and the harness did not notice. The ' +
        `tolerances are too loose to detect interference.\n${noiseReport()}`,
    ).toBeGreaterThan(0)
  })

  it('the tolerances stay sharper than the stall they must catch', () => {
    // The structural half of the guard above. That test says "this run's
    // tolerances caught this run's stall"; this one says no run's tolerances
    // *can* grow past it, whatever noise `deriveTolerances` is handed — the arm
    // that proves the instrument works must not be able to stop working quietly.
    for (const [stat, floor] of assertedStats('writeCall')) {
      expect
        .soft(
          toleranceOf('writeCall', stat),
          `writeCall.${stat} tolerance has been auto-widened to or past the ` +
            `${SENSITIVITY_STALL_MS} ms calibration stall, which is the one thing ` +
            'AUTO_MAX_FACTOR exists to prevent',
        )
        .toBeLessThan(SENSITIVITY_STALL_MS)
      expect
        .soft(toleranceOf('writeCall', stat), `writeCall.${stat} exceeds its ceiling`)
        .toBeLessThanOrEqual(floor * AUTO_MAX_FACTOR)
    }
  })

  it('reports what the collector itself costs, for context', () => {
    const withCollector = arm('baseline')
    const without = arm('no-collector')
    // Asserted at nothing. The guarantee is about ingest health, not about
    // the collector being free, and pretending otherwise would be the kind of
    // untestable claim this file exists to replace.
    for (const r of without.rounds) expect.soft(r.metrics.objectsReceived).toBe(OBJECTS)
    console.log(
      `collector overhead (not asserted): writeCall p50 ` +
        `${round(withCollector.writeCall.p50)} ms with vs ${round(without.writeCall.p50)} ms ` +
        `without; arrival p50 ${round(withCollector.arrival.p50)} vs ` +
        `${round(without.arrival.p50)} ms`,
    )
  })
})
