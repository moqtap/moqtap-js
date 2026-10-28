/**
 * Every draft's data streams, through the dispatcher a live session runs.
 *
 * `walk-corpus.test.ts` holds each draft's adapter walk to the corpus. A live
 * session does not call those walks directly: its counters use a faster walk
 * for the drafts that walk reads correctly and the adapter's for the rest, and
 * that choice is the thing that can be wrong here. So every corpus vector goes
 * through a real {@link StreamDispatcher}, and each counted object is checked
 * against the corpus, together with the priority and subgroup an `hdr` record
 * would carry for it.
 *
 * End-of-Range markers are walked and not counted, so they are left out of
 * what is expected.
 */

import { describe, expect, it } from 'vitest'
import { StreamDispatcher } from '../../decode/dispatch.js'
import { TrackKeys } from '../../decode/track-key.js'
import { SUPPORTED_DRAFTS } from '../../draft/protocol.js'
import type {
  BucketKey,
  ControlFrameEvent,
  CountingSink,
  ObjectSample,
  ParseFailureReason,
} from '../../types.js'
import {
  adapterFor,
  big,
  expectedHeader,
  expectedObjects,
  hexToBytes,
  loadVectors,
  num,
  pad,
} from './corpus.js'

interface Seen {
  readonly groupId: bigint
  readonly objectId: bigint
  readonly payloadLength: number
  readonly status: bigint | undefined
  readonly priority: number
  readonly subgroupId: bigint | null
}

/** Counts through a dispatcher and reads each object's fields while it is reported. */
function run(
  draft: (typeof SUPPORTED_DRAFTS)[number],
  feed: (d: StreamDispatcher) => void,
): { seen: Seen[]; failures: ParseFailureReason[] } {
  const seen: Seen[] = []
  const failures: ParseFailureReason[] = []
  let d: StreamDispatcher | null = null
  const sink: CountingSink = {
    onObject(s: ObjectSample): void {
      const f = d?.fieldsOf(s) ?? null
      seen.push({
        groupId: s.groupId,
        objectId: s.objectId,
        payloadLength: s.payloadBytes,
        status: s.status,
        priority: f === null ? -2 : f.priority,
        subgroupId: f === null ? -2n : f.subgroupId,
      })
    },
    onControlFrame(_e: ControlFrameEvent): void {},
    onParseFailure(_k: BucketKey | null, r: ParseFailureReason): void {
      failures.push(r)
    },
  }
  d = new StreamDispatcher(adapterFor(draft), new TrackKeys(), sink)
  feed(d)
  return { seen, failures }
}

function stream(bytes: Uint8Array) {
  return (d: StreamDispatcher): void => {
    // Split, so the walk also crosses chunk boundaries mid-header.
    for (let i = 0; i < bytes.length; i += 3) {
      d.onStreamData({
        sessionId: 's',
        streamId: 2,
        direction: 'rx',
        bidi: false,
        control: false,
        data: bytes.subarray(i, i + 3),
        at: i,
      })
    }
    d.onStreamClose(2)
  }
}

describe.each(
  SUPPORTED_DRAFTS.map((d) => ({ draft: d, name: `draft-${pad(d)}` })),
)('$name, live', ({ draft }) => {
  for (const v of loadVectors(draft, 'subgroup')) {
    const b = hexToBytes(v.hex)
    // A Type Flags field in a non-minimal encoding sniffs as no stream type at
    // all, which the dispatcher counts as an unknown stream; the walk test
    // covers how such a header reads once known.
    if ((b[0] as number) >= 0x80) continue
    it(`counts subgroup ${v.id}`, () => {
      const decoded = v.decoded as Record<string, unknown>
      const want = expectedObjects(decoded, expectedHeader(decoded))
      const { seen, failures } = run(draft, stream(b))
      expect(failures).toEqual([])
      expect(seen).toEqual(
        want.map((w) => ({
          groupId: w.groupId,
          objectId: w.objectId,
          payloadLength: w.payloadLength,
          status: w.status,
          priority: w.priority,
          subgroupId: w.subgroupId,
        })),
      )
    })
  }

  for (const v of loadVectors(draft, 'fetch-header')) {
    it(`counts fetch ${v.id}`, () => {
      const decoded = v.decoded as Record<string, unknown>
      const want = expectedObjects(decoded).filter((w) => !w.marker)
      const { seen, failures } = run(draft, stream(hexToBytes(v.hex)))
      expect(failures).toEqual([])
      expect(seen).toEqual(
        want.map((w) => ({
          groupId: w.groupId,
          objectId: w.objectId,
          payloadLength: w.payloadLength,
          status: w.status,
          priority: w.priority,
          subgroupId: w.subgroupId,
        })),
      )
    })
  }

  for (const v of loadVectors(draft, 'datagram')) {
    it(`counts datagram ${v.id}`, () => {
      const decoded = v.decoded as Record<string, unknown>
      const b = hexToBytes(v.hex)
      const { seen } = run(draft, (d) =>
        d.onDatagram({ sessionId: 's', direction: 'rx', data: b, at: 0 }),
      )
      expect(seen).toHaveLength(1)
      expect(seen[0]?.groupId).toBe(big(decoded.group_id))
      expect(seen[0]?.priority).toBe(num(decoded.publisher_priority) ?? -1)
      expect(seen[0]?.subgroupId).toBeNull()
    })
  }
})
