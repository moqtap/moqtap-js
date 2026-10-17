/**
 * How a `.moqtrace` reaches the viewer.
 *
 * Two ways in, one check:
 *
 * - a **parent** posts it: `app.moqtap.com` with a shared trace, or the
 *   inspector page on `moqtap.com` (served on loopback in development), which
 *   relays what `moqtap inspect`'s shell hands it. Who counts as a parent is
 *   `parents.ts`'s decision, not this file's;
 * - the **person** opens a file from their own machine, by picker or by drop.
 *   Those bytes are read here and go nowhere else: nothing in the viewer can
 *   send them, and the view origin's `connect-src 'none'` makes that a
 *   property of the origin rather than of this code.
 */

import {
  askParentToShare,
  asThemeMessage,
  asTraceMessage,
  canOfferLocalOpen,
  canOfferShare,
  type FrameState,
  ParentGate,
  READY,
  tellParent,
  titlesTrace,
} from './parents'
import type { Theme } from './theme'

/** Where a trace came from. Shown to the reader, so it is not an internal tag. */
export type IngestSource = 'file' | 'parent'

export interface IngestedTrace {
  readonly source: IngestSource
  readonly bytes: Uint8Array
  /** File name where one is known. A parent may not send one. */
  readonly name?: string
  /** The parent's origin, for `parent` only. */
  readonly origin?: string
  /** The parent marked it as what a share request would share. `parent` only. */
  readonly shareable?: boolean
  /** The parent read it from the person's machine itself. `parent` only. */
  readonly local?: boolean
}

export interface IngestHandlers {
  onTrace(trace: IngestedTrace): void
  /** Called for input that reached us and was refused, with a reason to show. */
  onReject(reason: string): void
  /** Called when the bound parent's theme changes. */
  onTheme?(theme: Theme): void
}

/**
 * The first eight bytes of every `.moqtrace` file: `MOQTRACE` in ASCII.
 *
 * Written out here rather than taken from `@moqtap/trace`, which keeps it
 * internal. Importing the reader for it would pull the decoder onto the main
 * thread to look at eight bytes, which is the work the worker exists to move
 * off it, and this check has to happen here, before a worker is worth
 * starting, so that dropping a `.mp4` is answered immediately.
 *
 * It is a pre-flight check and nothing more. Passing it means the file starts
 * with the right eight bytes, not that it decodes.
 */
const MAGIC = 'MOQTRACE'

export function looksLikeTrace(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) return false
  }
  return true
}

/** What Share decides on: where the trace came from, not its bytes. */
export type ShareCandidate = Pick<IngestedTrace, 'source' | 'shareable' | 'local'>

export interface Ingest {
  /** Stop listening. */
  stop(): void
  /**
   * Report to the parent how the last trace it sent went. Does nothing for a
   * trace the person opened themselves, or before any parent spoke.
   */
  report(trace: IngestedTrace, state: FrameState): void
  /**
   * Whether the page should offer Share while `trace` is on screen (`null`
   * for nothing on screen). The bound parent must have sent it, marked it
   * `shareable`, and be one that answers a share request. A file the person
   * opened here is never offered, because the request asks the parent to
   * share what *it* holds, which is not what would be on screen. This is the
   * whole decision; the page only shows or hides the button on it.
   */
  canShare(trace: ShareCandidate | null): boolean
  /** Ask the parent for its share dialog. Sends nothing unless `canShare`. */
  requestShare(trace: ShareCandidate | null): boolean
  /**
   * Whether the page should offer "Open capture" while `trace` is on screen
   * (`null` for nothing on screen). Hidden beside a trace a parent handed over
   * to be read; see `canOfferLocalOpen`.
   */
  canOpenLocal(trace: ShareCandidate | null): boolean
  /**
   * Whether the header should carry the page's own title while `trace` is on
   * screen (`null` for nothing on screen). Not when a framing page names the
   * trace itself; see `titlesTrace`.
   */
  showsTitle(trace: ShareCandidate | null): boolean
}

/**
 * The parts of `window` the listener touches.
 *
 * An argument rather than a global so that the wiring (admit before reading,
 * announce only when framed, report only through `tellParent`) is tested
 * against fake windows in a workspace with no DOM. The page passes `window`.
 */
export interface IngestHost {
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void }
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

/**
 * Start listening for a parent.
 *
 * Announces readiness first, because a parent that posts the moment the iframe
 * element loads posts before any listener exists here; the parent answers the
 * announcement instead. Only a framed viewer announces.
 */
export function startIngest(handlers: IngestHandlers, host: IngestHost = window): Ingest {
  const gate = new ParentGate(host.parent, host)

  const onMessage = (event: MessageEvent) => {
    if (!gate.admit(event)) return
    const theme = asThemeMessage(event.data)
    if (theme !== null) {
      handlers.onTheme?.(theme)
      return
    }
    const msg = asTraceMessage(event.data)
    if (msg === null) return
    if (!looksLikeTrace(msg.bytes)) {
      handlers.onReject(
        `The page around this viewer sent ${msg.bytes.length} bytes that aren't a .moqtrace file.`,
      )
      tellParent(gate, host.parent, 'failed')
      return
    }
    handlers.onTrace({
      source: 'parent',
      bytes: msg.bytes,
      origin: event.origin,
      ...(msg.name === undefined ? {} : { name: msg.name }),
      ...(msg.shareable === true ? { shareable: true } : {}),
      ...(msg.local === true ? { local: true } : {}),
    })
  }

  host.addEventListener('message', onMessage)
  // Unframed, `window.parent` is `window` itself. The types are unrelated, so
  // the identity check needs the cast.
  if ((host.parent as unknown) !== host) host.parent.postMessage(READY, '*')

  return {
    stop: () => host.removeEventListener('message', onMessage),
    report: (trace, state) => {
      if (trace.source !== 'parent') return
      tellParent(gate, host.parent, state)
    },
    canShare: (trace) => canOfferShare(gate, trace),
    requestShare: (trace) => {
      if (!canOfferShare(gate, trace)) return false
      return askParentToShare(gate, host.parent)
    },
    canOpenLocal: (trace) => canOfferLocalOpen(gate, trace),
    showsTitle: (trace) => titlesTrace(gate, trace),
  }
}

/**
 * A file the person chose or dropped.
 *
 * Shares the magic check with the parent path so that one bad file produces
 * one message however it arrived.
 */
export async function ingestFile(file: File): Promise<IngestedTrace> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!looksLikeTrace(bytes)) {
    throw new Error(
      `${file.name} isn't a .moqtrace file: it doesn't start with the MOQTRACE signature.`,
    )
  }
  return { source: 'file', bytes, name: file.name }
}
