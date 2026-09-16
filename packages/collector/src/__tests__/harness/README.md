# `__tests__/harness` — non-interference and the bundle budget

Two guarantees that the rest of the suite cannot check, because both need
something outside the unit under test: a real ingest endpoint that can be made
to fail, and a real bundler.

| file | what it is |
| --- | --- |
| `fault-server.ts` | a real loopback HTTP server with five fault modes |
| `reference-player.ts` | a MoQT client that subscribes and publishes, and measures what the page observes |
| `non-interference.test.ts` | a stated experiment with a tolerance, a sample size and a baseline |
| `bundle-size.test.ts` | the bundle budget, measured and guarded against regression |

---

## Non-interference — the experiment

The guarantee: ingest being down, slow or tarpitted must never affect the
customer's playback or publishing. It is checked by blackholing the ingest
endpoint and then tarpitting it while a reference player runs, asserting no
effect on object arrival or on `writer.ready` latency.

**"Zero effect" is not testable and this directory does not claim it.** An
unstated tolerance is a threshold like any other, and a threshold with no
recorded provenance is not allowed to exist here. So the experiment is stated
instead:

- **Baseline** — the same collector, the same player, against a **healthy**
  ingest. Ingest health is the only variable that moves. A no-collector arm is
  also run, but it answers a different question and asserts nothing.
- **Treatments** — `blackhole`, `tarpit`, `500`. Real sockets, real `fetch`.
- **Sample size** — 100 objects per direction per arm, as **four interleaved
  rounds** of 25 after discarding 20 for warm-up in each. Seven arms per round,
  plus one discarded warm-up arm at the start: 29 arm runs, 36 s.
- **Running order** — forwards, backwards, forwards, backwards. Arm order is
  otherwise the loudest variable in the experiment; see below.
- **Tolerance** — per metric and per statistic. A floor measured on this runner
  and rounded up, widened at run time by the noise the run itself showed, capped
  at 2x the floor. See `TOLERANCE_FLOOR` and `deriveTolerances` in the test.
- **Exact assertions where exactness is possible** — no object may be lost, in
  either direction, under any fault, in any round. That has no tolerance at all.

### What is measured

| metric | what it is | why |
| --- | --- | --- |
| `writeCall` | how long the page's own `writer.write()` takes to return | the hook runs `onChunk` and *then* delegates, so the whole per-object cost on the page's thread of control is inside this number |
| `ready` | how long `await writer.ready` blocked | the only backpressure signal a publisher has |
| `arrival` | a received object's arrival minus the peer's actual send | transit across the seam the collector sits in |

### Four properties that keep it from being a test that cannot fail

1. **The fault is proved to have engaged**, in every round. Each treatment
   asserts the server really saw requests in that mode. A collector that never
   uploaded would pass every latency comparison.
2. **The instrument is calibrated.** A final arm burns a known 3 ms per object
   at the seam and asserts the harness **catches** it. If that arm ever passes
   the non-interference check, the tolerances have gone slack and every other
   result in the file is worthless.
3. **The run-time widening is capped.** Tolerances scale with the noise the run
   showed, but never past 2x the measured floor — and a separate test asserts
   that every `writeCall` tolerance stays below the 3 ms calibration stall, so
   no amount of noise can widen the file into one that cannot fail.
4. **The baseline is proved stable.** `baseline` runs twice in every round, and
   the two must agree within the tolerance the file asserts with. Since that
   tolerance is capped, the check still bites: it fails when the machine's own
   noise is large enough that covering it would blind the instrument.

### Results

