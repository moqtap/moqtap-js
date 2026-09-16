/**
 * A cooperative registry so moqtap's own `WebTransport` patches can splice
 * themselves out of the middle of a chain.
 *
 * Monkey-patching a global constructor builds a singly-linked list by capture:
 * each patch stores whatever was there before and delegates to it. Removing the
 * *outermost* patch is easy; removing one from the middle is impossible, because
 * the patch above captured *you* by value and is unreachable. The universal safe
 * answer — go inert and leave the wrapper in the chain — is correct but leaves a
 * permanent no-op constructor on the page global.
 *
 * If both patches agree on a registry, the one leaving can find the one above it
 * and hand over its own delegate: a real splice, and the wrapper genuinely
 * disappears. It only works between participants — the moqtap SDK and the moqtap
 * browser extension. Against a foreign patch (another SDK, a page's own
 * instrumentation) every hook falls back to going inert without restoring, which
 * is conservative and never wrong.
 *
 * A global rather than an import: the extension does not depend on this package
 * and the two copies load independently in the same realm, so the registry has
 * to be a rendezvous point neither owns.
 */

/** The registry's global property name. **Cross-repository contract.** */
export const CHAIN_KEY = '__moqtapPatchChain'

export interface ChainEntry {
  /** Entry shape version. A participant that does not recognise it stands down. */
  readonly v: 1
  /** Which moqtap component installed this patch. Diagnostic only. */
  readonly id: string
  /** The constructor this hook put on the global. */
  readonly patched: unknown
  /** What it currently delegates to. Mutable: a splice below us rewrites it. */
  original: unknown
  /**
   * "The thing you were delegating to has left; delegate to this instead."
   *
   * Implemented by the hook, because only the hook can reach the variable its
   * patched constructor actually reads.
   */
  repoint(next: unknown): void
}

export interface ChainHandle {
  /**
   * Leave the chain.
   *
   * Returns what the caller should now put on the global, or `null` meaning
   * "do not touch the global" — either because somebody above us was repointed
   * (so the global still correctly names them) or because a non-participant is
   * on top and unwinding past it would discard their patch.
   */
  release(): { restore: unknown } | null
}

const NO_CHAIN: ChainHandle = { release: () => null }

function registry(glob: Record<string, unknown>): ChainEntry[] | null {
  const existing = glob[CHAIN_KEY]
  if (Array.isArray(existing)) return existing as ChainEntry[]
  if (existing !== undefined) return null // somebody else owns the name; stand down
  const created: ChainEntry[] = []
  try {
    Object.defineProperty(glob, CHAIN_KEY, {
      value: created,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  } catch {
    return null
  }
  return created
}

/**
 * Join the chain. Never throws; a global that refuses the registry costs the
 * splice, not the hook.
 */
export function joinChain(target: object, entry: Omit<ChainEntry, 'v'> & { v?: 1 }): ChainHandle {
  const glob = target as Record<string, unknown>
  const list = registry(glob)
  if (list === null) return NO_CHAIN

  const mine: ChainEntry = { ...entry, v: 1 }
  list.push(mine)

  return {
    release(): { restore: unknown } | null {
      const i = list.indexOf(mine)
      if (i !== -1) list.splice(i, 1)

      // Whoever captured us as their delegate. There can be at most one.
      const above = list.find((e) => e.v === 1 && e.original === mine.patched)
      if (above !== undefined) {
        try {
          above.repoint(mine.original)
          above.original = mine.original
        } catch {
          // A participant that cannot repoint keeps delegating through our
          // inert wrapper. Correct, just not tidy.
          return null
        }
        return null // the global still names `above`, which is right.
      }

      // Nobody above us in the registry. We may still not be on top -- a
      // non-participant can be -- so the caller checks the global before
      // restoring. That check is theirs because only they hold `patched`.
      return { restore: mine.original }
    },
  }
}
