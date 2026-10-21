/**
 * Which stored bodies belong to an instance that is gone.
 *
 * Every live instance holds the Web Lock `moqtap:<instanceId>` for as long as
 * its page lives; the browser releases it when the page closes, crashes or is
 * discarded. A stored body whose instance lock nobody holds was left behind by
 * a page that can no longer send it, and any page on the origin may. A body
 * whose lock is held is still in its own page's outbox and is left alone, so
 * two tabs never race each other's live uploads.
 *
 * Without Web Locks (Safari before 15.4) a body counts as left behind once it
 * is older than three upload intervals: a live page retries well within that,
 * so the cost of being wrong is a duplicate send, which ingest discards by key,
 * and never a loss.
 */

export const LOCK_PREFIX = 'moqtap:'

/** The slice of `navigator.locks` used here. */
export interface LockManagerLike {
  request(name: string, callback: (lock: unknown) => Promise<unknown> | unknown): Promise<unknown>
  query?(): Promise<{ readonly held?: readonly { readonly name?: string }[] }>
}

/** The platform's lock manager, or `undefined` where there is none. */
export function platformLocks(): LockManagerLike | undefined {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator
  const locks = nav?.locks
  return locks !== undefined && typeof locks.request === 'function' ? locks : undefined
}

/**
 * Hold `moqtap:<instanceId>` until the returned function is called. Never
 * throws; without a lock manager there is nothing to hold.
 */
export function holdInstanceLock(
  locks: LockManagerLike | undefined,
  instanceId: string,
  onError?: (err: unknown) => void,
): () => void {
  if (locks === undefined) return () => {}
  let release: (() => void) | undefined
  let released = false
  try {
    void locks
      .request(
        LOCK_PREFIX + instanceId,
        () =>
          new Promise<void>((resolve) => {
            release = resolve
            if (released) resolve()
          }),
      )
      .catch((err: unknown) => onError?.(err))
  } catch (err) {
    onError?.(err)
  }
  return () => {
    released = true
    release?.()
  }
}

/**
 * The instance ids whose locks are held right now, or `null` when the
 * platform cannot say, in which case the caller falls back to age.
 */
export async function heldInstances(
  locks: LockManagerLike | undefined,
  onError?: (err: unknown) => void,
): Promise<Set<string> | null> {
  if (locks === undefined || typeof locks.query !== 'function') return null
  try {
    const snapshot = await locks.query()
    const held = new Set<string>()
    for (const l of snapshot.held ?? []) {
      if (typeof l.name === 'string' && l.name.startsWith(LOCK_PREFIX)) {
        held.add(l.name.slice(LOCK_PREFIX.length))
      }
    }
    return held
  } catch (err) {
    onError?.(err)
    return null
  }
}
