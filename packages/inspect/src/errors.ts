/**
 * Error and status codes by name, from the codec's registries for one draft.
 *
 * A code means nothing without its draft: SUBSCRIBE_ERROR 0x4 is
 * UNAUTHORIZED on draft-07 and TRACK_DOES_NOT_EXIST on draft-14, and the
 * registries were renumbered and merged more than once after that. So a code
 * is looked up in the named draft's table only, and a code that table does not
 * hold has no name. Borrowing a name from a neighbouring draft is how a wrong
 * diagnosis gets made with confidence.
 */

import {
  SessionErrorCode as Session07,
  SubscribeDoneStatusCode as SubscribeDone07,
  SubscribeErrorCode as SubscribeError07,
  TrackStatusCode as TrackStatus07,
} from '@moqtap/codec/draft07'
import {
  AnnounceErrorCode as AnnounceError08,
  FetchErrorCode as FetchError08,
  SessionErrorCode as Session08,
  SubscribeAnnouncesErrorCode as SubscribeAnnouncesError08,
  SubscribeDoneStatusCode as SubscribeDone08,
  SubscribeErrorCode as SubscribeError08,
  TrackStatusCode as TrackStatus08,
} from '@moqtap/codec/draft08'
import {
  AnnounceErrorCode as AnnounceError09,
  FetchErrorCode as FetchError09,
  SessionErrorCode as Session09,
  SubscribeAnnouncesErrorCode as SubscribeAnnouncesError09,
  SubscribeDoneStatusCode as SubscribeDone09,
  SubscribeErrorCode as SubscribeError09,
  TrackStatusCode as TrackStatus09,
} from '@moqtap/codec/draft09'
import {
  AnnounceErrorCode as AnnounceError10,
  FetchErrorCode as FetchError10,
  SessionErrorCode as Session10,
  SubscribeAnnouncesErrorCode as SubscribeAnnouncesError10,
  SubscribeDoneStatusCode as SubscribeDone10,
  SubscribeErrorCode as SubscribeError10,
  TrackStatusCode as TrackStatus10,
} from '@moqtap/codec/draft10'
import {
  AnnounceErrorCode as AnnounceError11,
  FetchErrorCode as FetchError11,
  SessionErrorCode as Session11,
  StreamResetErrorCode as StreamReset11,
  SubscribeAnnouncesErrorCode as SubscribeAnnouncesError11,
  SubscribeDoneStatusCode as SubscribeDone11,
  SubscribeErrorCode as SubscribeError11,
  TrackStatusCode as TrackStatus11,
} from '@moqtap/codec/draft11'
import {
  AnnounceErrorCode as AnnounceError12,
  FetchErrorCode as FetchError12,
  PublishErrorCode as PublishError12,
  SessionErrorCode as Session12,
  StreamResetErrorCode as StreamReset12,
  SubscribeAnnouncesErrorCode as SubscribeAnnouncesError12,
  SubscribeDoneStatusCode as SubscribeDone12,
  SubscribeErrorCode as SubscribeError12,
  TrackStatusCode as TrackStatus12,
} from '@moqtap/codec/draft12'
import {
  AnnounceErrorCode as AnnounceError13,
  FetchErrorCode as FetchError13,
  PublishErrorCode as PublishError13,
  SessionErrorCode as Session13,
  StreamResetErrorCode as StreamReset13,
  SubscribeDoneStatusCode as SubscribeDone13,
  SubscribeErrorCode as SubscribeError13,
  SubscribeNamespaceErrorCode as SubscribeNamespaceError13,
} from '@moqtap/codec/draft13'
import {
  AnnounceErrorCode as AnnounceError14,
  DataStreamResetErrorCode as DataStreamReset14,
  FetchErrorCode as FetchError14,
  PublishDoneStatusCode as PublishDone14,
  PublishErrorCode as PublishError14,
  SessionErrorCode as Session14,
  SubscribeErrorCode as SubscribeError14,
  SubscribeNamespaceErrorCode as SubscribeNamespaceError14,
} from '@moqtap/codec/draft14'
import {
  DataStreamResetErrorCode as DataStreamReset15,
  PublishDoneStatusCode as PublishDone15,
  RequestErrorCode as RequestError15,
  SessionErrorCode as Session15,
} from '@moqtap/codec/draft15'
import {
  DataStreamResetErrorCode as DataStreamReset16,
  PublishDoneStatusCode as PublishDone16,
  RequestErrorCode as RequestError16,
  SessionErrorCode as Session16,
} from '@moqtap/codec/draft16'
import {
  DataStreamResetCode as DataStreamReset17,
  PublishDoneCode as PublishDone17,
  RequestErrorCode as RequestError17,
  SessionTerminationCode as Session17,
} from '@moqtap/codec/draft17'
import {
  DataStreamResetCode as DataStreamReset18,
  PublishDoneCode as PublishDone18,
  RequestErrorCode as RequestError18,
  SessionTerminationCode as Session18,
} from '@moqtap/codec/draft18'
import {
  DataStreamResetCode as DataStreamReset19,
  PublishDoneCode as PublishDone19,
  RequestErrorCode as RequestError19,
  SessionTerminationCode as Session19,
} from '@moqtap/codec/draft19'
import {
  DataStreamResetCode as DataStreamReset20,
  PublishDoneCode as PublishDone20,
  RequestErrorCode as RequestError20,
  SessionTerminationCode as Session20,
} from '@moqtap/codec/draft20'
import {
  DataStreamResetCode as DataStreamReset21,
  PublishDoneCode as PublishDone21,
  RequestErrorCode as RequestError21,
  SessionTerminationCode as Session21,
} from '@moqtap/codec/draft21'
import {
  DataStreamResetCode as DataStreamReset22,
  PublishDoneCode as PublishDone22,
  RequestErrorCode as RequestError22,
  SessionTerminationCode as Session22,
} from '@moqtap/codec/draft22'

