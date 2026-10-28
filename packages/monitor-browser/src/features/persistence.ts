/**
 * IndexedDB: every sealed body is stored until ingest answers, so one the page
 * could not send is sent by the next page load on the origin. Web Locks keep
 * one page load from sending another's bodies while it is still running.
 */

import type { PersistenceFeature } from '../api/features.js'
import { ChunkStore, heldInstances, holdInstanceLock, platformLocks } from '../flush/index.js'

export const persistence: PersistenceFeature = {
  feature: 'persistence',
  persistence: {
    open: (name, quotaBytes, opts) => ChunkStore.open(name, quotaBytes, opts),
    platformLocks,
    hold: holdInstanceLock,
    held: heldInstances,
  },
}
