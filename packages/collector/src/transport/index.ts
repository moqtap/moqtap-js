/**
 * The transport seam.
 *
 * The only module that touches the page's own objects, and the only one whose
 * callbacks run on the page's data path. Everything it exports is either the
 * hook itself or the control-plane test it requires — which is deliberately
 * NOT `bidi` alone, because from draft-17 the control plane is a *pair of
 * unidirectional streams* and a boolean-only test misfiles the entire control
 * plane as bulk media on every draft this package supports.
 */

export {
  isControlPlane,
  opensUniControlStream,
  UNI_CONTROL_STREAM_PREFIX,
} from './control-plane.js'
export type { CollectorPresence, PresenceHandle } from './presence.js'
export { PRESENCE_KEY, publishPresence, readPresence } from './presence.js'
export { StreamRegistry } from './stream-registry.js'
export {
  extractSessionOptions,
  installWebTransportHook,
  readNegotiatedProtocol,
  type TransportHook,
} from './webtransport-hook.js'
