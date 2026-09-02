/**
 * @moqtap/codec — MoQT wire-format codec
 *
 * This is the root entry point. It re-exports shared types and the
 * `createCodec()` factory which requires an explicit draft version.
 *
 * For direct access to a specific draft, use subpath imports:
 *   import { createDraft17Codec } from '@moqtap/codec/draft17';
 *
 * A default (versionless) codec will be available once the MoQT
 * specification reaches RFC status. Until then, always specify a draft.
 */

import type { CodecOptions } from './core/types.js'
import type { Draft07Codec } from './drafts/draft07/codec.js'
import { createDraft07Codec } from './drafts/draft07/codec.js'
import type { Draft08Codec } from './drafts/draft08/codec.js'
import { createDraft08Codec } from './drafts/draft08/codec.js'
import type { Draft09Codec } from './drafts/draft09/codec.js'
import { createDraft09Codec } from './drafts/draft09/codec.js'
import type { Draft10Codec } from './drafts/draft10/codec.js'
import { createDraft10Codec } from './drafts/draft10/codec.js'
import type { Draft11Codec } from './drafts/draft11/codec.js'
import { createDraft11Codec } from './drafts/draft11/codec.js'
import type { Draft12Codec } from './drafts/draft12/codec.js'
import { createDraft12Codec } from './drafts/draft12/codec.js'
import type { Draft13Codec } from './drafts/draft13/codec.js'
import { createDraft13Codec } from './drafts/draft13/codec.js'
import type { Draft14Codec } from './drafts/draft14/codec.js'
import { createDraft14Codec } from './drafts/draft14/codec.js'
import type { Draft15Codec } from './drafts/draft15/codec.js'
import { createDraft15Codec } from './drafts/draft15/codec.js'
import type { Draft16Codec } from './drafts/draft16/codec.js'
import { createDraft16Codec } from './drafts/draft16/codec.js'
import type { Draft17Codec } from './drafts/draft17/codec.js'
import { createDraft17Codec } from './drafts/draft17/codec.js'
import type { Draft18Codec } from './drafts/draft18/codec.js'
import { createDraft18Codec } from './drafts/draft18/codec.js'
import type { Draft19Codec } from './drafts/draft19/codec.js'
import { createDraft19Codec } from './drafts/draft19/codec.js'
import type { Draft20Codec } from './drafts/draft20/codec.js'
import { createDraft20Codec } from './drafts/draft20/codec.js'

/**
 * Version identifiers for each MoQT draft, keyed by short aliases.
 *
 * Only the entries up to '14' are wire values: those drafts negotiated the
 * version inside CLIENT_SETUP/SERVER_SETUP and really do put `0xff0000NN` on
 * the wire. From draft-15 on, the version is negotiated by ALPN (raw QUIC) or
 * `WT-Available-Protocols` (WebTransport) as the string `moqt-NN`, and no
 * version number is sent at all — so '15' through '20' are *derived*
 * identifiers kept as stable numeric keys, not observed values. Do not report
 * one to a user as a version seen on the wire; report the protocol string.
 * Each draft's own module exports it (e.g. `PROTOCOL_STRING` in
 * `@moqtap/codec/draft20`).
 */
export const DRAFT_VERSIONS: Record<string, bigint> = {
  '07': 0xff000007n,
  '08': 0xff000008n,
  '09': 0xff000009n,
  '10': 0xff00000an,
  '11': 0xff00000bn,
  '12': 0xff00000cn,
  '13': 0xff00000dn,
  '14': 0xff00000en,
  '15': 0xff00000fn,
  '16': 0xff000010n,
  '17': 0xff000011n,
  '18': 0xff000012n,
  '19': 0xff000013n,
  '20': 0xff000014n,
}

export function createCodec(options: CodecOptions & { draft: '07' }): Draft07Codec
export function createCodec(options: CodecOptions & { draft: '08' }): Draft08Codec
export function createCodec(options: CodecOptions & { draft: '09' }): Draft09Codec
export function createCodec(options: CodecOptions & { draft: '10' }): Draft10Codec
export function createCodec(options: CodecOptions & { draft: '11' }): Draft11Codec
export function createCodec(options: CodecOptions & { draft: '12' }): Draft12Codec
export function createCodec(options: CodecOptions & { draft: '13' }): Draft13Codec
export function createCodec(options: CodecOptions & { draft: '14' }): Draft14Codec
export function createCodec(options: CodecOptions & { draft: '15' }): Draft15Codec
export function createCodec(options: CodecOptions & { draft: '16' }): Draft16Codec
export function createCodec(options: CodecOptions & { draft: '17' }): Draft17Codec
export function createCodec(options: CodecOptions & { draft: '18' }): Draft18Codec
export function createCodec(options: CodecOptions & { draft: '19' }): Draft19Codec
export function createCodec(options: CodecOptions & { draft: '20' }): Draft20Codec

/**
 * Create a codec for the specified draft version.
 *
 * A draft must always be specified — there is no default while the
 * MoQT specification is still in draft stage.
 */
export function createCodec(
  options: CodecOptions,
):
  | Draft07Codec
  | Draft08Codec
  | Draft09Codec
  | Draft10Codec
  | Draft11Codec
  | Draft12Codec
  | Draft13Codec
  | Draft14Codec
  | Draft15Codec
  | Draft16Codec
  | Draft17Codec
  | Draft18Codec
  | Draft19Codec
  | Draft20Codec
export function createCodec(
  options: CodecOptions,
):
  | Draft07Codec
  | Draft08Codec
  | Draft09Codec
  | Draft10Codec
  | Draft11Codec
  | Draft12Codec
  | Draft13Codec
  | Draft14Codec
  | Draft15Codec
  | Draft16Codec
  | Draft17Codec
  | Draft18Codec
  | Draft19Codec
  | Draft20Codec {
  const draft = DRAFT_VERSIONS[options.draft]
  if (!draft) {
    throw new Error(
      `Unsupported draft: "${options.draft}". ` +
        `Use a draft-scoped import instead.\n` +
        `Supported draft values: ${Object.keys(DRAFT_VERSIONS).join(', ')}`,
    )
  }

  switch (options.draft) {
    case '07':
      return createDraft07Codec()
    case '08':
      return createDraft08Codec()
    case '09':
      return createDraft09Codec()
    case '10':
      return createDraft10Codec()
    case '11':
      return createDraft11Codec()
    case '12':
      return createDraft12Codec()
    case '13':
      return createDraft13Codec()
    case '14':
      return createDraft14Codec()
    case '15':
      return createDraft15Codec()
    case '16':
      return createDraft16Codec()
    case '17':
      return createDraft17Codec()
    case '18':
      return createDraft18Codec()
    case '19':
      return createDraft19Codec()
    case '20':
      return createDraft20Codec()
    default:
      throw new Error(`Unsupported draft: ${draft}`)
  }
}

// Draft-agnostic readers for decoded messages
export type { AnyMessage, TrackIdentity } from './core/accessors.js'
export {
  joiningRequestIdOf,
  requestIdOf,
  trackAliasOf,
  trackOf,
} from './core/accessors.js'
export type {
  BaseCodec,
  CodecOptions,
  DecodeErrorCode,
  DecodeResult,
  Draft,
} from './core/types.js'
// Re-export shared types
export { DecodeError } from './core/types.js'
