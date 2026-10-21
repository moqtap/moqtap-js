/**
 * The names one control message went by across the drafts.
 *
 * Messages were renamed without changing what they do: ANNOUNCE became
 * PUBLISH_NAMESPACE in draft-14, SUBSCRIBE_DONE became PUBLISH_DONE, and the
 * two setup messages became one SETUP in draft-17. Someone who knows a message
 * by its older name finds it under the newer one through these.
 *
 * Consolidations that changed what a message is are not renames and are not
 * listed: REQUEST_ERROR answers every request from draft-15, not only
 * SUBSCRIBE, so SUBSCRIBE_ERROR is not one of its names.
 */

const RENAMES: readonly (readonly string[])[] = [
  ['client_setup', 'setup'],
  ['server_setup', 'setup'],
  ['announce', 'publish_namespace'],
  ['announce_ok', 'publish_namespace_ok'],
  ['announce_error', 'publish_namespace_error'],
  ['unannounce', 'publish_namespace_done'],
  ['announce_cancel', 'publish_namespace_cancel'],
  ['subscribe_announces', 'subscribe_namespace'],
  ['subscribe_announces_ok', 'subscribe_namespace_ok'],
  ['subscribe_announces_error', 'subscribe_namespace_error'],
  ['unsubscribe_announces', 'unsubscribe_namespace'],
  ['subscribe_done', 'publish_done'],
  ['subscribe_update', 'request_update'],
  ['max_subscribe_id', 'max_request_id'],
  ['subscribes_blocked', 'requests_blocked'],
  ['publish_blocked', 'publish_skipped'],
  ['track_status_request', 'track_status'],
]

/**
 * The last draft in which TRACK_STATUS is the answer to TRACK_STATUS_REQUEST.
 * From draft-13 the request took the name and the answer became
 * TRACK_STATUS_OK.
 */
const TRACK_STATUS_ANSWER_UNTIL = 12

const ALIASES: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>()
  for (const group of RENAMES) {
    for (const name of group) {
      const others = map.get(name) ?? []
      for (const other of group) {
        if (other !== name && !others.includes(other)) others.push(other)
      }
      map.set(name, others)
    }
  }
  return map
})()

/**
 * The same message's names in other drafts, in the case `name` was given in:
 * `messageAliases('ANNOUNCE')` is `['PUBLISH_NAMESPACE']`. Empty when the
 * message was never renamed.
 *
 * TRACK_STATUS named the answer through draft-12 and the request after, so
 * pass the draft to read it as the answer; without one it is read as the
 * request.
 */
export function messageAliases(name: string, draft?: number | null): string[] {
  const lower = name.toLowerCase()
  const found =
    lower === 'track_status' && draft != null && draft <= TRACK_STATUS_ANSWER_UNTIL
      ? ['track_status_ok']
      : lower === 'track_status_ok'
        ? ['track_status']
        : [...(ALIASES.get(lower) ?? [])]
  const upper = name === name.toUpperCase() && name !== lower
  return upper ? found.map((n) => n.toUpperCase()) : found
}
