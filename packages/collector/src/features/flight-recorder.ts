/**
 * The flight recorder: the ring of recent object data, the stall and cadence
 * triggers, and the dump a trigger fires. In the page it needs `escalation`
 * too, since a trigger opens a capture window; a worker's recorder needs only
 * this.
 */

import type { FlightRecorderFeature } from '../api/features.js'
import { FlightRecorder, TriggerEngine } from '../recorder/index.js'
import { ByteRing, parseByteDepth } from '../ring/index.js'

export const flightRecorder: FlightRecorderFeature = {
  feature: 'flightRecorder',
  ring: (maxBytes: number) => new ByteRing({ maxBytes }),
  parseDepth: parseByteDepth,
  create(d, ring) {
    const recorder = new FlightRecorder({
      ring: ring as ByteRing,
      sink: d.sink,
      adapter: d.adapter,
      keys: d.keys,
      conn: d.conn,
      level: d.level,
      originMono: d.originMono,
    })
    const triggers = new TriggerEngine({
      config: d.config.triggers,
      medians: { medianFor: d.medianFor, medianSamplesFor: d.medianSamplesFor },
      onFire: d.onFire,
    })
    return {
      ring,
      arm: (t) => recorder.arm(t),
      disarm: () => {
        recorder.disarm()
        triggers.reset()
      },
      tick: (now) => triggers.tick(now),
      onObject: (s) => triggers.onObject(s),
      fire: (e) => recorder.fire(e),
    }
  },
}
