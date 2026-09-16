/**
 * The adapter body every draft shares.
 *
 * A {@link DraftAdapter} is three codec calls and six walk calls. The codec calls
 * differ only in *which* per-draft entry they came from, the walk calls only in
 * the {@link WalkDialect} they are handed, so the body is written once here and
 * each `draftNN/index.ts` supplies its codec binding and its dialect. Fourteen
 * copies would be fourteen places for a `try`/`catch` to go missing.
 *
 * **This file must never import `@moqtap/codec`.** The codec functions arrive as
 * arguments and the static string literal specifier stays in the per-draft
 * module, which is what keeps each draft's decoder in its own chunk: the root
 * `@moqtap/codec` entry statically imports all fourteen drafts at 39.6 KB gz
 * against 5.3 KB for one, and `tsup.config.ts` scans every source file at config
 * load to enforce it.
 *
 * Every method here is **total**. A throw would land in the page's own stack,
 * which this package promises never to do, so each codec call is wrapped and
 * each failure becomes a counted outcome rather than an exception.
 */

import type {
  ControlRedaction,
  DatagramCounts,
  DecodedControl,
  DraftAdapter,
  FetchHeaderInfo,
  Need,
  ObjectCursor,
  ObjectHeaderInfo,
  StreamKind,
  SubgroupHeaderInfo,
  SupportedDraft,
  VarintReader,
} from '../types.js'
import { asAnyMessage } from '../types.js'
import {
  type ControlDecodeResult,
  controlFrameEnd,
  controlFrameLength,
  readFetchHeader,
  readFetchObject,
  readSubgroupHeader,
  readSubgroupObject,
  sniffStream,
  type WalkDialect,
} from './data-walk.js'

/**
 * A decoded datagram, as the fourteen drafts spell it.
 *
 * The ids are stable across all fourteen. Two other fields are not, and both
 * differences are invisible until the wrong draft reports zeroes:
 *
 *  - **The status.** draft-07 calls it `status`; every draft from 08 on calls it
 *    `objectStatus`. Reading only one name silently loses every status datagram
 *    on the drafts using the other, and a missing status looks exactly like an
 *    ordinary object.
 *  - **The payload length.** Drafts 09 and 10 report no `payloadLength` field at
 *    all — their `DatagramObject` carries the payload and nothing else — so the
 *    length comes off the payload view. Where the field is stated it is used: a
 *    status datagram has length zero and zero payload bytes, and only the stated
 *    field distinguishes "empty" from "not reported".
 */
interface DecodedDatagram {
  readonly trackAlias: bigint
  readonly groupId: bigint
  readonly objectId: bigint
  readonly payloadLength?: number
  readonly payload?: { readonly byteLength: number }
  readonly objectStatus?: bigint
  readonly status?: bigint
}

type DatagramResult =
  | { readonly ok: true; readonly value: DecodedDatagram; readonly bytesRead: number }
  | { readonly ok: false }

/** The three codec functions an adapter needs, from one draft's entry. */
export interface CodecBinding {
  readonly decodeMessage: (frame: Uint8Array) => ControlDecodeResult
  readonly decodeDatagram: (bytes: Uint8Array) => DatagramResult
  readonly redactAuthTokens: (frame: Uint8Array) => ControlRedaction
}

export function makeAdapter(
  draft: SupportedDraft,
  protocolString: string,
  varint: VarintReader,
  d: WalkDialect,
  codec: CodecBinding,
): DraftAdapter {
  return {
    draft,
    protocolString,
    varint,

    decodeControl(frame: Uint8Array): DecodedControl {
      let res: ControlDecodeResult
      try {
        res = codec.decodeMessage(frame)
      } catch {
        // `decodeMessage` catches its own `DecodeError` and rethrows everything
        // else. A throw here would land in the page's stack, so it stops here.
        return { value: null, bytesRead: controlFrameLength(d, frame) }
      }
      if (res.ok) return { value: asAnyMessage(res.value), bytesRead: res.bytesRead }
      // An unknown or extension codepoint, or a malformed payload: counted and
      // skipped by the framer, never fatal.
      return { value: null, bytesRead: controlFrameLength(d, frame) }
    },

    /**
     * The token never enters our data structures.
     *
     * The codec walks the parameters once and hands back the frame with each
     * credential's bytes overwritten and nothing else changed — same length,
     * everything structural intact. The framer then decodes the *redacted*
     * frame, so even the decoded message cannot carry a token.
     *
     * On a throw the frame is reported as unredacted and undecoded, and the
     * framer drops its raw bytes rather than shipping bytes nobody vouched for.
     */
    redactAuthTokens(frame: Uint8Array): ControlRedaction {
      try {
        return codec.redactAuthTokens(frame)
      } catch {
        return { bytes: frame, redacted: 0, incomplete: true, decoded: false }
      }
    },

    decodeDatagram(bytes: Uint8Array): DatagramCounts | null {
      try {
        const res = codec.decodeDatagram(bytes)
        if (!res.ok) return null
        const v = res.value
        const payloadBytes = v.payloadLength ?? v.payload?.byteLength ?? 0
        const counts: DatagramCounts = {
          trackAlias: v.trackAlias,
          groupId: v.groupId,
          objectId: v.objectId,
          headerBytes: Math.max(0, res.bytesRead - payloadBytes),
          payloadBytes,
        }
        const status = v.objectStatus ?? v.status
        return status === undefined ? counts : { ...counts, status }
      } catch {
        return null
      }
    },

    sniff(firstByte: number): StreamKind {
      return sniffStream(d, firstByte)
    },

    controlFrameEnd(b: Uint8Array, i: number): number | Need {
      return controlFrameEnd(d, b, i)
    },

    readSubgroupHeader(b: Uint8Array, i: number): SubgroupHeaderInfo | Need {
      return readSubgroupHeader(d, b, i)
    },

    readSubgroupObject(
      b: Uint8Array,
      i: number,
      st: SubgroupHeaderInfo,
      prev: ObjectCursor,
    ): ObjectHeaderInfo | Need {
      return readSubgroupObject(d, b, i, st, prev)
    },

    readFetchHeader(b: Uint8Array, i: number): FetchHeaderInfo | Need {
      return readFetchHeader(d, b, i)
    },

    readFetchObject(b: Uint8Array, i: number, prev: ObjectCursor): ObjectHeaderInfo | Need {
      return readFetchObject(d, b, i, prev)
    },
  }
}
