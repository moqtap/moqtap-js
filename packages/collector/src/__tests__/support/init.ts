import { entryPoint } from '../../api/entry.js'
import { ALL_ADAPTERS } from '../../drafts/all.js'
import type { MockWebTransport } from '../transport/mocks.js'

/** The root entry's API without its module-eval hook install. */
export const { init, initWorker } = entryPoint(ALL_ADAPTERS)

/**
 * Construct a `WebTransport` through the page's global, as a player would: a
 * connection attempt, which begins the collector's session. Never opened, so
 * it stays a pending attempt until the test opens or closes it.
 */
export function attempt(url = 'https://relay.test/moq'): MockWebTransport {
  const g = globalThis as unknown as { WebTransport: new (u: string) => MockWebTransport }
  return new g.WebTransport(url)
}
