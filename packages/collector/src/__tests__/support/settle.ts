/**
 * Let the collector's pending work run: init()'s async setup, the pump, the
 * schedule's zero-delay seals, and the fetch and store continuations that
 * follow them.
 *
 * Each turn is a microtask flush and one `setImmediate`. A zero-delay
 * `setTimeout` is not used to yield because its cost is the platform's timer
 * resolution rather than the work it waits for: ~15 ms on Windows against
 * ~1 ms on Linux, so forty turns cost 600 ms on one and 40 ms on the other,
 * and under a full parallel run whole tests cross vitest's five-second
 * timeout while asleep.
 *
 * `setImmediate` never blocks in the event loop's poll phase, so a timer is
 * still serviced as soon as it falls due. The turns also span at least
 * {@link ZERO_DELAY_MS} of wall time, so every timer the collector armed with a
 * zero delay has fired before they end.
 *
 * `ms` is for the few tests whose subject is real time passing in a realm the
 * test does not drive, such as a linked probe's own forward timer or a store
 * write that takes a while: it sleeps that long on one timer, then turns
 * again for whatever the sleep let run. Waiting out a metrics interval or a
 * retry backoff is not one of them; `end()` seals and uploads the interval in
 * progress, and a test about a timer's effect injects `clock` and `setTimer`.
 */
export async function settle(turns = 40, ms = 0): Promise<void> {
  await spin(turns)
  if (ms <= 0) return
  await new Promise<void>((r) => setTimeout(r, ms))
  await spin(turns)
}

/** Node's zero-delay `setTimeout` is 1 ms; twice that and it has come due. */
const ZERO_DELAY_MS = 2

async function spin(turns: number): Promise<void> {
  const until = performance.now() + ZERO_DELAY_MS
  for (let i = 0; i < turns || performance.now() < until; i += 1) {
    await Promise.resolve()
    await new Promise<void>((r) => setImmediate(r))
  }
}

/**
 * Turn until `done()` holds, for a test whose subject is that something
 * happens promptly rather than after a timer: a fixed number of turns is a
 * race with gzip and the store under a loaded runner. Fails after `ms`.
 */
export async function until(done: () => boolean | Promise<boolean>, ms = 1000): Promise<void> {
  const deadline = performance.now() + ms
  while (!(await done())) {
    if (performance.now() > deadline) throw new Error(`not done within ${ms} ms`)
    await spin(1)
  }
}
