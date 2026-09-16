# `@moqtap/collector` — error codes

Every error this package reports carries a code. The runtime message is the
code and the offending value and nothing else — the wording lives here, so
that explanations can be as long as they need to be without every page that
loads the collector paying for them in bytes.

```
MQ2101: 1.5
│       └ the value that was rejected
└ the code — look it up below
```

Codes are permanent. A retired code is never reissued for a new meaning.

| block | area |
| --- | --- |
| `1xxx` | configuration — init() and resolveConfig |
| `2xxx` | envelope — framing, body, idempotency, gzip |
| `3xxx` | ring and flight recorder |
| `4xxx` | customer metrics — defineMetric / observe |
| `5xxx` | flush, upload and the beacon tail |
| `6xxx` | transport seam and draft negotiation |

## 1xxx — configuration — init() and resolveConfig

### `MQ1001` — init() needs a config object **throws**

`init()` takes one argument and it must be an object. This is one of only three fatal configuration errors — it throws rather than reporting, because there is no useful collector to hand back and returning a silently inert one would hide the mistake until someone went looking for data that was never collected.

*Value carried:* the typeof what was passed.

### `MQ1002` — init() needs an apiKey **throws**

There is no default and there cannot be one: without a key there is nothing to authorise the upload with. Fatal for the same reason as MQ1001 — a collector that cannot ever deliver is worse than a loud failure at the call site.

### `MQ1003` — init() was given an endpoint that is not a usable string **throws**

`endpoint` is optional: omit it and uploads go to the hosted ingest. Supplying one that is not a non-empty string is fatal rather than defaulted, because that is a typo in an override and quietly falling back would send traffic to an origin nobody chose. Whichever origin is in force is the one `connect-src` entry the page needs.

### `MQ1004` — init() called while an earlier collector was still running

`init()` was called again without `stop()` or `abort()` on the collector it returned last time. There is one hook on `globalThis.WebTransport` and one observer attached to it, so the newer collector takes over — your most recent intent — and the older one stops seeing traffic from that moment, reporting only what it had already buffered. Calling `init()` twice is supported when the first collector was stopped: a single-page application that switches channel may `stop()` and re-`init()` freely, and it need not await the `stop()` promise first. This code says only that nobody stopped the previous one, which is worth knowing because the older collector's session will look truncated for no reason visible in its own data.

### `MQ1101` — expected a finite number at or above the minimum

A numeric option was not a finite number, or fell below the minimum for that key. The default is used and the session continues. It is reported rather than clamped on purpose: a caller who wrote `intervalMs: -1` has a bug, and a collector that quietly runs at 60 s has hidden it from them.

*Value carried:* the rejected value, JSON-encoded.

### `MQ1102` — expected a boolean

A boolean option was not a boolean. This matters most for `privacy.maskAuthParams`, where a string `"false"` arriving out of JSON or an environment variable must not read as off — the safety default stays on and the problem is reported.

*Value carried:* the rejected value, JSON-encoded.

### `MQ1103` — expected a string

A string option was not a string. The default is used and the session continues.

*Value carried:* the typeof what was passed.

### `MQ1104` — expected an object

An option that groups other options — `metrics`, `upload`, `limits`, `flightRecorder`, `privacy` — was not an object. Every key under it falls back to its default.

### `MQ1105` — expected a detail level on the lattice

`detail` must be one of `baseline`, `headers`, `headers+sizes`, `headers+data`. Anything else is reported and the session stays at `baseline`. Nothing is guessed: `headers+size` is not silently read as `headers+sizes`, because a level is billable and a guess would spend money you did not agree to.

### `MQ1106` — expected an array of draft numbers

`drafts` pins which draft adapters are loaded eagerly. It must be an array; anything else is reported and the pin is treated as absent, which means one chunk is fetched at session time for whatever draft was actually negotiated.

### `MQ1107` — unsupported draft in the pin; dropped

A draft number in `drafts` is not one this build ships an adapter for. It is dropped and the rest of the pin is kept. The pin is deliberately not emptied: an empty array reads as "no pin" to the loader, so emptying it would turn a typo into "load anything" — the opposite of what a pin is for.

