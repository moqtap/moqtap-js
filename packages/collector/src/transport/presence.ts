/**
 * A read-only marker on the page global saying that this collector is here.
 *
 * The moqtap browser extension patches `WebTransport` from a MAIN-world content
 * script at `document_start`, so it always sits underneath this collector's own
 * patch. Without a marker its teardown restores the global unconditionally and
 * silently discards this collector's patch, and it cannot tell a developer that
 * the connection they are looking at is *also* being collected.
 *
 * A global rather than `postMessage` or a custom event: both patch the same
 * realm, so a plain property is the cheapest channel and the only one that works
 * synchronously inside a constructor. A message would arrive a task later, after
 * the connection the extension is trying to label.
 *
 * It deliberately carries no ingest key, endpoint, session id or track name.
 * Anything on `globalThis` is readable by every script on the page, including
 * ones the customer did not write, so this carries the minimum that answers "is
 * a collector running, since when, and is it transmitting". A future field must
 * clear the same bar.
 */

/**
 * The property name. **This is a cross-repository contract** — the extension
 * reads this exact string. Never change it; breaking changes go through
 * {@link CollectorPresence.v}.
 */
export const PRESENCE_KEY = '__moqtapCollector'

export interface CollectorPresence {
  /** Shape version. Bump only for a breaking change to the fields below. */
  readonly v: 1
  /** The collector's package version, for support. */
  readonly version: string
  /**
   * Wall-clock ms when the hook attached to this global.
   *
   * The extension uses it to decide which of *its* sessions are instrumented:
   * this collector only observes what its patch sees, so a connection opened
   * before this timestamp is not being collected. The approximation errs in one
   * direction only — it can never claim an uncollected session is collected.
   */
  readonly since: number
  /**
   * Whether the collector is transmitting, as opposed to installed and dormant.
   *
   * The hook installs at module-eval and stays dormant until a key arrives, so
   * `false` here is a normal state and not a fault. Worth distinguishing because
   * "the SDK is on the page but sending nothing" is a common misconfiguration.
   */
  readonly active: boolean
}

export interface PresenceHandle {
  /** Dormant → live, or back. Rewrites the marker in place. */
  setActive(active: boolean): void
  /** Remove the marker, if this handle's marker is still the one installed. */
  remove(): void
}

const INERT: PresenceHandle = { setActive() {}, remove() {} }

/**
 * Publish the marker on `target`.
 *
 * Never throws: a global that refuses the property (frozen, or a trapped
 * `defineProperty`) costs the marker, not the collector. Nothing here may reach
 * the page; this is a diagnostic, not a mechanism.
 */
export function publishPresence(
  target: object,
  version: string,
  nowWallMs: number,
): PresenceHandle {
  const glob = target as Record<string, unknown>

  const write = (active: boolean): boolean => {
    const value: CollectorPresence = { v: 1, version, since: nowWallMs, active }
    try {
      Object.defineProperty(glob, PRESENCE_KEY, {
        value: Object.freeze(value),
        writable: true,
        configurable: true,
        enumerable: true,
      })
      return true
    } catch {
      return false
    }
  }

  if (!write(false)) return INERT

  /** Identity check, so a later collector's marker is never clobbered by ours. */
  const mine = (): boolean => {
    const cur = glob[PRESENCE_KEY] as CollectorPresence | undefined
    return cur !== undefined && cur.since === nowWallMs
  }

  return {
    setActive(active: boolean): void {
      if (mine()) write(active)
    },
    remove(): void {
      if (!mine()) return
      try {
        delete glob[PRESENCE_KEY]
      } catch {
        /* a page that made it non-configurable keeps it; harmless. */
      }
    },
  }
}

/** Read the marker from a global. Exported for the extension and for tests. */
export function readPresence(target: object): CollectorPresence | null {
  const value = (target as Record<string, unknown>)[PRESENCE_KEY]
  if (value === null || typeof value !== 'object') return null
  const p = value as Partial<CollectorPresence>
  if (p.v !== 1 || typeof p.since !== 'number' || typeof p.active !== 'boolean') return null
  return p as CollectorPresence
}
