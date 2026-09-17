/**
 * Reading the negotiated draft off the SETUP handshake, for the eight drafts
 * whose ALPN does not carry it.
 *
 * Draft-20 §3.1, on version negotiation: *"Note: Draft versions prior to -15 all
 * used moq-00 ALPN, followed by version negotiation"*. So `session.protocol`
 * resolves to `moq-00` for drafts 07 through 14 and says only "MoQT, something
 * before 15". Those eight cover most of the deployed field — `moq-00` is what
 * draft-11 and draft-14 endpoints negotiate on the public relay fleet — so
 * refusing them over an ambiguous ALPN would withhold the adapter from most real
 * sessions.
 *
 * The version is in the clear in the first control frame. Two messages carry it
 * and both are accepted:
 *
 *  - **SERVER_SETUP** carries `selected_version` as its first payload field.
 *  - **CLIENT_SETUP** carries a count and a list of `supported_versions`. A list
 *    of **exactly one** is also the answer: the session is running, so the one
 *    version offered is the one selected. A longer list is refused rather than
 *    guessed at.
 *
 * Anything else returns `undefined`, meaning "keep buffering", not "give up":
 * the caller tries again on the next control chunk and degrades the session to
 * transport-only if the window closes first.
 *
 * Probing the framing without knowing the draft first is not circular. All eight
 * use RFC 9000's varints — the family only changes at draft-17 — so the *type*
 * field reads the same way whichever of the eight it is, and the type says how
 * the length is framed:
 *
 * | type   | message      | drafts | length field |
 * | ------ | ------------ | ------ | ------------ |
 * | `0x40` | CLIENT_SETUP | 07-10  | varint       |
 * | `0x41` | SERVER_SETUP | 07-10  | varint       |
 * | `0x20` | CLIENT_SETUP | 11-14  | 16-bit BE    |
 * | `0x21` | SERVER_SETUP | 11-14  | 16-bit BE    |
 *
 * Those four values are SETUP messages in every draft in range and nothing else
 * in any of them (each draft's `messages.ts`), and SETUP is the first message on
 * the control stream, so a frame at offset 0 beginning with one of them is a
 * SETUP frame or is not a MoQT control stream at all.
 *
 * The version itself is then matched against a table of the drafts the codec
 * speaks. Not arithmetic on `0xff000000`: that would accept `0xff000063` as
 * draft-99 and turn a clean "unsupported" into a chunk load for a module that
 * does not exist.
 */

import type { SupportedDraft } from '../types.js'
import { draftOfVersion } from './protocol.js'
import { NEED, readRfc9000 } from './varint.js'

/** CLIENT_SETUP in drafts 07-10, whose control frames carry a varint length. */
const CLIENT_SETUP_VARINT_LEN = 0x40n
/** SERVER_SETUP in drafts 07-10. */
const SERVER_SETUP_VARINT_LEN = 0x41n
/** CLIENT_SETUP in drafts 11-14, whose control frames carry a 16-bit length. */
const CLIENT_SETUP_U16_LEN = 0x20n
/** SERVER_SETUP in drafts 11-14. */
const SERVER_SETUP_U16_LEN = 0x21n

/**
 * The draft a `moq-00` session negotiated, read off the first control frame, or
 * `undefined` when these bytes do not say.
 *
 * `undefined` is an ordinary outcome, not a refusal: a partial frame, a client
 * offering several versions, and a version this package has no decoder for all
 * produce it, and only the caller knows whether more bytes are coming.
 *
 * @param b The control stream from its **first byte**. A later chunk finds
 *   nothing, which is correct: SETUP is the first message, so a mid-stream match
 *   would be a coincidence rather than a handshake.
 */
export function draftOfSetupFrame(b: Uint8Array): SupportedDraft | undefined {
  const type = readRfc9000(b, 0)
  if (type === NEED) return undefined

  let isServer: boolean
  let payloadStart: number
  if (type.value === SERVER_SETUP_VARINT_LEN || type.value === CLIENT_SETUP_VARINT_LEN) {
    isServer = type.value === SERVER_SETUP_VARINT_LEN
    const len = readRfc9000(b, type.next)
    if (len === NEED) return undefined
    payloadStart = len.next
  } else if (type.value === SERVER_SETUP_U16_LEN || type.value === CLIENT_SETUP_U16_LEN) {
    isServer = type.value === SERVER_SETUP_U16_LEN
    if (type.next + 2 > b.length) return undefined
    payloadStart = type.next + 2
  } else {
    // Not a SETUP frame. On a control stream whose first message must be one,
    // that means these are not the bytes this probe was written for.
    return undefined
  }

  if (isServer) {
    const version = readRfc9000(b, payloadStart)
    if (version === NEED) return undefined
    return draftOfVersion(version.value)
  }

  const count = readRfc9000(b, payloadStart)
  if (count === NEED) return undefined
  // Exactly one offered version is the one that was selected. Two or more and
  // this frame does not say which; the server's answer will. The count is only
  // ever compared, never looped on or allocated against, so a corrupt one costs
  // nothing here.
  if (count.value !== 1n) return undefined
  const version = readRfc9000(b, count.next)
  if (version === NEED) return undefined
  return draftOfVersion(version.value)
}
