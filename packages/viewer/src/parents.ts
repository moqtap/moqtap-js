/**
 * Who may put a trace into this frame, and who may hear back from it.
 *
 * The viewer renders bytes someone else wrote (a share sender, or the far end
 * of a recorded session) on an origin that holds nothing. What it must never
 * become is a way to read a trace out: a page that frames the viewer and
 * receives what it shows has the trace. So the frame talks to exactly one
 * parent, chosen by an allowlist fixed when the bundle is built, and the rest
 * of the web gets nothing but a dataless "ready".
 *
 * Kept free of the DOM so the gate can be tested as a function. `ingest.ts`
 * wires it to `window`.
 */

/**
 * The parents a production bundle answers.
 *
 * - `app.moqtap.com` frames the viewer on the share landing and in the library.
 * - `moqtap.com` frames it from `/tools/moqtrace-inspector`, the page the CLI
 *   prints and frames in turn.
 *
 * Exact origins, compared as strings. `event.origin` is always the serialised
 * origin (scheme, host, port only if non-default), so string equality is the
 * whole comparison and there is no parsing to get wrong.
 */
export const PRODUCTION_PARENTS: readonly string[] = [
  'https://app.moqtap.com',
  'https://moqtap.com',
]

/**
 * Extra parents for non-production deployments, injected at build time
 * (`--staging-parent`, see `scripts/build.ts`). A bundle built without any
 * answers only the production parents and loopback.
 */
declare const __MOQTAP_VIEW_STAGING_PARENTS__: readonly string[] | undefined

export const STAGING_PARENTS: readonly string[] =
  typeof __MOQTAP_VIEW_STAGING_PARENTS__ === 'undefined' ? [] : __MOQTAP_VIEW_STAGING_PARENTS__

export interface ParentPolicy {
  /** Origins accepted verbatim. */
  readonly exact: readonly string[]
  /**
   * Accept `http://127.0.0.1:<port>` and `http://localhost:<port>`, any port.
   *
   * This is the site's inspector page served on loopback by the site's dev
   * server, on whatever port it picked. `moqtap inspect`'s shell frames the site page, not this frame, so it reaches the viewer only
   * through that page. Both spellings, because a page addressed as
   * `127.0.0.1` and a browser resolving `localhost` are different origins.
   */
  readonly loopback: boolean
}

export const DEFAULT_POLICY: ParentPolicy = {
  exact: [...PRODUCTION_PARENTS, ...STAGING_PARENTS],
  loopback: true,
}

/**
 * Is `origin` a parent this frame will listen to?
 *
 * The loopback case is the only one that parses, and it parses rather than
 * pattern-matches because `http://127.0.0.1.evil.com` contains the loopback
 * spelling and is not loopback. Requiring the parsed URL to serialise back to
 * exactly the input rejects anything with a path, credentials or other
 * decoration, so only a bare origin passes. Plain `http:` only: the site's dev
 * server serves HTTP on loopback, and nothing legitimate frames the viewer
 * from an `https:` loopback page.
 */
export function isAllowedParent(origin: string, policy: ParentPolicy): boolean {
  if (policy.exact.includes(origin)) return true
  return policy.loopback && isLoopbackOrigin(origin)
}

/** A bare `http:` origin on `127.0.0.1` or `localhost`, any port. */
function isLoopbackOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.origin !== origin) return false
  if (url.protocol !== 'http:') return false
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
}

/** The parts of a `MessageEvent` the gate decides on. */
export interface Incoming {
  readonly origin: string
  /** `event.source`. */
  readonly source: unknown
  readonly data: unknown
}

/**
 * The handshake.
 *
 * The frame does not know who framed it: `document.referrer` is gone under
 * `no-referrer`, and `location.ancestorOrigins` is Chromium-only. So it learns
 * its parent from the first message that is (a) from `window.parent` and (b)
 * from an allowed origin, and from then on that exact origin is the only one
 * it hears and the only one it ever addresses. A frame stays bound for its
 * whole life; a parent that navigates away takes the frame with it.
 */