type Registry = Readonly<Record<string, bigint>>

/**
 * The registry each message's code is drawn from, by message name, per draft.
 *
 * Two names are not messages: `session` is the code a session closes with
 * and `stream_reset` the code a data stream is reset with. Messages that carry
 * a code with no registry in the codec (TRACK_STATUS_ERROR on drafts 13 and
 * 14, the *_CANCEL messages) are left out, so their codes have no name.
 */
const REGISTRIES: Readonly<Record<number, Readonly<Record<string, Registry>>>> = {
  7: {
    session: Session07,
    subscribe_error: SubscribeError07,
    subscribe_done: SubscribeDone07,
    track_status: TrackStatus07,
  },
  8: {
    session: Session08,
    subscribe_error: SubscribeError08,
    subscribe_done: SubscribeDone08,
    track_status: TrackStatus08,
    announce_error: AnnounceError08,
    fetch_error: FetchError08,
    subscribe_announces_error: SubscribeAnnouncesError08,
  },
  9: {
    session: Session09,
    subscribe_error: SubscribeError09,
    subscribe_done: SubscribeDone09,
    track_status: TrackStatus09,
    announce_error: AnnounceError09,
    fetch_error: FetchError09,
    subscribe_announces_error: SubscribeAnnouncesError09,
  },
  10: {
    session: Session10,
    subscribe_error: SubscribeError10,
    subscribe_done: SubscribeDone10,
    track_status: TrackStatus10,
    announce_error: AnnounceError10,
    fetch_error: FetchError10,
    subscribe_announces_error: SubscribeAnnouncesError10,
  },
  11: {
    session: Session11,
    stream_reset: StreamReset11,
    subscribe_error: SubscribeError11,
    subscribe_done: SubscribeDone11,
    track_status: TrackStatus11,
    announce_error: AnnounceError11,
    fetch_error: FetchError11,
    subscribe_announces_error: SubscribeAnnouncesError11,
  },
  12: {
    session: Session12,
    stream_reset: StreamReset12,
    subscribe_error: SubscribeError12,
    subscribe_done: SubscribeDone12,
    track_status: TrackStatus12,
    announce_error: AnnounceError12,
    fetch_error: FetchError12,
    publish_error: PublishError12,
    subscribe_announces_error: SubscribeAnnouncesError12,
  },
  13: {
    session: Session13,
    stream_reset: StreamReset13,
    subscribe_error: SubscribeError13,
    subscribe_done: SubscribeDone13,
    announce_error: AnnounceError13,
    fetch_error: FetchError13,
    publish_error: PublishError13,
    subscribe_namespace_error: SubscribeNamespaceError13,
  },
  14: {
    session: Session14,
    stream_reset: DataStreamReset14,
    subscribe_error: SubscribeError14,
    publish_done: PublishDone14,
    publish_error: PublishError14,
    fetch_error: FetchError14,
    publish_namespace_error: AnnounceError14,
    subscribe_namespace_error: SubscribeNamespaceError14,
  },
  15: {
    session: Session15,
    stream_reset: DataStreamReset15,
    request_error: RequestError15,
    publish_done: PublishDone15,
  },
  16: {
    session: Session16,
    stream_reset: DataStreamReset16,
    request_error: RequestError16,
    publish_done: PublishDone16,
  },
  17: {
    session: Session17,
    stream_reset: DataStreamReset17,
    request_error: RequestError17,
    publish_done: PublishDone17,
  },
  18: {
    session: Session18,
    stream_reset: DataStreamReset18,
    request_error: RequestError18,
    publish_done: PublishDone18,
  },
  19: {
    session: Session19,
    stream_reset: DataStreamReset19,
    request_error: RequestError19,
    publish_done: PublishDone19,
  },
  20: {
    session: Session20,
    stream_reset: DataStreamReset20,
    request_error: RequestError20,
    publish_done: PublishDone20,
  },
  21: {
    session: Session21,
    stream_reset: DataStreamReset21,
    request_error: RequestError21,
    publish_done: PublishDone21,
  },
  22: {
    session: Session22,
    stream_reset: DataStreamReset22,
    request_error: RequestError22,
    publish_done: PublishDone22,
  },
}

/** `TrackDoesNotExist` as the drafts write it: `TRACK_DOES_NOT_EXIST`. */
function specName(key: string): string {
  return key.replace(/(?<=[a-z0-9])(?=[A-Z])/g, '_').toUpperCase()
}

/**
 * The name `draft` gives `code` in `messageName`'s registry, such as
 * `TRACK_DOES_NOT_EXIST`, or `null` when that draft has no name for it.
 *
 * `messageName` is the message carrying the code, in either case:
 * `SUBSCRIBE_ERROR`, `REQUEST_ERROR`, `PUBLISH_DONE` and the like. `session`
 * names the code a session closed with and `stream_reset` a data stream's
 * reset code. A `null` draft, a draft the codec does not carry, a message with
 * no registry in that draft and a code its registry does not hold all answer
 * `null`.
 */
export function errorName(
  draft: number | null,
  messageName: string,
  code: number | bigint,
): string | null {
  if (draft === null) return null
  const registry = REGISTRIES[draft]?.[messageName.toLowerCase()]
  if (registry === undefined) return null
  if (typeof code === 'number' && !Number.isSafeInteger(code)) return null
  const wanted = BigInt(code)
  for (const [key, value] of Object.entries(registry)) {
    if (value === wanted) return specName(key)
  }
  return null
}
