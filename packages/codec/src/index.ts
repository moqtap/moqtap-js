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

/**
 * Wire version numbers for each MoQT draft, keyed by short aliases.
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
  | Draft17Codec {
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
    default:
      throw new Error(`Unsupported draft: ${draft}`)
  }
}

export type {
  BaseCodec,
  CodecOptions,
  DecodeErrorCode,
  DecodeResult,
  Draft,
} from './core/types.js'
// Re-export shared types
export { DecodeError } from './core/types.js'