*Value carried:* the rejected draft, JSON-encoded.

### `MQ1108` — flightRecorder.triggers must be an object keyed by trigger kind, not an array

Both shapes have been documented at one time or another — `['stall','trackSwitch','cadence']` in one place and `{ multiple: 3 }` in another. The object won, because an array cannot carry the cadence trigger's `{ multiple, minSamples }`. An array is reported rather than ignored, so that a caller who copied the older form is told which one survived.

### `MQ1109` — unknown trigger kind; ignored

A key under `flightRecorder.triggers` is not `stall`, `trackSwitch` or `cadence`. It is ignored. Reported because a mistyped trigger is a trigger that silently never fires, which looks identical to a trigger that never had cause to.

### `MQ1110` — expected an array of positive millisecond offsets

`upload.earlyFlushesMs` is the front-loaded flush schedule — by default `ready`, then +5 s, +15 s and +45 s. It must be an array of positive millisecond offsets from `ready`.

### `MQ1111` — expected a size string like '32MB' or a byte count

`flightRecorder.depth` bounds the ring in bytes. It accepts either a byte count or a size string such as `'32MB'`. It is deliberately never expressed in seconds: how many seconds a given depth buys depends on object rate and bitrate, which vary per session.

### `MQ1112` — unknown config key; ignored

A top-level key on the config object is not one `CollectorConfig` accepts. It is ignored, and reported because a config typo is otherwise completely silent — `detial: 'headers'` type-checks against an excess-property check only at a literal call site, and not at all when the object arrives from JSON.

## 2xxx — envelope — framing, body, idempotency, gzip

### `MQ2001` — frame payload exceeds what a 31-bit length can carry

Bit 31 of a frame's u32 length prefix is the type tag — set means raw bytes, clear means JSON — so a frame length must stay below 2^31. This is unreachable in normal operation: a batch seals at about 32 KB and the beacon caps near 64 KB.

*Value carried:* the payload length in bytes.

### `MQ2002` — readFrames was given a whole body, not a frame stream

The bytes still carry the 8-byte body preamble. Skip `BODY_PREAMBLE_BYTES` first, and gunzip first if the preamble's gzip flag is set.

### `MQ2003` — truncated frame prefix

Fewer than four bytes remain where a frame's length prefix should start. The body was cut short or is not a frame stream.

*Value carried:* the offset, then the bytes remaining.

### `MQ2004` — truncated frame

A frame's length prefix declares more bytes than the body still holds.

*Value carried:* the offset, the declared length, then the bytes remaining.

### `MQ2101` — segmentSeq must be a non-negative safe integer

The idempotency key is `sha256(sessionId:segmentSeq)` and ingest dedupes on it exactly. A non-numeric or fractional sequence collapses every chunk onto one key, so ingest keeps the first body and silently discards the rest — the session is under-reported and nothing anywhere says so. Rejected at the call site instead.

*Value carried:* the rejected value.

### `MQ2102` — crypto.subtle is unavailable

Usually an insecure context: `crypto.subtle` is absent outside HTTPS and localhost. Use `idempotencyKeySync` and set `BatchRecord.keyFallback`, which tells ingest the key came from the weaker synchronous derivation and should be treated accordingly.

### `MQ2201` — CompressionStream('gzip') is unavailable

Compression is an optimisation, not a correctness requirement, so the caller that catches this ships the body uncompressed with the preamble's gzip flag clear. Losing a batch to a missing compressor would trade a measurement for a compression ratio.

## 3xxx — ring and flight recorder

### `MQ3001` — maxBytes must be a positive byte count

The ring is bounded in bytes and the bound has to be a positive count.

*Value carried:* the rejected value.

### `MQ3002` — maxEntries must be at least 1

Entry slots default to `maxBytes / 512` clamped to [64, 65536], on an assumed 512-byte mean chunk. An explicit value must still leave room for one entry.

*Value carried:* the rejected value.

