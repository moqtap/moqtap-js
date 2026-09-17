/**
 * Protocol strings and the draft-agnostic field readers. Two jobs, both small
 * and both in the static bundle:
 *
 *  1. **`protocol` → draft, where the protocol says.** From draft-15 the version
 *     appears nowhere on the wire; ALPN (`WT-Available-Protocols` in
 *     WebTransport) is the only identifier a session carries — draft-20 §3.1:
 *     "ALPNs used to identify IETF drafts are created by appending the draft
 *     number to 'moqt-'." `session.protocol` after `ready` is therefore the
 *     whole of the evidence about what was negotiated.
 *
 *     **Before draft-15 it says less than that.** All eight of 07 through 14
 *     negotiate `moq-00` and settle the version in band, in SETUP, so this
 *     module also maps a wire version to a draft ({@link draftOfVersion}) and
 *     `setup-probe.ts` reads one off the handshake. Nothing guesses: an ALPN of
 *     `moq-00` with no readable SERVER_SETUP degrades to transport-only,
 *     exactly as an unrecognised ALPN does.
 *
 *  2. **Reading one field off an already-decoded control message.** The
 *     collector decodes control messages anyway — the draft check, the exchange
 *     latencies, the `streamId → pending request` map — so these accessors are
 *     free.
 *
 * `requestIdOf` and `trackAliasOf` are **copied** from
 * `packages/codec/src/core/accessors.ts`, not imported: they are reachable only
 * through the codec's root entry, which statically imports every draft
 * (`packages/codec/src/index.ts`) at 39.6 KB gz against 5.3 KB for one draft's
 * decoder. Both spellings are read because the codec emits **snake_case** on
 * control messages and camelCase on data-stream types
 * (`drafts/draft20/types.ts`), and a reader that assumes one spelling reads
 * `undefined` from half the wire.
 *
 * **Nothing here reads a track name, a namespace, a status or a reason
 * phrase**, and nothing here may be extended to: those are joined at ingest from
 * the raw control bytes the baseline already ships, and an accessor here would
 * put them one field access from the data path.
 */

import type { AnyMessage, ExchangeKind, SupportedDraft } from '../types.js'

/**
 * The drafts this package parses, newest first — the order a pin should prefer
 * them in. Each is behind a static literal `import()` specifier in
 * {@link DRAFT_LOADERS} and lands in its own chunk; the root `@moqtap/codec`
 * entry, which statically imports every draft, is never reachable from any
 * collector module.
 */
export const SUPPORTED_DRAFTS: readonly SupportedDraft[] = /*#__PURE__*/ Object.freeze([
  21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7,
])

/**
 * The ALPN string each draft negotiates with. A table rather than a `moqt-${n}`
 * template because there are two regimes. Draft-20 §3.1: *"ALPNs used to
 * identify IETF drafts are created by appending the draft number to 'moqt-'.
 * […] Note: Draft versions prior to -15 all used moq-00 ALPN, followed by
 * version negotiation"*.
 *
 * So `moqt-15` through `moqt-21` each name one draft, and **`moq-00` names
 * eight**; {@link LEGACY_PROTOCOL} and `../draft/setup-probe.ts` resolve the
 * latter from the wire rather than guessing.
 */
export const PROTOCOL_STRINGS: Readonly<Record<SupportedDraft, string>> =
  /*#__PURE__*/ Object.freeze({
    7: 'moq-00',
    8: 'moq-00',
    9: 'moq-00',
    10: 'moq-00',
    11: 'moq-00',
    12: 'moq-00',
    13: 'moq-00',
    14: 'moq-00',
    15: 'moqt-15',
    16: 'moqt-16',
    17: 'moqt-17',
    18: 'moqt-18',
    19: 'moqt-19',
    20: 'moqt-20',
    21: 'moqt-21',
  })

/**
 * The one ALPN that does not identify a draft. Every draft before -15 negotiates
 * it, so a session reporting it has said only "MoQT, some version before 15";
 * the version it settled on is in SERVER_SETUP. Exported because the seam has to
 * know this string means "wait for the handshake" rather than "unsupported".
 */
export const LEGACY_PROTOCOL = 'moq-00'

