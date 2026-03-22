/**
 * @moqtap/codec — MoQT wire-format codec
 *
 * This is the root entry point. It re-exports shared types and the
 * `createCodec()` factory which requires an explicit draft version.
 *
 * For direct access to a specific draft, use subpath imports:
 *   import { createDraft07Codec } from '@moqtap/codec/draft7';
 *   import { createDraft14Codec } from '@moqtap/codec/draft14';
 *
 * A default (versionless) codec will be available once the MoQT
 * specification reaches RFC status. Until then, always specify a draft.
 */

import type { Codec, CodecOptions, Draft } from "./core/types.js";
import { createDraft07Codec } from "./drafts/draft07/codec.js";
import type { Draft14Codec } from "./drafts/draft14/codec.js";
import { createDraft14Codec } from "./drafts/draft14/codec.js";

const DRAFT_ALIASES: Record<string, Draft> = {
  "07": "draft-ietf-moq-transport-07",
  "draft-ietf-moq-transport-07": "draft-ietf-moq-transport-07",
  "14": "draft-ietf-moq-transport-14",
  "draft-ietf-moq-transport-14": "draft-ietf-moq-transport-14",
};

/**
 * Create a codec for draft-07 (returns full Codec with stream decoder).
 */
export function createCodec(
  options: CodecOptions & { draft: "draft-ietf-moq-transport-07" | "07" },
): Codec;
/**
 * Create a codec for draft-14 (returns Draft14Codec with data stream support).
 */
export function createCodec(
  options: CodecOptions & { draft: "draft-ietf-moq-transport-14" | "14" },
): Draft14Codec;
/**
 * Create a codec for the specified draft version.
 *
 * A draft must always be specified — there is no default while the
 * MoQT specification is still in draft stage.
 */
export function createCodec(options: CodecOptions): Codec | Draft14Codec;
export function createCodec(options: CodecOptions): Codec | Draft14Codec {
  const draft = DRAFT_ALIASES[options.draft];
  if (!draft) {
    throw new Error(
      `Unsupported draft: "${options.draft}". ` +
        `Use a draft-scoped import instead:\n` +
        `  import { createDraft07Codec } from '@moqtap/codec/draft7'\n` +
        `  import { createDraft14Codec } from '@moqtap/codec/draft14'\n` +
        `Supported draft values: ${Object.keys(DRAFT_ALIASES).join(", ")}`,
    );
  }

  switch (draft) {
    case "draft-ietf-moq-transport-07":
      return createDraft07Codec();
    case "draft-ietf-moq-transport-14":
      return createDraft14Codec();
    default:
      throw new Error(`Unsupported draft: ${draft}`);
  }
}

// Re-export shared types
export type {
  Announce,
  AnnounceCancel,
  AnnounceError,
  AnnounceOk,
  BaseCodec,
  ClientSetup,
  Codec,
  CodecOptions,
  DecodeErrorCode,
  DecodeResult,
  Draft,
  DraftShorthand,
  Fetch,
  FetchCancel,
  FetchError,
  FetchOk,
  FilterType,
  GoAway,
  GroupOrderValue,
  MaxSubscribeId,
  MoqtMessage,
  MoqtMessageType,
  ObjectDatagram,
  ObjectStream,
  ServerSetup,
  StreamHeaderGroup,
  StreamHeaderSubgroup,
  StreamHeaderTrack,
  Subscribe,
  SubscribeAnnounces,
  SubscribeAnnouncesError,
  SubscribeAnnouncesOk,
  SubscribeDone,
  SubscribeError,
  SubscribeOk,
  SubscribeUpdate,
  TrackStatus,
  TrackStatusRequest,
  Unannounce,
  Unsubscribe,
  UnsubscribeAnnounces,
} from "./core/types.js";
export { DecodeError } from "./core/types.js";

// Re-export draft-14 types
export type { Draft14Codec } from "./drafts/draft14/codec.js";
export type {
  Draft14DataStream,
  Draft14Message,
  Draft14Params,
} from "./drafts/draft14/types.js";
