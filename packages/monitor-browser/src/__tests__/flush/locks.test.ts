/**
 * Which instances are alive, by their Web Locks.
 *
 * A stored body is swept by another page only when its instance's lock is
 * free, so a live tab's outbox is never raced. The fake lock manager below
 * implements the two calls the collector makes with the semantics the
 * platform gives them: `request` holds the lock until the callback's promise
 * settles, and `query` lists what is held.
 */

import { describe, expect, it } from 'vitest'
import {
  heldInstances,
  holdInstanceLock,
  LOCK_PREFIX,
  type LockManagerLike,
} from '../../flush/index.js'

function fakeLocks(withQuery = true): LockManagerLike & { held: Set<string> } {
  const held = new Set<string>()
  const locks = {
    held,
    request(name: string, callback: (lock: unknown) => Promise<unknown> | unknown) {
      held.add(name)
      return Promise.resolve(callback({ name })).finally(() => held.delete(name))
    },
    ...(withQuery ? { query: async () => ({ held: [...held].map((name) => ({ name })) }) } : {}),
  }
  return locks
}

describe('holdInstanceLock', () => {
  it('holds moqtap:<instanceId> until released', async () => {
    const locks = fakeLocks()
    const release = holdInstanceLock(locks, 'inst-a')
    expect(locks.held.has(`${LOCK_PREFIX}inst-a`)).toBe(true)
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(locks.held.has(`${LOCK_PREFIX}inst-a`)).toBe(false)
  })

  it('is a no-op without a lock manager, and never throws', () => {
    expect(() => holdInstanceLock(undefined, 'inst-a')()).not.toThrow()
    const errors: unknown[] = []
    const hostile: LockManagerLike = {
      request: () => {
        throw new Error('SecurityError')
      },
    }
    expect(() => holdInstanceLock(hostile, 'inst-a', (e) => errors.push(e))()).not.toThrow()
    expect(errors).toHaveLength(1)
  })
})

describe('heldInstances', () => {
  it('lists the instances whose locks are held, and nothing else of the origin', async () => {
    const locks = fakeLocks()
    holdInstanceLock(locks, 'inst-a')
    holdInstanceLock(locks, 'inst-b')
    void locks.request('someone-elses-lock', () => new Promise(() => {}))
    expect(await heldInstances(locks)).toEqual(new Set(['inst-a', 'inst-b']))
  })

  it('cannot say without query(), so the caller falls back to age', async () => {
    expect(await heldInstances(fakeLocks(false))).toBeNull()
    expect(await heldInstances(undefined)).toBeNull()
  })

  it('cannot say when query() rejects, and reports why', async () => {
    const errors: unknown[] = []
    const locks: LockManagerLike = {
      request: async () => undefined,
      query: () => Promise.reject(new Error('InvalidStateError')),
    }
    expect(await heldInstances(locks, (e) => errors.push(e))).toBeNull()
    expect(errors).toHaveLength(1)
  })
})
