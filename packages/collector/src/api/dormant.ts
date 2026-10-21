/**
 * Install dormant.
 *
 * Importing the package installs the hook at module-eval time — before the
 * importing entry's body, since imports are hoisted — but it wraps, buffers into
 * bounded memory, and transmits nothing until a key arrives. Three properties
 * therefore have to hold:
 *
 *  1. **It cannot throw.** A throw at module-eval time takes the customer's
 *     entry file with it, and the customer has not called anything yet. Every
 *     path here is wrapped, and a global with no `WebTransport` — a worker on a
 *     browser without support, a Node test runner — yields an inert hook.
 *  2. **It transmits nothing.** There is no `fetch`, no `sendBeacon`, no
 *     `IndexedDB`, no timer and no `postMessage` anywhere in this file or in
 *     anything it imports. The only thing the dormant observer does is copy
 *     bytes into a fixed-size ring that continuously overwrites itself, and
 *     the control plane into a buffer that stops at its bound.
 *  3. **It is bounded.** The ring by `limits.dormantRingBytes`, defaulted and
 *     provenanced in `defaults.ts`; the held control plane by the two bounds in
 *     `early.ts`.
 *
 * The pre-key bytes are kept because the interesting part of a session is its
 * first second: a page that calls `new WebTransport()` at load and `init()`
 * after its own bootstrap, or a worker that connects right after
 * `initWorker()`, would otherwise lose SETUP, SUBSCRIBE and the first objects.
 * The control plane is held apart from the ring and replayed into the live
 * collector's decoder when it attaches; object data goes to the ring, for the
 * flight recorder, and is counted.
 *
 * If `init()` is never called, nothing happens to either, forever: the ring
 * overwrites itself at a fixed memory cost, the held control plane stops
 * growing at its bound, and no byte of either is parsed, copied out, persisted
 * or sent.
 */

import { draftOfSetupFrame } from '../draft/setup-probe.js'
import { ByteRing, type RingEntry } from '../ring/index.js'
import { installWebTransportHook, type TransportHook } from '../transport/index.js'
import { type PresenceHandle, publishPresence } from '../transport/presence.js'
import type {
  DatagramChunk,
  InterceptedSession,
  StreamChunk,
  SupportedDraft,
  TransportObserver,
} from '../types.js'
import { COLLECTOR_VERSION } from '../version.js'
import { DEFAULT_LIMITS } from './defaults.js'
import { EarlyBuffer, type EarlyConnection } from './early.js'

/**
 * The stream id a datagram's ring entry carries.
 *
 * Datagrams have no stream. `-1` is what the flight recorder's replay already
 * uses (`recorder/replay.ts`'s `DATAGRAM_STREAM_ID`), and the two must agree or
 * a re-parse of the dormant ring would try to walk a datagram as a stream.
 * Duplicated as a literal rather than imported so this file, which runs at
 * module-eval time on every import of the package, pulls in nothing it does not
 * need.
 */
export const DORMANT_DATAGRAM_STREAM_ID = -1

/** What the dormant hook accumulated before a key arrived. */
export interface DormantState {
  readonly hook: TransportHook
  readonly ring: ByteRing
  /** Sessions the hook opened before `init()`. Replayed to the live observer. */
  readonly sessions: Map<string, InterceptedSession>
  readonly protocols: Map<string, string>
  /**
   * The draft each pre-15 session's SETUP named, read as it crossed. It
   * survives a held control plane that hit its bound, and a worker whose link
   * timed out and released it.
   */
  readonly setupDrafts: Map<string, SupportedDraft>
  /** The control plane held for replay, and the object data counted. */
  readonly early: EarlyBuffer
  /** Per session, the stream halves already offered to the probe. */
  readonly probed: Map<string, Set<string>>
  /**
   * Whether the hook actually patched the global.
   *
   * Recorded here rather than read back off `hook.installed`, because that flag
   * answers two different questions with the same `false`: "this global has no
   * `WebTransport` to patch" — a worker without support, a Node test runner —
   * and "this hook was installed and has since been uninstalled". The first
   * must never be retried, the second must always be; see
   * {@link ensureDormantHook}.
   */
  readonly patched: boolean
}

let state: DormantState | null = null
let installFailed = false

/** Read the draft off the first chunk of each control-stream direction. */
function probeSetup(s: DormantState, c: StreamChunk): void {
  if (s.setupDrafts.has(c.sessionId)) return
  let halves = s.probed.get(c.sessionId)
  if (halves === undefined) {
    halves = new Set()
    s.probed.set(c.sessionId, halves)
  }
  const half = `${c.streamId}/${c.direction}`
  if (halves.has(half)) return
  halves.add(half)
  const draft = draftOfSetupFrame(c.data)
  if (draft !== undefined) s.setupDrafts.set(c.sessionId, draft)
}