const DRAFT_OF_PROTOCOL: ReadonlyMap<string, SupportedDraft> = new Map([
  ['moqt-15', 15 as SupportedDraft],
  ['moqt-16', 16 as SupportedDraft],
  ['moqt-17', 17 as SupportedDraft],
  ['moqt-18', 18 as SupportedDraft],
  ['moqt-19', 19 as SupportedDraft],
  ['moqt-20', 20 as SupportedDraft],
  ['moqt-21', 21 as SupportedDraft],
])

/**
 * The draft a negotiated protocol string names, or `undefined`.
 *
 * **Exact match, deliberately**: no trimming, no case folding, no `moqt-(\d+)`
 * pattern. Guessing that `MOQT-20 ` means draft-20 risks a session parsed with
 * the wrong varint family, which reports plausible wrong numbers rather than
 * failing. An unrecognised string degrades to transport-only metrics instead —
 * a gap in the dashboard and not a lie in it.
 *
 * `moq-00` returns `undefined` too, and that is **not** the same as unsupported:
 * it is ambiguous, and the caller resolves it from SERVER_SETUP. Check
 * {@link LEGACY_PROTOCOL} before treating an `undefined` here as a refusal.
 */
export function draftOfProtocol(protocol: string): SupportedDraft | undefined {
  return DRAFT_OF_PROTOCOL.get(protocol)
}

/**
 * The draft a wire version number names, or `undefined`.
 *
 * `0xff000000 | draft` is the MoQT draft version scheme, followed by every draft
 * from 07 to 20. Second half of the `moq-00` resolution: the ALPN says "before
 * 15", SERVER_SETUP's selected version says which.
 *
 * A **table, not arithmetic**: `version - 0xff000000n` would silently accept
 * `0xff000063n` as draft-99 and hand back an adapter that does not exist, and
 * would turn a clean "unsupported" into a load failure for a draft this package
 * cannot parse. A fifteenth entry requires adding a chunk.
 */
export function draftOfVersion(version: bigint): SupportedDraft | undefined {
  return DRAFT_OF_VERSION.get(version)
}

const DRAFT_OF_VERSION: ReadonlyMap<bigint, SupportedDraft> = new Map([
  [0xff000007n, 7 as SupportedDraft],
  [0xff000008n, 8 as SupportedDraft],
  [0xff000009n, 9 as SupportedDraft],
  [0xff00000an, 10 as SupportedDraft],
  [0xff00000bn, 11 as SupportedDraft],
  [0xff00000cn, 12 as SupportedDraft],
  [0xff00000dn, 13 as SupportedDraft],
  [0xff00000en, 14 as SupportedDraft],
  [0xff00000fn, 15 as SupportedDraft],
  [0xff000010n, 16 as SupportedDraft],
  [0xff000011n, 17 as SupportedDraft],
  [0xff000012n, 18 as SupportedDraft],
  [0xff000013n, 19 as SupportedDraft],
  [0xff000014n, 20 as SupportedDraft],
])

/** First defined value among several spellings of one field. */
function pick(msg: AnyMessage, names: readonly string[]): unknown {
  for (const name of names) {
    const value = msg[name]
    if (value != null) return value
  }
  return undefined
}

