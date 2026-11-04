/**
 * The browsing-session id: one tab's, kept in its `sessionStorage` so a
 * reload continues it. Read, checked and written in one synchronous call, so
 * two monitors of one tab (same-origin frames share an event loop) cannot
 * both find no id and both mint one.
 */

import type { SessionIdSource } from '../types.js'
import { mintId } from './config.js'

export const TAB_SESSION_KEY = 'moqtap:session'

/** The forms {@link mintId} produces: a lowercase UUID, or its fallback. */
const MINTED =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|s-[0-9a-f]{1,16}-[0-9a-f]{1,32})$/

export function isMintedId(v: string): boolean {
  return MINTED.test(v)
}

interface Storage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function storageOf(g: unknown): Storage | null {
  // Reading the property itself throws where storage is blocked.
  const s = (g as { sessionStorage?: Storage }).sessionStorage
  return s !== undefined && s !== null && typeof s.getItem === 'function' ? s : null
}

/** The tab's stored id when it is in the minted form, without writing anything. */
export function peekTabSession(g: unknown = globalThis): string | null {
  try {
    const v = storageOf(g)?.getItem(TAB_SESSION_KEY) ?? null
    return v !== null && isMintedId(v) ? v : null
  } catch {
    return null
  }
}

/**
 * The tab's id and where it came from. A value the monitor did not mint is
 * replaced; with no usable storage the id is this page load's alone.
 */
export function tabSession(
  g: unknown = globalThis,
  mint: () => string = mintId,
): { readonly id: string; readonly ss: SessionIdSource } {
  try {
    const s = storageOf(g)
    if (s !== null) {
      const stored = s.getItem(TAB_SESSION_KEY)
      if (stored !== null && isMintedId(stored)) return { id: stored, ss: 'stored' }
      const id = mint()
      s.setItem(TAB_SESSION_KEY, id)
      return { id, ss: 'new' }
    }
  } catch {
    // SecurityError (sandboxed or opaque-origin frame, storage blocked) or
    // QuotaExceededError: the id covers this page load only.
  }
  return { id: mint(), ss: 'page' }
}

/** Remove the tab's id when it is `id`, so the next page load starts another browsing session. */
export function forgetTabSession(id: string, g: unknown = globalThis): void {
  try {
    const s = storageOf(g)
    if (s !== null && s.getItem(TAB_SESSION_KEY) === id) s.removeItem(TAB_SESSION_KEY)
  } catch {
    // Nothing stored that could be removed.
  }
}