function dormantObserver(s: DormantState): TransportObserver {
  return {
    onSessionOpen(session: InterceptedSession): void {
      s.sessions.set(session.id, session)
    },
    onSessionProtocol(sessionId: string, protocol: string): void {
      s.protocols.set(sessionId, protocol)
    },
    onSessionClose(sessionId: string): void {
      s.sessions.delete(sessionId)
      s.protocols.delete(sessionId)
      s.setupDrafts.delete(sessionId)
      s.probed.delete(sessionId)
      s.early.forget(sessionId)
    },
    onStreamData(c: StreamChunk): void {
      s.early.onStream(c)
      // Control bytes never enter the ring: its only destination is the live
      // ring, whose replay skips every control entry, and it would keep the
      // Authorization Token SETUP carries for the life of the session.
      if (c.control) {
        probeSetup(s, c)
        return
      }
      // `ByteRing.push` copies. `StreamChunk.data` is a borrowed view onto the
      // page's own buffer and the page may write through it on its next frame,
      // so retaining the view rather than a copy would silently rewrite bytes
      // already in the ring.
      s.ring.push({
        sessionId: c.sessionId,
        streamId: c.streamId,
        dir: c.direction,
        control: c.control,
        atMono: c.at,
        data: c.data,
      })
    },
    onStreamClose(sessionId: string, streamId: number): void {
      s.early.onStreamClose(sessionId, streamId)
    },
    onStreamError(): void {},
    onDatagram(c: DatagramChunk): void {
      s.early.onDatagram(c.sessionId, c.data.byteLength)
      s.ring.push({
        sessionId: c.sessionId,
        streamId: DORMANT_DATAGRAM_STREAM_ID,
        dir: c.direction,
        control: false,
        atMono: c.at,
        data: c.data,
      })
    },
  }
}

/**
 * Install the hook, dormant, and return it. Idempotent.
 *
 * Called at module-eval time from `src/index.ts` and again from `init()`, which
 * is what makes an `init()` after an `end()` work: `end()` uninstalls,
 * and a second `init()` re-installs rather than binding to a global that is no
 * longer patched.
 *
 * So the cache is checked rather than trusted, and a hook that is no longer
 * installed is dropped and replaced. An uninstalled hook is not a hook: its
 * `live` flag is false, so `setObserver` is a no-op and the global it patched is
 * the page's own constructor again. A collector built on one sees not a single
 * byte — a session with a setup record, an end record and nothing in
 * between, because those two come from the API surface while everything else
 * comes from the decoder.
 *
 * The check is `patched && !installed` rather than `!installed` alone because a
 * global with no `WebTransport` yields a permanently inert hook, and re-running
 * the install for that on every call would allocate a ring per call to reach
 * the same answer.
 */
let presence: PresenceHandle | null = null

export function ensureDormantHook(): TransportHook {
  const live = state
  if (live !== null) {
    if (!live.patched || live.hook.installed) return live.hook
    // Uninstalled underneath us. Drop the whole state, not just the hook: its
    // ring holds bytes from a session that has already ended and its session
    // map names transports the new hook has never seen.
    state = null
    clearPresence()
  }
  if (installFailed) return inert()
  try {
    const ring = new ByteRing({ maxBytes: DEFAULT_LIMITS.dormantRingBytes })
    const next: DormantState = {
      // Placeholder, replaced immediately below. `installWebTransportHook` needs
      // an observer that already closes over the state it writes into, and the
      // state needs the hook, so one of the two is assigned after construction.
      hook: inert(),
      ring,
      sessions: new Map(),
      protocols: new Map(),
      setupDrafts: new Map(),
      probed: new Map(),
      early: new EarlyBuffer(),
      patched: false,
    }
    const hook = installWebTransportHook(globalThis, dormantObserver(next), {
      // A throw inside the collector must never reach the page. There is
      // no customer error callback yet — `init()` has not been called — so a
      // dormant internal error is swallowed rather than logged, because writing
      // to the console from a module-eval side effect is its own kind of rude.
      onInternalError: () => {},
    })
    // Announce ourselves on the page global. Dormant, because that is what we
    // are until a key arrives -- the extension distinguishes the two, and "SDK
    // present but sending nothing" is a misconfiguration worth naming.
    presence = publishPresence(globalThis, COLLECTOR_VERSION, Date.now())

    state = { ...next, hook, patched: hook.installed }
    // The observer above closed over `next`, whose ring, sessions and protocols
    // are the same objects as `state`'s. Only `hook` differs, and the observer
    // never reads it.
    return hook
  } catch {
    installFailed = true
    return inert()
  }
}

/**
 * Flip the page-global marker between dormant and transmitting.
 *
 * Called by `init()` once a key is resolved, and by teardown. Safe before
 * `ensureDormantHook()` has run and safe when the marker could not be written.
 */
export function setPresenceActive(active: boolean): void {
  presence?.setActive(active)
}

/** Remove the page-global marker. */
export function clearPresence(): void {
  presence?.remove()
  presence = null
}

