/**
 * A realm's triggers watch only tracks somebody is still waiting on.
 *
 * Every track that goes quiet for good — those of a closed connection above
 * all — would otherwise open a capture window that counts toward recording
 * minutes on the next tick, with no connection left to dump. Driven through
 * the realm's own observer, so the liveness the trigger engine reads is the one
 * the realm actually supplies.
 */

import { describe, expect, it } from 'vitest'
import { buildOf } from '../../api/compose.js'
import { resolveConfig } from '../../api/config.js'
import { RealmObserver } from '../../api/realm.js'
import { draft20 } from '../../drafts/draft20/decoder.js'
import { flightRecorder } from '../../features/flight-recorder.js'
import type { TriggerEvent } from '../../recorder/index.js'
import type { ClockSource, EnvelopeRecord, Mono } from '../../types.js'
import { publishBytes, subgroupBytes } from '../decode/vectors.js'

const SESSION = 's1'
const EVERY_MS = 40

interface Rig {
  readonly realm: RealmObserver
  readonly triggers: TriggerEvent[]
  /** The peer PUBLISHes track alias 1 on its own request stream. */
  publish(at: Mono): void
  /** One object per group on track alias 1, every {@link EVERY_MS}, `from` to `to`. */
  flow(from: Mono, to: Mono): void
}

function rig(): Rig {
  const build = buildOf({ drafts: [draft20], features: [flightRecorder] })
  const config = resolveConfig({
    apiKey: 'pk_test',
    endpoint: 'https://ingest.test/v1/ingest',
    sessionId: 'sess-stale',
    flightRecorder: { triggers: { stall: { afterMs: 500 } } },
  })
  const clock: ClockSource = { now: () => 0, wall: () => 1_700_000_000_000 }
  const triggers: TriggerEvent[] = []
  const records: EnvelopeRecord[] = []
  const realm = new RealmObserver({
    realm: 'page',
    config,
    hook: { installed: true, setObserver() {}, uninstall() {} },
    drafts: build.drafts,
    recorder: build.features.flightRecorder,
    originMono: 0,
    clock,
    host: {
      sink: { json: (r) => records.push(r), raw() {}, pendingBytes: 0 },
      level: () => 'baseline',
      onTrigger: (e) => triggers.push(e),
      onConnReady() {},
      onConnClosed() {},
      onOverrun() {},
      onPressure() {},
      onBytes() {},
      flush() {},
      dumpRoom: () => Number.POSITIVE_INFINITY,
      onError: (err) => {
        throw err
      },
    },
  })
  realm.start()
  realm.onSessionOpen({
    id: SESSION,
    url: 'https://relay.test/moq',
    anchor: { originMono: 0, originWall: 1_700_000_000_000 },
  })
  realm.onSessionProtocol(SESSION, 'moqt-20', 0)
  let stream = 2
  return {
    realm,
    triggers,
    publish(at) {
      realm.onStreamData({
        sessionId: SESSION,
        streamId: 1,
        direction: 'rx',
        bidi: true,
        control: true,
        at,
        data: publishBytes(0n, 1n),
      })
    },
    flow(from, to) {
      for (let at = from; at <= to; at += EVERY_MS) {
        const id = stream++
        realm.onStreamData({
          sessionId: SESSION,
          streamId: id,
          direction: 'rx',
          bidi: false,
          control: false,
          at,
          data: subgroupBytes({ alias: 1n, group: BigInt(at), objects: [{ id: 0n, bytes: 8 }] }),
        })
        realm.onStreamClose(SESSION, id)
      }
    },
  }
}

describe('a realm triggers only on live tracks', () => {
  it('opens a window when a flowing track on an open connection stops', () => {
    const r = rig()
    r.publish(0)
    r.flow(0, 2_000)
    r.realm.tick(2_600)
    expect(r.triggers.map((e) => e.kind)).toEqual(['stall'])
  })

  it('opens none for the tracks of a connection that has closed', () => {
    const r = rig()
    r.publish(0)
    r.flow(0, 2_000)
    r.realm.onSessionClose(SESSION, '', 2_050)
    r.realm.tick(10_000)
    expect(r.triggers).toEqual([])
  })

  it('opens none on the silence of a track no observed request bound', () => {
    const r = rig()
    r.flow(0, 2_000)
    r.realm.tick(2_600)
    expect(r.triggers).toEqual([])
  })
})
