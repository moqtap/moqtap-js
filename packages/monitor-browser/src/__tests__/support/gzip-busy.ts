/**
 * Calls to `gzip()` not yet done with. Each counts until the task after it
 * settles: the code awaiting it, up to the timer or upload it starts, runs in
 * microtasks before then. A test on {@link virtualTime} passes {@link compressing}
 * as its `busy`, after `vi.mock('../../envelope/gzip.js', meteredGzip)`.
 */
const pending = { n: 0 }

export const compressing = (): boolean => pending.n > 0

export async function meteredGzip(
  importOriginal: <T>() => Promise<T>,
): Promise<typeof import('../../envelope/gzip.js')> {
  const real = await importOriginal<typeof import('../../envelope/gzip.js')>()
  return {
    ...real,
    gzip: (input: Uint8Array): Promise<Uint8Array> => {
      pending.n += 1
      const p = real.gzip(input)
      const done = (): void => {
        setImmediate(() => {
          pending.n -= 1
        })
      }
      p.then(done, done)
      return p
    },
  }
}