/** The dormant buffer, or `null` when the hook never installed. */
export function dormantState(): DormantState | null {
  return state
}

/**
 * Hand the pre-key bytes to the live collector and empty the ring.
 *
 * Returns a snapshot rather than the ring itself: the live collector's ring is
 * sized by `flightRecorder.depth`, which the customer chose, while this one is
 * sized by `limits.dormantRingBytes`, which they did not. Copying entries across
 * lets the destination's own bound apply — a customer who configured a 1 MB
 * recorder does not get a 16 MB one because the page connected early.
 *
 * The held control plane moves whole and the buffer holds nothing after it:
 * from here the collector's own observer sees every byte.
 */
export function drainDormant(): {
  entries: RingEntry[]
  sessions: Map<string, InterceptedSession>
  protocols: Map<string, string>
  setupDrafts: Map<string, SupportedDraft>
  early: Map<string, EarlyConnection>
} {
  const s = state
  if (s === null) {
    return {
      entries: [],
      sessions: new Map(),
      protocols: new Map(),
      setupDrafts: new Map(),
      early: new Map(),
    }
  }
  const entries = s.ring.snapshot()
  s.ring.clear()
  return {
    entries,
    sessions: new Map(s.sessions),
    protocols: new Map(s.protocols),
    setupDrafts: new Map(s.setupDrafts),
    early: s.early.take(),
  }
}

/**
 * Drop the held control plane and hold no more: no collector will attach in
 * this realm. The ring is untouched; it is memory-only and overwrites itself.
 */
export function releaseDormantEarly(): void {
  state?.early.release()
}

/**
 * Uninstall and forget. Both lifecycle verbs "restore the wrapped
 * globals", and the transport module's `uninstall` also detaches every
 * per-instance patch on sessions that are still open — which is the case
 * `discard()` exists for.
 */
export function teardownDormant(): void {
  const s = state
  state = null
  claimant = 0
  claimHeld = false
  clearPresence()
  if (s === null) return
  try {
    s.ring.clear()
    s.early.release()
    s.hook.uninstall()
  } catch {
    // Teardown is best-effort by construction: the objects being restored are
    // the page's, and a page that replaced its own WebTransport meanwhile is
    // not a failure this package reports into.
  }
}

/* ── who the hook belongs to ─────────────────────────────────────────────── */

/**
 * The claim currently entitled to tear the hook down, and whether the collector
 * holding it is still running.
 *
 * Two variables rather than one because they answer different questions and go
 * false at different moments. `claimHeld` is about the *customer's* intent — it
 * clears the instant `end()` or `discard()` is called — and a second `init()`
 * while it is set is a double `init()` worth reporting. `claimant` is about
 * *authority*, and only a newer claim or the teardown itself clears it.
 */
let claims = 0
let claimant = 0
let claimHeld = false

/** One collector's hold on the dormant hook. See {@link claimDormantHook}. */
export interface DormantClaim {
  /** The hook, guarded so a superseded collector can neither detach nor uninstall it. */
  readonly hook: TransportHook
  /** An earlier collector still held the claim: `init()` over a running collector. */
  readonly superseded: boolean
  /** The customer asked this collector to stop. Frees the claim; restores nothing. */
  release(): void
}

/**
 * Take the dormant hook for one collector.
 *
 * **Why a claim rather than the hook itself.** `end()` is asynchronous — it
 * drains and uploads before it restores the global — and a single-page
 * application that switches channel does not await it before re-creating its
 * player. The old collector's teardown therefore lands *after* the new one is
 * running, where an unguarded `uninstall()` would restore the page's own
 * constructor out from under a live collector and an unguarded
 * `setObserver(null)` would silently detach it. Both produce a session that
 * reports setup, terminal, and nothing in between.
 *
 * So a collector never touches the hook directly. It touches its claim, and a
 * claim that a later `init()` has superseded does nothing at all — everything it
 * wanted to undo has already been taken over by somebody else.
 */
export function claimDormantHook(): DormantClaim {
  const hook = ensureDormantHook()
  claims += 1
  const mine = claims
  const superseded = claimHeld
  claimant = mine
  claimHeld = true
  const held = (): boolean => claimant === mine
  return {
    superseded,
    release(): void {
      if (held()) claimHeld = false
    },
    hook: {
      get installed(): boolean {
        return held() && hook.installed
      },
      setObserver(next): void {
        if (held()) hook.setObserver(next)
      },
      uninstall(): void {
        // Through `teardownDormant` rather than `hook.uninstall()` so the module
        // singleton is dropped with the hook it holds; leaving it behind would
        // bind the next `init()` to an uninstalled hook.
        if (held()) teardownDormant()
      },
    },
  }
}

/** Only for the suite: forget the module singleton without touching the global. */
export function resetDormantForTest(): void {
  state = null
  installFailed = false
  claimant = 0
  claimHeld = false
}

function inert(): TransportHook {
  return { installed: false, setObserver: () => {}, uninstall: () => {} }
}
