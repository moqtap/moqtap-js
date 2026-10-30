/**
 * Where each MoQT draft defines the messages a problem is about, with the
 * sentence that defines them, so a tool can link and quote the rule.
 */

/** A section of a draft, pinned to its revision. */
export interface SpecRef {
  readonly draft: 'moqt'
  /** `'22'` */
  readonly revision: string
  /** `'9.4'` */
  readonly section: string
  /** The rule's BCP 14 keyword; `null` for a section that defines a message. */
  readonly keyword: 'MUST' | 'MUST NOT' | 'REQUIRED' | 'TYPE' | 'SHOULD' | 'SHOULD NOT' | null
  /** The sentence quoted from that section, verbatim apart from whitespace. */
  readonly quote: string
}

/** Definition sentences of the messages below, shared across drafts. */
const QUOTES = [
  'The server sends a GOAWAY message to initiate session migration (Section 3.6) with an optional URI.',
  'The subscriber sends an ANNOUNCE_ERROR control message for tracks that failed authorization.',
  'A publisher sends a SUBSCRIBE_ERROR control message in response to a failed SUBSCRIBE.',
  'A publisher sends a FETCH_ERROR control message in response to a failed FETCH.',
  'A publisher sends a MAX_SUBSCRIBE_ID message to increase the number of subscriptions a subscriber can create within a session.',
  'A publisher sends a SUBSCRIBE_ANNOUNCES_ERROR control message in response to a failed SUBSCRIBE_ANNOUNCES.',
  'An endpoint sends a GOAWAY message to inform the peer it intends to close the session soon.',
  'The SUBSCRIBES_BLOCKED message is sent when a subscriber would like to begin a new subscription, but cannot because the Subscribe ID would exceed the Maximum Subscribe ID value sent by the peer.',
  'An endpoint sends a MAX_REQUEST_ID message to increase the number of requests the peer can send within a session.',
  'The REQUESTS_BLOCKED message is sent when an endpoint would like to send a new request, but cannot because the Request ID would exceed the Maximum Request ID value sent by the peer.',
  'The subscriber sends an PUBLISH_ERROR control message to reject a subscription initiated by PUBLISH.',
  'The publisher sends a TRACK_STATUS_ERROR control message in response to a failed TRACK_STATUS message.',
  'A publisher sends a SUBSCRIBE_NAMESPACE_ERROR control message in response to a failed SUBSCRIBE_NAMESPACE.',
  'The subscriber sends a PUBLISH_ERROR control message to reject a subscription initiated by PUBLISH.',
  'The subscriber sends a PUBLISH_NAMESPACE_ERROR control message for tracks that failed authorization.',
  'The REQUEST_ERROR message is sent to a response to any request (SUBSCRIBE, FETCH, PUBLISH, SUBSCRIBE_NAMESPACE, PUBLISH_NAMESPACE, TRACK_STATUS).',
  'The REQUEST_ERROR message is sent to a response to any request (SUBSCRIBE, FETCH, PUBLISH, SUBSCRIBE_NAMESPACE, PUBLISH_NAMESPACE, TRACK_STATUS, REQUEST_UPDATE).',
  'An endpoint sends a GOAWAY message on its control stream to inform the peer it intends to close the session soon.',
  'The REQUEST_ERROR message is sent in response to any request (SUBSCRIBE, FETCH, PUBLISH, SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS, PUBLISH_NAMESPACE, TRACK_STATUS, REQUEST_UPDATE).',
]

