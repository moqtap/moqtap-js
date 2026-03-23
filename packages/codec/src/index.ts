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
import type { Draft08Codec } from "./drafts/draft08/codec.js";
import { createDraft08Codec } from "./drafts/draft08/codec.js";
import type { Draft09Codec } from "./drafts/draft09/codec.js";
import { createDraft09Codec } from "./drafts/draft09/codec.js";
import type { Draft10Codec } from "./drafts/draft10/codec.js";
import { createDraft10Codec } from "./drafts/draft10/codec.js";
import type { Draft11Codec } from "./drafts/draft11/codec.js";
import { createDraft11Codec } from "./drafts/draft11/codec.js";
import type { Draft12Codec } from "./drafts/draft12/codec.js";
import { createDraft12Codec } from "./drafts/draft12/codec.js";
import type { Draft13Codec } from "./drafts/draft13/codec.js";
import { createDraft13Codec } from "./drafts/draft13/codec.js";
import type { Draft14Codec } from "./drafts/draft14/codec.js";
import { createDraft14Codec } from "./drafts/draft14/codec.js";
import type { Draft15Codec } from "./drafts/draft15/codec.js";
import { createDraft15Codec } from "./drafts/draft15/codec.js";
import type { Draft16Codec } from "./drafts/draft16/codec.js";
import { createDraft16Codec } from "./drafts/draft16/codec.js";
import type { Draft17Codec } from "./drafts/draft17/codec.js";
import { createDraft17Codec } from "./drafts/draft17/codec.js";

const DRAFT_ALIASES: Record<string, Draft> = {
  "07": "draft-ietf-moq-transport-07",
  "draft-ietf-moq-transport-07": "draft-ietf-moq-transport-07",
  "08": "draft-ietf-moq-transport-08",
  "draft-ietf-moq-transport-08": "draft-ietf-moq-transport-08",
  "09": "draft-ietf-moq-transport-09",
  "draft-ietf-moq-transport-09": "draft-ietf-moq-transport-09",
  "10": "draft-ietf-moq-transport-10",
  "draft-ietf-moq-transport-10": "draft-ietf-moq-transport-10",
  "11": "draft-ietf-moq-transport-11",
  "draft-ietf-moq-transport-11": "draft-ietf-moq-transport-11",
  "12": "draft-ietf-moq-transport-12",
  "draft-ietf-moq-transport-12": "draft-ietf-moq-transport-12",
  "13": "draft-ietf-moq-transport-13",
  "draft-ietf-moq-transport-13": "draft-ietf-moq-transport-13",
  "14": "draft-ietf-moq-transport-14",
  "draft-ietf-moq-transport-14": "draft-ietf-moq-transport-14",
  "15": "draft-ietf-moq-transport-15",
  "draft-ietf-moq-transport-15": "draft-ietf-moq-transport-15",
  "16": "draft-ietf-moq-transport-16",
  "draft-ietf-moq-transport-16": "draft-ietf-moq-transport-16",
  "17": "draft-ietf-moq-transport-17",
  "draft-ietf-moq-transport-17": "draft-ietf-moq-transport-17",
};

/**
 * Create a codec for draft-07 (returns full Codec with stream decoder).
 */
export function createCodec(
  options: CodecOptions & { draft: "draft-ietf-moq-transport-07" | "07" },
): Codec;
export function createCodec(
  options: CodecOptions & { draft: "draft-ietf-moq-transport-08" | "08" },
): Draft08Codec;
export function createCodec(
  options: CodecOptions & { draft: "draft-ietf-moq-transport-09" | "09" },
): Draft09Codec;
export function createCodec(
  options: CodecOptions & { draft: "draft-ietf-moq-transport-10" | "10" },
): Draft10Codec;
/**
 * Create a codec for draft-11 (returns Draft11Codec with data stream support).
 */
export function createCodec(
  options: CodecOptions & { draft: "draft-ietf-moq-transport-11" | "11" },
): Draft11Codec;
/**
 * Create a codec for draft-12 (returns Draft12Codec with data stream support).
 */
export function createCodec(
  options: CodecOptions & { draft: "draft-ietf-moq-transport-12" | "12" },
): Draft12Codec;
/**
 * Create a codec for draft-13 (returns Draft13Codec with data stream support).
 */
export function createCodec(
  options: CodecOptions & { draft: "draft-ietf-moq-transport-13" | "13" },
): Draft13Codec;
/**
 * Create a codec for draft-14 (returns Draft14Codec with data stream support).
 */
export function createCodec(
  options: CodecOptions & { draft: "draft-ietf-moq-transport-14" | "14" },
): Draft14Codec;
/**
 * Create a codec for draft-15 (returns Draft15Codec with data stream support).
 */
export function createCodec(
  options: CodecOptions & { draft: "draft-ietf-moq-transport-15" | "15" },
): Draft15Codec;
/**
 * Create a codec for draft-16 (returns Draft16Codec with data stream support).
 */
export function createCodec(
  options: CodecOptions & { draft: "draft-ietf-moq-transport-16" | "16" },
): Draft16Codec;
/**
 * Create a codec for draft-17 (returns Draft17Codec with data stream support).
 */