function bigintOf(value: unknown): bigint | undefined {
  if (value == null) return undefined
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' || typeof value === 'string') {
    try {
      return BigInt(value)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * The request this message belongs to.
 *
 * `subscribe_id` through draft-10, `request_id` from draft-11. Returns
 * `undefined` for draft-17+ *responses*, which carry no id at all — each request
 * has its own bidirectional stream and that stream, not a field, ties a response
 * to its request (draft-20's SUBSCRIBE_OK is `{track_alias, parameters,
 * track_properties}`, `drafts/draft20/types.ts`).
 */
export function requestIdOf(msg: AnyMessage): bigint | undefined {
  return bigintOf(pick(msg, ['request_id', 'requestId', 'subscribe_id', 'subscribeId']))
}

/**
 * The track alias this message assigns or refers to, if any.
 *
 * Which message carries it moved: SUBSCRIBE through draft-11 (the *subscriber*
 * chose it — `drafts/draft07/types.ts`), then SUBSCRIBE_OK from draft-12, when
 * assigning it became the publisher's job. PUBLISH carries it in every draft
 * that has PUBLISH. This is the one field {@link BucketKey} is built on, and the
 * only reason `applyControl` decodes anything at all.
 */
export function trackAliasOf(msg: AnyMessage): bigint | undefined {
  return bigintOf(pick(msg, ['track_alias', 'trackAlias']))
}

/**
 * The abstract exchange a message belongs to.
 *
 * Latencies key on these four kinds plus `publish` and `setup`, never on wire
 * message names: draft-20 unifies `request_ok` / `request_error` where earlier
 * drafts have a response per request type, so a metric keyed on message names
 * fragments across fifteen drafts and cannot be compared.
 *
 * Draft-20 §10 lists exactly seven messages that may open a request stream —
 * `subscribe`, `publish`, `fetch`, `track_status`, `publish_namespace`,
 * `subscribe_namespace`, `subscribe_tracks`
 * (`packages/codec/src/drafts/draft20/rules.ts`) — and the last three are all
 * namespace-scoped discovery, which draft-20 §6 groups together:
 * "SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS, PUBLISH and PUBLISH_NAMESPACE messages
 * provide an in-band means of discovery". They are the announce plane under its
 * draft-19/20 names.
 *
 * `request_ok` / `request_error` return `'other'` on purpose: the *response*
 * carries no exchange kind, so the kind comes from the pending map, which
 * recorded it when the request went out. A guess here would put a wrong kind on
 * half the latencies.
 *
 * Returns `undefined` when the value carries no `type` at all, which
 * distinguishes "not a decoded control message" from "a control message whose
 * exchange has no name of its own".
 */
export function exchangeKindOf(msg: AnyMessage): ExchangeKind | undefined {
  const type = msg.type
  if (typeof type !== 'string') return undefined
  return EXCHANGE_KINDS.get(type) ?? 'other'
}

const EXCHANGE_KINDS: ReadonlyMap<string, ExchangeKind> = new Map<string, ExchangeKind>([
  ['setup', 'setup'],
  ['client_setup', 'setup'],
  ['server_setup', 'setup'],

  ['subscribe', 'subscribe'],
  ['subscribe_ok', 'subscribe'],
  ['subscribe_error', 'subscribe'],
  ['subscribe_update', 'subscribe'],
  ['subscribe_done', 'subscribe'],
  ['unsubscribe', 'subscribe'],

  ['fetch', 'fetch'],
  ['fetch_ok', 'fetch'],
  ['fetch_error', 'fetch'],
  ['fetch_cancel', 'fetch'],

  ['publish', 'publish'],
  ['publish_ok', 'publish'],
  ['publish_error', 'publish'],
  ['publish_done', 'publish'],
  ['publish_state_notify', 'publish'],

  ['track_status', 'track-status'],
  ['track_status_request', 'track-status'],
  ['track_status_ok', 'track-status'],

  // The announce plane, under three generations of names. draft-19/20 spell
  // ANNOUNCE as PUBLISH_NAMESPACE and SUBSCRIBE_ANNOUNCES as
  // SUBSCRIBE_NAMESPACE; SUBSCRIBE_TRACKS and PUBLISH_SKIPPED are the same
  // exchange (draft-20 §6.1: PUBLISH_SKIPPED travels on the SUBSCRIBE_TRACKS response
  // stream).
  ['publish_namespace', 'announce'],
  ['publish_namespace_ok', 'announce'],
  ['publish_namespace_error', 'announce'],
  ['publish_namespace_done', 'announce'],
  ['publish_namespace_cancel', 'announce'],
  ['namespace', 'announce'],
  ['namespace_done', 'announce'],
  ['subscribe_namespace', 'announce'],
  ['subscribe_tracks', 'announce'],
  ['publish_skipped', 'announce'],
  ['announce', 'announce'],
  ['announce_ok', 'announce'],
  ['announce_error', 'announce'],
  ['announce_cancel', 'announce'],
  ['unannounce', 'announce'],
  ['subscribe_announces', 'announce'],
  ['subscribe_announces_ok', 'announce'],
  ['subscribe_announces_error', 'announce'],
  ['unsubscribe_announces', 'announce'],
])
