/**
 * Observing a realm's own transports: the `WebTransport` hook, the dormant
 * buffer that holds what it sees before a session takes it, and the realm that
 * decodes and rolls it up. Every draft module carries this, so a build that
 * imports no draft has none of it.
 */

import { connectionIdOf } from '../transport/index.js'
import {
  armDormant,
  claimDormantHook,
  dormantPending,
  ensureDormantHook,
  setPresenceActive,
} from './dormant.js'
import type { Observation } from './features.js'
import { RealmObserver } from './realm.js'

export const OBSERVATION: Observation = {
  install: (ring) => {
    ensureDormantHook(ring)
  },
  claim: claimDormantHook,
  arm: armDormant,
  pending: dormantPending,
  setPresenceActive,
  realm: (o) => new RealmObserver(o),
  connectionIdOf,
}