export class ParentGate {
  #bound: string | null = null

  constructor(
    private readonly parent: unknown,
    private readonly self: unknown,
    private readonly policy: ParentPolicy = DEFAULT_POLICY,
  ) {}

  /** The parent this frame handshook with, or `null` before any message. */
  get origin(): string | null {
    return this.#bound
  }

  /** Whether this page is in a frame at all. */
  get framed(): boolean {
    return this.parent !== this.self
  }

  /**
   * Whether to act on `event`. Binds on the first admitted message.
   *
   * Everything refused is refused silently: a frame receives ordinary
   * cross-origin chatter (extensions, sibling frames, analytics), and none of
   * it is a failed import worth showing.
   */
  admit(event: Incoming): boolean {
    // Not framed: `window.parent === window`, and a page cannot be its own
    // parent in the sense this gate means.
    if (this.parent === this.self) return false
    // A sibling frame or a popup can carry an allowed origin too: any page on
    // `moqtap.com` can open a window. Only the frame's own parent counts.
    if (event.source === null || event.source !== this.parent) return false
    if (!isAllowedParent(event.origin, this.policy)) return false
    if (this.#bound !== null && event.origin !== this.#bound) return false
    this.#bound = event.origin
    return true
  }
}

/** What a parent posts. Unknown shapes are ignored, not rejected. */
export interface TraceMessage {
  readonly bytes: Uint8Array
  readonly name?: string
  /**
   * The sender says this trace is the recording a share request would share.
   * Present only as `true`. See `canOfferShare`.
   */
  readonly shareable?: true
  /**
   * The sender read this capture from the person's machine itself (the site
   * inspector's sample, or a file dropped on its bar), so opening another one
   * is the point. Present only as `true`. See `canOfferLocalOpen`.
   */
  readonly local?: true
}

/**
 * Read a trace out of an admitted message, or `null` if it carries none.
 *
 * The shape is the one `moqtap inspect`'s shell sends,
 * `{ type: 'moqtrace', bytes, name }`, and released binaries have it compiled
 * in, so it is kept rather than redesigned. `shareable` and `local` are
 * optional, and only the site relay sets them.
 */
export function asTraceMessage(data: unknown): TraceMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const msg = data as Record<string, unknown>
  if (msg.type !== 'moqtrace') return null
  const { bytes } = msg
  let view: Uint8Array
  if (bytes instanceof Uint8Array) view = bytes
  else if (bytes instanceof ArrayBuffer) view = new Uint8Array(bytes)
  else return null
  return {
    bytes: view,
    ...(typeof msg.name === 'string' ? { name: msg.name } : {}),
    ...(msg.shareable === true ? { shareable: true as const } : {}),
    ...(msg.local === true ? { local: true as const } : {}),
  }
}

/**
 * The announcement, posted once to `window.parent` with target `'*'`.
 *
 * `'*'` because the frame does not yet know its parent's origin (the handshake
 * finds that out), so it must say nothing a stranger could use. A type
 * and a version; no data. The type is the one released CLI shells wait for.
 */
export const READY = Object.freeze({ type: 'moqtrace-inspector-ready', version: 1 })

/** The only things the frame ever tells a parent after the handshake. */
export type FrameState = 'opened' | 'failed'

interface PostTarget {
  postMessage(message: unknown, targetOrigin: string): void
}

/**
 * Post to the handshaken parent, and to nobody else.
 *
 * Returns whether anything was sent. Before a handshake it sends nothing: with
 * no bound origin the only possible target is `'*'`, which is exactly the
 * leak this exists to prevent. The message carries a state and no file name,
 * no size, no text: the parent sent the bytes and knows what they were.
 */
