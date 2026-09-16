/**
 * The draft-mismatch refusal, and the await window the lazy draft import opens.
 *
 * A draft mismatch must fail loudly: the customer pins a draft, the negotiated
 * `session.protocol` after `ready` says what was agreed, and on disagreement
 * this package must not parse. The refusal is implemented as **withholding the
 * adapter**, not as a flag a consumer may ignore — {@link LoadResult} carries
 * `adapter` only when `ok` is true, so there is no object to parse with and no
 * code path that can decide to try anyway.
 *
 * What makes the failure silent without it is in `varint.ts`: RFC 9000's
 * varints (drafts 07-16) and MoQT's leading-1-bits vi64 (draft-17 on) **disagree
 * on the same bytes**, and the loser returns a plausible number rather than an
 * error. `af 00` is SETUP's type `0x2F00` read as vi64 and `0x2F00xxxx` — four
 * bytes, two of them stolen from the next field — read as RFC 9000.
 *
 * The dynamic import also puts an `await` between `session.protocol` being known
 * and the first parse, across the most information-dense moment in the session,
 * so the caller holds the two halves together:
 *
 *   1. `onSessionProtocol` fires. **Keep pushing raw chunks into the ring**
 *      (`src/ring/`, sized by `Limits.dormantRingBytes`). Do not decode; there
 *      is no adapter yet and guessing one is the silent failure above.
 *   2. `await loadDraft(protocol, opts)`, bounded by
 *      {@link DEFAULT_IMPORT_TIMEOUT_MS} — an import may never resolve when the
 *      page is offline, a chunk 404s mid-deploy, or CSP refuses it.
 *   3. `ok` — replay the ring through the adapter, then decode live.
 *      Not `ok` — drop to transport-only metrics, keep shipping raw control
 *      bytes, and stamp `SetupRecord.degraded` from {@link degradedReasonOf}.
 *      That is no parse at all, with the control plane still reaching ingest as
 *      bytes for a server-side reparse to recover after the fact.
 *
 * `pin` (`CollectorConfig.drafts`) only selects among the literal specifiers in
 * {@link DRAFT_LOADERS} that a bundler can already see; it never supplies the
 * draft. A pinned draft the session did not negotiate is a mismatch, and an
 * unrecognised or absent `session.protocol` is refused pin or no pin.
 * {@link preloadDrafts} is the pin's eager half.
 */

import type { DraftAdapter, SetupRecord, SupportedDraft } from '../types.js'
import { DRAFT_LOADERS, type DraftModule } from './loaders.js'
import { draftOfProtocol, SUPPORTED_DRAFTS } from './protocol.js'

/** Why {@link loadDraft} withheld an adapter. */
export type LoadFailure = 'unsupported-protocol' | 'pin-mismatch' | 'import-failed' | 'timeout'

/**
 * The outcome. **`adapter` is present only when `ok` is true** — the refusal is
 * the absence of the object, not a flag beside it.
 */
export interface LoadResult {
  readonly ok: boolean
  readonly draft?: SupportedDraft
  readonly adapter?: DraftAdapter
  readonly reason?: LoadFailure
}

export interface LoadOptions {
  /**
   * The static pin — `CollectorConfig.drafts`. Selects among literal
   * specifiers; never supplies the draft. An empty array is read as "no pin",
   * because `ResolvedConfig` always populates `drafts` and turning a config
   * typo into total data loss is not a bound worth having.
   */
  readonly pin?: readonly SupportedDraft[]
  /** Zero, negative or non-finite means no timeout. Default {@link DEFAULT_IMPORT_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Called with the {@link LoadFailure} on every non-`ok` outcome. Never throws onward. */
  readonly onDegraded?: (reason: string) => void
}

/**
 * How long to wait for a draft chunk before degrading to transport-only.
 *
 * **Unmeasured**: no chunk fetch has been timed on a real customer's CDN, and
 * what matters is the tail, not the median. Five seconds is long enough that an
 * ordinary cold fetch on a bad connection still lands, and short enough that a
 * session behind a CSP which will never allow the chunk stops paying ring memory
 * for it. `Limits` has no slot for it, so `LoadOptions.timeoutMs` is the
 * override.
 */