/** Per draft: the section defining each message, and its quote's index in QUOTES. */
const SECTIONS: Record<number, Record<string, readonly [string, number]>> = {
  7: {
    GOAWAY: ['6.3', 0],
    ANNOUNCE_ERROR: ['6.10', 1],
    SUBSCRIBE_ERROR: ['6.16', 2],
    FETCH_ERROR: ['6.18', 3],
    MAX_SUBSCRIBE_ID: ['6.20', 4],
    SUBSCRIBE_ANNOUNCES_ERROR: ['6.25', 5],
  },
  8: {
    GOAWAY: ['7.3', 6],
    ANNOUNCE_ERROR: ['7.10', 1],
    SUBSCRIBE_ERROR: ['7.16', 2],
    FETCH_ERROR: ['7.18', 3],
    MAX_SUBSCRIBE_ID: ['7.20', 4],
    SUBSCRIBES_BLOCKED: ['7.21', 7],
    SUBSCRIBE_ANNOUNCES_ERROR: ['7.26', 5],
  },
  9: {
    GOAWAY: ['7.3', 6],
    ANNOUNCE_ERROR: ['7.10', 1],
    SUBSCRIBE_ERROR: ['7.16', 2],
    FETCH_ERROR: ['7.18', 3],
    MAX_SUBSCRIBE_ID: ['7.20', 4],
    SUBSCRIBES_BLOCKED: ['7.21', 7],
    SUBSCRIBE_ANNOUNCES_ERROR: ['7.26', 5],
  },
  10: {
    GOAWAY: ['8.3', 6],
    MAX_SUBSCRIBE_ID: ['8.4', 4],
    SUBSCRIBES_BLOCKED: ['8.5', 7],
    SUBSCRIBE_ERROR: ['8.8', 2],
    FETCH_ERROR: ['8.14', 3],
    ANNOUNCE_ERROR: ['8.20', 1],
    SUBSCRIBE_ANNOUNCES_ERROR: ['8.25', 5],
  },
  11: {
    GOAWAY: ['8.4', 6],
    MAX_REQUEST_ID: ['8.5', 8],
    REQUESTS_BLOCKED: ['8.6', 9],
    SUBSCRIBE_ERROR: ['8.9', 2],
    FETCH_ERROR: ['8.15', 3],
    ANNOUNCE_ERROR: ['8.21', 1],
    SUBSCRIBE_ANNOUNCES_ERROR: ['8.26', 5],
  },
  12: {
    GOAWAY: ['8.4', 6],
    MAX_REQUEST_ID: ['8.5', 8],
    REQUESTS_BLOCKED: ['8.6', 9],
    SUBSCRIBE_ERROR: ['8.9', 2],
    PUBLISH_ERROR: ['8.15', 10],
    FETCH_ERROR: ['8.18', 3],
    ANNOUNCE_ERROR: ['8.24', 1],
    SUBSCRIBE_ANNOUNCES_ERROR: ['8.29', 5],
  },
  13: {
    GOAWAY: ['8.4', 6],
    MAX_REQUEST_ID: ['8.5', 8],
    REQUESTS_BLOCKED: ['8.6', 9],
    SUBSCRIBE_ERROR: ['8.9', 2],
    PUBLISH_ERROR: ['8.15', 10],
    FETCH_ERROR: ['8.18', 3],
    TRACK_STATUS_ERROR: ['8.22', 11],
    ANNOUNCE_ERROR: ['8.25', 1],
    SUBSCRIBE_NAMESPACE_ERROR: ['8.30', 12],
  },
  14: {
    GOAWAY: ['9.4', 6],
    MAX_REQUEST_ID: ['9.5', 8],
    REQUESTS_BLOCKED: ['9.6', 9],
    SUBSCRIBE_ERROR: ['9.9', 2],
    PUBLISH_ERROR: ['9.15', 13],
    FETCH_ERROR: ['9.18', 3],
    TRACK_STATUS_ERROR: ['9.22', 11],
    PUBLISH_NAMESPACE_ERROR: ['9.25', 14],
    SUBSCRIBE_NAMESPACE_ERROR: ['9.30', 12],
  },
  15: {
    GOAWAY: ['9.4', 6],
    MAX_REQUEST_ID: ['9.5', 8],
    REQUESTS_BLOCKED: ['9.6', 9],
    REQUEST_ERROR: ['9.8', 15],
  },
  16: {
    GOAWAY: ['9.4', 6],
    MAX_REQUEST_ID: ['9.5', 8],
    REQUESTS_BLOCKED: ['9.6', 9],
    REQUEST_ERROR: ['9.8', 15],
  },
  17: { GOAWAY: ['9.5', 6], REQUEST_ERROR: ['9.7', 16] },
  18: { GOAWAY: ['10.4', 17], REQUEST_ERROR: ['10.6', 18] },
  19: { GOAWAY: ['10.4', 17], REQUEST_ERROR: ['10.6', 18] },
  20: { GOAWAY: ['10.4', 17], REQUEST_ERROR: ['10.6', 18] },
  21: { GOAWAY: ['9.2', 17], REQUEST_ERROR: ['9.4', 18] },
  22: { GOAWAY: ['9.2', 17], REQUEST_ERROR: ['9.4', 18] },
}

/** The section of `draft` defining `message` (either case), or `null` when it defines none. */
export function messageSpec(draft: number | null | undefined, message: string): SpecRef | null {
  if (draft === null || draft === undefined) return null
  const entry = SECTIONS[draft]?.[message.toUpperCase()]
  if (entry === undefined) return null
  return {
    draft: 'moqt',
    revision: String(draft).padStart(2, '0'),
    section: entry[0],
    keyword: null,
    quote: QUOTES[entry[1]]!,
  }
}

/** `https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-22#section-9.4` */
export function specUrl(ref: Pick<SpecRef, 'revision' | 'section'>): string {
  return `https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-${ref.revision}#section-${ref.section}`
}