### `MQ3003` — byte depth must be a positive byte count

A depth given as a number must be a positive count of bytes. Zero and negatives are refused rather than treated as "unbounded" or "disabled": a ring with no bound is the one thing the memory budget exists to rule out, and there are explicit ways to turn the recorder off.

*Value carried:* the rejected value.

### `MQ3004` — byte depth must be a size string or a byte count

Accepts a byte count, or a string such as `'32MB'`. Anything else is refused rather than guessed at.

*Value carried:* the rejected value, JSON-encoded.

### `MQ3005` — unknown byte-depth unit

The numeric part parsed but the suffix is not a unit this parser knows. Refused rather than assumed, because assuming the wrong unit is a ring three orders of magnitude off the size that was asked for.

*Value carried:* the unrecognised unit, JSON-encoded.

## 4xxx — customer metrics — defineMetric / observe

### `MQ4001` — defineMetric: name must be a non-empty string

A metric is identified by its name on the wire; an empty one cannot be joined to anything at ingest.

### `MQ4002` — defineMetric: agg must be sum, gauge or histogram

There is deliberately no `percentile` aggregation. One device's p95 cannot be merged with another's at any later point, so a pre-computed percentile is unusable fleet-wide — the histogram is what merges, by elementwise addition. This is a runtime refusal as well as a type error, because a JavaScript caller has no types to stop them.

*Value carried:* the metric name.

### `MQ4003` — defineMetric: already defined with different terms

Re-registering the same name with the same unit and aggregation is accepted and does nothing. Changing either mid-session is refused: it would produce one series whose meaning changes halfway through, which no downstream merge can repair and nothing downstream can detect.

*Value carried:* the metric name, then the existing agg/unit.

### `MQ4004` — defineMetric: metric cap reached

Bounded so that a caller generating metric names from data — a name per track, per user, per URL — costs a fixed amount rather than an unbounded one. Past the cap new metrics are refused; those already registered keep working.

*Value carried:* the metric name, then the cap.

### `MQ4005` — defineMetric: buckets must be finite and strictly ascending

Histogram boundaries have to be a valid ladder. An unusable ladder is refused outright rather than silently replaced by the default one, because a silently substituted ladder produces a series that looks right and merges wrong.

*Value carried:* the metric name.

### `MQ4006` — observe: no metric registered under that name

Registration is mandatory. `observe()` may be called per group, per object, per frame, so it cannot afford to infer a shape from the first sample — and a metric whose aggregation was inferred from one sample is a metric that means something different on the next device.

*Value carried:* the metric name.

### `MQ4007` — observe: too many labels

Each distinct label set is its own series, so unbounded labels are unbounded cost. The extra labels are dropped and the observation is kept.

*Value carried:* the metric name, then the cap.

### `MQ4008` — further metric errors suppressed for this session

Appended once when the per-session error-report budget is spent. `observe()` sits on a hot path, so a mistake there repeats thousands of times a session; reporting each one would turn a small bug into a flood in the host application's error channel.

## 5xxx — flush, upload and the beacon tail

### `MQ5001` — tail segment refused by both sendBeacon and keepalive fetch

The last segment of a session is delivered on `pagehide`, when the page is going away and an ordinary `fetch` will not survive. Both paths refused it — usually because it exceeds the platform's beacon cap, around 64 KB. It is not persisted, so it is lost; everything already sealed and queued is unaffected and goes out on the next page load.

*Value carried:* the segment size in bytes.

### `MQ5002` — drain deadline expired

`stop()` is awaited by a page tearing down, so the drain is bounded. Expiry is not data loss: the chunk stays queued and persisted, and the next page load sends it. The deadline gives up on the attempt, never on the data.

*Value carried:* the deadline in milliseconds.

## 6xxx — transport seam and draft negotiation

### `MQ6001` — WebTransport collection exposes no values()

A collection the hook needs to iterate is not iterable in the way the platform specifies. Reported rather than thrown into the page, and that seam goes uninstrumented for the session.

---

Generated from `error-codes.json` by `bun run codes`. Do not edit by hand.