export const DEFAULT_IMPORT_TIMEOUT_MS = 5000

const TIMED_OUT: unique symbol = Symbol('draft-import-timeout')

/**
 * One in-flight or settled chunk per draft, module-scoped rather than
 * per-session: a page with several transports pays one fetch rather than one per
 * session (the 8-transport cap makes that a real multiplier), and
 * {@link preloadDrafts} needs somewhere to put the pin's eager fetch.
 */
const CHUNKS = new Map<SupportedDraft, Promise<DraftModule>>()

function importDraft(draft: SupportedDraft): Promise<DraftModule> {
  const cached = CHUNKS.get(draft)
  if (cached !== undefined) return cached

  let started: Promise<DraftModule>
  try {
    started = DRAFT_LOADERS[draft]()
  } catch (err) {
    // A bundler that resolved the specifier to nothing throws synchronously.
    return Promise.reject(err)
  }

  const guarded = started.then(
    (mod) => mod,
    (err: unknown) => {
      // A failed chunk fetch is usually transient — offline, a 404 during a
      // deploy, a CSP refusal a later navigation does not repeat. Evicting lets
      // the next session retry rather than inheriting one bad load for the life
      // of the page.
      CHUNKS.delete(draft)
      throw err
    },
  )
  // The timeout race below may abandon this promise, and an abandoned rejection
  // is an unhandled rejection in Node and a console error in the browser, and
  // non-interference is a promise about the page's console too. One inert
  // handler settles that without hiding anything from the real awaiter.
  guarded.catch(() => undefined)
  CHUNKS.set(draft, guarded)
  return guarded
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (!Number.isFinite(ms) || ms <= 0) return p
  let timer: ReturnType<typeof setTimeout> | undefined
  const alarm = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })
  return Promise.race([p, alarm]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * Whether the pin admits this draft.
 *
 * Absent, not an array, or empty ⇒ no pin ⇒ every supported draft is admitted.
 * A pin naming drafts this package cannot parse simply never matches, which is
 * the right outcome and needs no special case.
 */
function pinAdmits(pin: LoadOptions['pin'], draft: SupportedDraft): boolean {
  if (pin === undefined || !Array.isArray(pin) || pin.length === 0) return true
  return pin.includes(draft)
}

/**
 * The loaded chunk, checked before it is trusted.
 *
 * The assertion worth having is the third: `adapter.protocolString` must equal
 * the string that was actually negotiated. `PROTOCOL_STRINGS` in `protocol.ts`
 * and the adapter's own field are two copies of one wire constant, and drift
 * between two copies has already cost this workspace months
 * (`extension/src/detect/uni-control-prefix.ts`, where a duplicated `6f 00`
 * meant no draft-17+ control stream ever matched). Here the drift would be a
 * session parsed by the wrong draft's adapter.
 */
function usableAdapter(mod: unknown, draft: SupportedDraft, protocol: string): DraftAdapter | null {
  if (typeof mod !== 'object' || mod === null) return null
  const candidate = (mod as { adapter?: unknown }).adapter
  if (typeof candidate !== 'object' || candidate === null) return null
  const a = candidate as Partial<DraftAdapter>
  if (a.draft !== draft) return null
  if (a.protocolString !== protocol) return null
  if (typeof a.decodeControl !== 'function') return null
  if (typeof a.readSubgroupHeader !== 'function') return null
  if (typeof a.varint?.read !== 'function') return null
  return candidate as DraftAdapter
}

function report(onDegraded: LoadOptions['onDegraded'], reason: LoadFailure): void {
  if (onDegraded === undefined) return
  try {
    onDegraded(reason)
  } catch {
    // A customer callback that throws must not become this package's throw:
    // there is no `onInternalError` channel on this call, and swallowing beats
    // propagating into a session's setup path.
  }
}

/**
 * Load the adapter for a negotiated protocol, or refuse.
 *
 * Never throws and never rejects: every failure is a {@link LoadResult} with
 * `ok: false`, because this is called from the session-open path and a throw
 * there lands in the customer's own stack.
 *
 * @param protocol `session.protocol` **after `ready`**. An empty or
 *   unrecognised string is `unsupported-protocol` — never an invitation to fall
 *   back to the pin, which would be guessing the draft, which is the one thing
 *   a mismatch forbids.
 */
export async function loadDraft(protocol: string, opts: LoadOptions = {}): Promise<LoadResult> {
  const draft = typeof protocol === 'string' ? draftOfProtocol(protocol) : undefined
  if (draft === undefined) {
    report(opts.onDegraded, 'unsupported-protocol')
    return { ok: false, reason: 'unsupported-protocol' }
  }
  return loadDraftNumber(draft, protocol, opts)
}

/**
 * Load the adapter for a draft resolved from the **wire** rather than the ALPN.
 *
 * The eight drafts before -15 all negotiate `moq-00`, so `session.protocol` does
 * not identify them. The caller reads the selected version out of SETUP
 * (`setup-probe.ts`) and brings the draft here with the protocol string it was
 * observed under.
 *
 * **Not** a hole in the refusal: the two varint families disagree on the same
 * bytes and the loser returns plausible numbers rather than an error, so the
 * draft must come from evidence and never from a preference — and a version in
 * the peer's own SETUP frame is better evidence than an ALPN that is a constant
 * for these drafts. Still forbidden, and still enforced below, is the pin
 * supplying a draft the session did not show us.
 */
export async function loadDraftNumber(
  draft: SupportedDraft,
  protocol: string,
  opts: LoadOptions = {},
): Promise<LoadResult> {
  const fail = (reason: LoadFailure): LoadResult => {
    report(opts.onDegraded, reason)
    return { ok: false, reason }
  }

  if (DRAFT_LOADERS[draft] === undefined) return fail('unsupported-protocol')
  if (!pinAdmits(opts.pin, draft)) return fail('pin-mismatch')

  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_IMPORT_TIMEOUT_MS : opts.timeoutMs
  let mod: DraftModule | typeof TIMED_OUT
  try {
    mod = await withTimeout(importDraft(draft), timeoutMs)
  } catch {
    return fail('import-failed')
  }
  if (mod === TIMED_OUT) return fail('timeout')

  const adapter = usableAdapter(mod, draft, protocol)
  if (adapter === null) return fail('import-failed')
  return { ok: true, draft, adapter }
}

/**
 * Start the **pinned** chunks fetching before any session exists — the eager
 * half of the static pin. Call it from `init()` with `CollectorConfig.drafts`:
 * with the cache warm, {@link loadDraft} settles in a microtask, and a microtask
 * cannot be interleaved with a further stream `read` or `datagrams` event, so
 * the buffering window closes before another byte can arrive.
 *
 * **With no pin this does nothing, deliberately.** Preloading both drafts costs
 * both chunks — roughly 10.6 KB gz against 5.3 for the one the session actually
 * negotiates — spending the per-draft split's 7.5× saving on a window the ring
 * already covers.
 *
 * Never rejects: a chunk that fails to preload is evicted and retried by the
 * first {@link loadDraft} that needs it.
 */
export function preloadDrafts(pin?: readonly SupportedDraft[]): Promise<void> {
  if (pin === undefined || !Array.isArray(pin) || pin.length === 0) return Promise.resolve()
  const wanted: SupportedDraft[] = []
  for (const d of pin) {
    // A pin naming a draft this build has no chunk for is ignored rather than
    // thrown on: it is a config typo, and turning one into a failed preload
    // would cost a session its opening seconds for nothing.
    if (SUPPORTED_DRAFTS.includes(d) && !wanted.includes(d)) wanted.push(d)
  }
  return Promise.all(wanted.map((d) => importDraft(d).catch(() => undefined))).then(() => undefined)
}

/**
 * The {@link SetupRecord.degraded} value for a {@link LoadFailure}.
 *
 * `types.ts` has three values and this module distinguishes four, so the mapping
 * is made once here rather than guessed at each call site. `timeout` folds into
 * `import-failed`: from ingest's point of view the module did not arrive, and
 * how long the client waited is a client-side threshold rather than a property
 * of the session.
 */
export function degradedReasonOf(reason: LoadFailure): NonNullable<SetupRecord['degraded']> {
  switch (reason) {
    case 'pin-mismatch':
      return 'draft-mismatch'
    case 'unsupported-protocol':
      return 'unsupported-protocol'
    default:
      return 'import-failed'
  }
}