export function createCodec(
  options: CodecOptions & { draft: "draft-ietf-moq-transport-17" | "17" },
): Draft17Codec;
/**
 * Create a codec for the specified draft version.
 *
 * A draft must always be specified — there is no default while the
 * MoQT specification is still in draft stage.
 */
export function createCodec(
  options: CodecOptions,
):
  | Codec
  | Draft08Codec
  | Draft09Codec
  | Draft10Codec
  | Draft11Codec
  | Draft12Codec
  | Draft13Codec
  | Draft14Codec
  | Draft15Codec
  | Draft16Codec
  | Draft17Codec;
export function createCodec(
  options: CodecOptions,
):
  | Codec
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
  const draft = DRAFT_ALIASES[options.draft];
  if (!draft) {
    throw new Error(
      `Unsupported draft: "${options.draft}". ` +
        `Use a draft-scoped import instead:\n` +
        `  import { createDraft07Codec } from '@moqtap/codec/draft7'\n` +
        `  import { createDraft08Codec } from '@moqtap/codec/draft8'\n` +
        `  import { createDraft09Codec } from '@moqtap/codec/draft9'\n` +
        `  import { createDraft10Codec } from '@moqtap/codec/draft10'\n` +
        `  import { createDraft11Codec } from '@moqtap/codec/draft11'\n` +
        `  import { createDraft12Codec } from '@moqtap/codec/draft12'\n` +
        `  import { createDraft13Codec } from '@moqtap/codec/draft13'\n` +
        `  import { createDraft14Codec } from '@moqtap/codec/draft14'\n` +
        `  import { createDraft15Codec } from '@moqtap/codec/draft15'\n` +
        `  import { createDraft16Codec } from '@moqtap/codec/draft16'\n` +
        `  import { createDraft17Codec } from '@moqtap/codec/draft17'\n` +
        `Supported draft values: ${Object.keys(DRAFT_ALIASES).join(", ")}`,
    );
  }

  switch (draft) {
    case "draft-ietf-moq-transport-07":
      return createDraft07Codec();
    case "draft-ietf-moq-transport-08":
      return createDraft08Codec();
    case "draft-ietf-moq-transport-09":
      return createDraft09Codec();
    case "draft-ietf-moq-transport-10":
      return createDraft10Codec();
    case "draft-ietf-moq-transport-11":
      return createDraft11Codec();
    case "draft-ietf-moq-transport-12":
      return createDraft12Codec();
    case "draft-ietf-moq-transport-13":
      return createDraft13Codec();
    case "draft-ietf-moq-transport-14":
      return createDraft14Codec();
    case "draft-ietf-moq-transport-15":
      return createDraft15Codec();
    case "draft-ietf-moq-transport-16":
      return createDraft16Codec();
    case "draft-ietf-moq-transport-17":
      return createDraft17Codec();
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

// Re-export draft-08 types
export type { Draft08Codec } from "./drafts/draft08/codec.js";
export type {
  Draft08DataStream,
  Draft08Message,
  Draft08Params,
  Draft08SetupParams,
} from "./drafts/draft08/types.js";

// Re-export draft-09 types
export type { Draft09Codec } from "./drafts/draft09/codec.js";
export type {
  Draft09DataStream,
  Draft09Message,
  Draft09Params,
  Draft09SetupParams,
} from "./drafts/draft09/types.js";

// Re-export draft-10 types
export type { Draft10Codec } from "./drafts/draft10/codec.js";
export type {
  Draft10DataStream,
  Draft10Message,
  Draft10Params,
  Draft10SetupParams,
} from "./drafts/draft10/types.js";

// Re-export draft-11 types
export type { Draft11Codec } from "./drafts/draft11/codec.js";
export type {
  Draft11DataStream,
  Draft11Message,
  Draft11Params,
  Draft11SetupParams,
} from "./drafts/draft11/types.js";

// Re-export draft-12 types
export type { Draft12Codec } from "./drafts/draft12/codec.js";
export type {
  Draft12DataStream,
  Draft12Message,
  Draft12Params,
  Draft12SetupParams,
} from "./drafts/draft12/types.js";

// Re-export draft-13 types
export type { Draft13Codec } from "./drafts/draft13/codec.js";
export type {
  Draft13DataStream,
  Draft13Message,
  Draft13Params,
  Draft13SetupParams,
} from "./drafts/draft13/types.js";

// Re-export draft-14 types
export type { Draft14Codec } from "./drafts/draft14/codec.js";
export type {
  Draft14DataStream,
  Draft14Message,
  Draft14Params,
} from "./drafts/draft14/types.js";

// Re-export draft-15 types
export type { Draft15Codec } from "./drafts/draft15/codec.js";
export type {
  Draft15DataStream,
  Draft15Message,
  Draft15Params,
  Draft15SetupParams,
} from "./drafts/draft15/types.js";

// Re-export draft-16 types
export type { Draft16Codec } from "./drafts/draft16/codec.js";
export type {
  Draft16DataStream,
  Draft16Message,
  Draft16Params,
  Draft16SetupParams,
} from "./drafts/draft16/types.js";

// Re-export draft-17 types
export type { Draft17Codec } from "./drafts/draft17/codec.js";
export type {
  Draft17DataStream,
  Draft17Message,
  Draft17Params,
  Draft17SetupOptions,
} from "./drafts/draft17/types.js";