export function tellParent(gate: ParentGate, parent: PostTarget, state: FrameState): boolean {
  const origin = gate.origin
  if (origin === null) return false
  parent.postMessage({ type: 'moqtrace-view-state', state }, origin)
  return true
}

/**
 * The site's inspector page, the one exact parent that can pass a share
 * request on. The CLI's shell frames that
 * page, not this frame, and hears a share request only from it.
 */
export const SITE_RELAY_PARENT = 'https://moqtap.com'

/**
 * The frame asking for a share dialog. A type and nothing else: the parent
 * that receives it already holds the recording it sent, so the request needs
 * no bytes, no name and no options. Choosing and confirming a share happen in
 * the shell's own DOM. The type is the one released CLI shells
 * and the site relay match on.
 */
export const SHARE_REQUEST = Object.freeze({ type: 'moqtrace-share-request' })

/**
 * Is `origin` a parent that answers a share request?
 *
 * The site's inspector page answers: it relays the request to the
 * `moqtap inspect` shell that framed it. So does the same page served on
 * loopback by the site's dev server. No shell frames this viewer directly. The
 * portal does not answer: it has its own share dialog, and a frame asking it
 * for one would be a second, unchecked way to start the same flow. Extra
 * build-time parents are portal hosts, so they are refused for the same
 * reason.
 */
export function answersShareRequest(origin: string | null): boolean {
  if (origin === null) return false
  return origin === SITE_RELAY_PARENT || isLoopbackOrigin(origin)
}

/**
 * Should the page offer Share while `trace` is on screen?
 *
 * Only for a trace the bound parent sent and marked `shareable`. The origin
 * alone cannot decide this. The site page that relays the request also opens
 * traces of its own (its sample, or a file dropped on its bar). A share
 * request reaches the shell, and the shell shares the recording it handed
 * over, not what is on screen. On a plain visit no shell is bound, and the
 * request goes nowhere. Only the relay knows which case it is in, so it marks
 * the one trace a request would share. An unmarked trace offers nothing.
 */
export function canOfferShare(
  gate: ParentGate,
  trace: { readonly source: string; readonly shareable?: boolean | undefined } | null,
): boolean {
  if (trace === null || trace.source !== 'parent' || trace.shareable !== true) return false
  return answersShareRequest(gate.origin)
}

/**
 * Ask the handshaken parent for its share dialog, if it is one that answers.
 *
 * Returns whether anything was sent. Before a handshake, or bound to a parent
 * that does not answer, it sends nothing, and it never addresses `'*'`.
 */
export function askParentToShare(gate: ParentGate, parent: PostTarget): boolean {
  const origin = gate.origin
  if (origin === null || !answersShareRequest(origin)) return false
  parent.postMessage(SHARE_REQUEST, origin)
  return true
}

/**
 * Should the page offer to open a capture from this machine while `trace` is
 * on screen (`null` for nothing on screen)?
 *
 * The button belongs where opening a local file is the point: the viewer on
 * its own, a file opened in it, and the site's inspector page showing a
 * capture it read itself, which it marks `local`. It does not belong beside a
 * trace a parent handed over to be read: the portal's library and share
 * landing, and the site page relaying the CLI shell's recording. Those
 * parents frame the viewer to show one trace, and a file opened over it would
 * replace that trace in a page that still says it is showing it.
 *
 * So a parent's trace offers it only when marked, and only from the site
 * relay. The origin alone cannot decide: the portal in development is served
 * on loopback too, where the site's dev server also runs.
 *
 * With nothing on screen a framed page offers nothing here: the empty state
 * carries its own file chooser, and the portal posts its trace the moment the
 * frame announces itself, so a header button would only flash.
 */
export function canOfferLocalOpen(
  gate: ParentGate,
  trace: { readonly source: string; readonly local?: boolean | undefined } | null,
): boolean {
  if (trace === null) return !gate.framed
  if (trace.source !== 'parent') return true
  return trace.local === true && answersShareRequest(gate.origin)
}