Five consecutive runs, Windows 11 / Node 24, this file running alone. One of
them, whole (each arm's cell is the median of its four rounds):

```
arm            mode        req   writeCall p50/mean/p95   ready p50   arrival p50/mean/p95
baseline       ok           52   0.062/0.073/0.138        29.95       0.070/0.066/0.133
blackhole      blackhole     4   0.058/0.073/0.140        29.94       0.072/0.074/0.156
tarpit         tarpit        6   0.060/0.078/0.159        30.16       0.068/0.071/0.146
error-500      500           8   0.064/0.076/0.167        30.14       0.073/0.069/0.114
baseline-2     ok           56   0.059/0.072/0.146        30.20       0.075/0.079/0.174
no-collector   none          0   0.026/0.035/0.082        30.51       0.043/0.053/0.126
calibration    ok           52   3.085/3.087/3.109        27.46       0.062/0.070/0.137
```

Every fault arm sits on its healthy baseline, on every metric: ingest health does
not reach the page.

Arms are interleaved into rounds with the direction alternating each round, and
that is load-bearing rather than tidy: run as one long block each in a fixed
order, the arms come out monotone in *position* rather than in treatment,
because the process gets faster over the first half-minute of its life. The
later an arm runs, the faster it looks, and the effect is large enough to read
as "the collector does less work when its uploads are failing".

The collector's own cost, reported and asserted at nothing: about **0.036 ms per
published object** on the page's thread (0.062 with it, 0.026 without) and about
**0.027 ms of added transit** per received object.

### How stable the comparison is now

`baseline` and `baseline-2` are the same experiment twice, so what separates them
is measurement noise and nothing else. Over five runs of this file alone, the
worst disagreement between them, against the tolerance each statistic is asserted
with:

| statistic | worst of 5 runs | tolerance | budget spent |
| --- | ---: | ---: | ---: |
| `writeCall` p50 | 0.002 ms | 0.3 ms | 1% |
| `writeCall` mean | 0.011 ms | 0.3 ms | 4% |
| `writeCall` p95 | 0.041 ms | 1.0 ms | 4% |
| `ready` p50 | 1.264 ms | 5.0 ms | 25% |
| `arrival` p50 | 0.019 ms | 0.5 ms | 4% |
| `arrival` mean | 0.025 ms | 0.5 ms | 5% |
| `arrival` p95 | 0.147 ms | 1.5 ms | 10% |

Before interleaving, one run of those same two arms spent **90%** of the
`writeCall` p95 budget on running order alone, and the drift check failed
outright when anything else ran beside it. Under eight competing busy loops the
worst figure above is `writeCall` p95 at 10%; the file starts to fail — on
`ready`, the `setTimeout`-paced metric, and only there — at about 3x
oversubscription, which it prints on every run as the calibration arm's reading
of the known 3 ms stall.

### What this harness bounds: `stop()` against a dead ingest

`stop()` awaits the outbox drain, which awaits `Uploader.send`. With no deadline
on that, a blackholed or tarpitted ingest leaves the promise pending for the
life of the page — and a player that awaits `collector.stop()` in its own
teardown, the documented way to use the verb, stops there with it. That is
precisely the interference this directory exists to forbid, so the bound is
asserted rather than assumed.

Measured on this machine:

| ingest | `stop()` settles in |
| --- | ---: |
| healthy `204` | 8 ms |
| **blackhole** | **2 008 ms** |
| **tarpit** | **2 007 ms** |

Both bounded by `Limits.stopDrainDeadlineMs` (2 s), which also caps the
retry-with-backoff inside `stop()` — bounded on its own at 6.6 s, but still six
seconds of a page's teardown.

What holds it, in `src/flush/deadline.ts`: one `AbortSignal`, made by `stop()`
from `stopDrainDeadlineMs`, threaded through the drain into every
`Uploader.send`, where it is composed with that call's own
`Limits.uploadTimeoutMs` per-request timer (`AbortSignal.timeout` where the
engine has it, a raced `AbortController` where it does not, cleared either way
when the fetch settles). One mechanism rather than a timer racing the drain: a
race would resolve `stop()` while the upload carried on behind it, which is the
same hang with the evidence removed. An expired deadline is a *transient*
failure, so the chunk stays queued and persisted and goes out on the next page
load.

`STOP_DEADLINE_MS` in the test is 10 s — the assertion's bar, deliberately far
above the 2 s the collector actually takes.

---

## The bundle budget

**Budget: ~10 KB gz static + 4–9 KB per negotiated draft.**

Measured with that budget's own method — `bun build --target=browser --minify`
from TypeScript source, then gzip level 9 — on 2026-09-05:

| bundle | minified | **gzipped** | against budget |
| --- | ---: | ---: | --- |
| static entry, codec external | 107 KB | **32 244 B (31.5 KB)** | budget 10 KB — **3.15× over** |
| static entry + every lazy chunk | — | 35 852 B (35.0 KB) | — |
| draft-20 chunk, codec inlined | 22.3 KB | **6 714 B (6.6 KB)** | band 4–9 KB — inside |
| draft-19 chunk, codec inlined | 20.7 KB | 6 134 B (6.0 KB) | inside |
| codec draft-20 decoder alone | 17.8 KB | 5 161 B (5.0 KB) | budget says 5.3 KB — corroborated |

The per-draft half of the budget holds. **The static half does not**, and that
was the expected outcome — the first honest number was always likely to exceed
10 KB. Nobody has decided whether 31.5 KB is acceptable; the
ceilings in the test are a *regression* guard at the measured value, and the gap
to the budget is printed on every run and repeated in every failure message so
that raising a ceiling has to be a decision rather than an edit.

Where the bytes are, each subsystem bundled alone (they share code, so this is a
ranking and not an accounting):

```
  flush          5 953 B gz      decode         5 488 B gz
  rollup         4 478 B gz      transport      4 468 B gz
  draft          3 362 B gz      recorder       3 341 B gz
  envelope       2 034 B gz      ring           1 609 B gz
```

### Known trap: `bun build` on a re-export barrel

`bun build src/index.ts` (bun 1.3.13) reports **8 modules and 8.7 KB gz** for a
bundle in which `init` is never defined. The real graph is 56 modules and
~32 KB gz. Bun drops the modules behind a pure `export … from` barrel while
still emitting the `export {}` clause that names them. Every measurement here
therefore goes through a namespace-import shim, and `TRUNCATION_MARKERS` fails
the suite if the graph is ever emptied again.

The same trap applies to anyone measuring this package by hand.

---

## What typechecking this directory costs the rest of the package

These four files are typechecked with the rest of the package. `@types/node` is
a devDependency here (`^24.13.3`, matching the Node 24 that `.github/workflows/`
runs) so that `node:child_process`, `node:fs`, `node:http`, `node:os` and
`node:zlib` resolve. They are the only guard on the non-interference guarantee,
so leaving them unchecked is the more expensive of the two options.

The price is worth knowing, because it is not local to this directory. A single
`import … from 'node:http'` pulls all of `@types/node` into the program —
`globals.d.ts` with it — so `Buffer`, `process`, `setImmediate` and `global`
become visible to the **browser** source under `src/` as well, and code that
should fail on them typechecks clean. `"types": []` does not prevent that: the
option governs automatic inclusion only, not what a module import drags in.
Measured, not assumed — with `"types": []` on the main config, `tsc` still
accepts `Buffer.from` in `src/api/`.

So the shipped source is typechecked a second time, alone and with no ambient
type packages at all, by `packages/collector/tsconfig.browser.json`. The repo
root's `tsconfig.json` references it, so `bun run typecheck` runs it in CI. A
Node global reached for in `src/` outside `__tests__` fails there.

## Cost, and why the timing file has a vitest project to itself

The non-interference file takes about 43 s: 29 arm runs of ~1.2 s (four rounds
of seven arms, plus a discarded warm-up arm), then ~4 s of `stop()` deadline
tests. The bundle-size file takes about 4 s. Both are real fault injection and real bundling; neither is a
unit test and neither belongs in a watch loop.

`packages/collector/vitest.config.ts` puts that file in its own project with
`sequence.groupOrder: 1`, so the other 28 files finish before it starts and it
measures the machine rather than the machine plus vitest. That costs the suite
27 s (47 s → 74 s) and costs the other files nothing — they keep full
concurrency. The comment in that file has the measurements, including why
`fileParallelism: false` is the worse trade at 85 s.
