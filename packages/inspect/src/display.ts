/**
 * A control message's decoded fields, made readable.
 *
 * A decoded message holds values no reader shows as they are: a `bigint`
 * past 2^53, a byte string that is often a track name in ASCII, and setup
 * versions such as `0xff00000e` that a person knows as `draft-14`. Kept
 * here so every tool showing a message's fields reads the same.
 *
 * The output survives `postMessage` and `JSON.stringify`: a value that needs
 * both a shown form and the recorded one becomes a {@link Displayed} record,
 * and everything else is a plain number, string, boolean, `null`, array or
 * object.
 */

/** A value shown one way, with the value as recorded beside it for a tooltip. */
export interface Displayed {
  /**
   * What the value is:
   * - `text`: a byte string that is printable ASCII, shown as that text;
   * - `bytes`: any other byte string, shown in hex;
   * - `integer`: an integer past `Number.MAX_SAFE_INTEGER`, in full decimal;
   * - `version`: a MoQT setup version, shown as its draft.
   */
  readonly $shown: 'text' | 'bytes' | 'integer' | 'version'
  readonly text: string
  /** The recorded value: the bytes or the version in hex, the integer in decimal. */
  readonly raw: string
}

export function isDisplayed(value: unknown): value is Displayed {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.$shown === 'string' &&
    typeof v.text === 'string' &&
    typeof v.raw === 'string' &&
    Object.keys(v).length === 3
  )
}

/**
 * Bytes shown in hex before the rest is cut. A control message can carry a
 * whole object's worth of bytes in one field, and the field list is not
 * where anyone reads one.
 */
export const BYTES_PREVIEW = 32

/** Printable text longer than this is shown as bytes, in hex, like any other blob. */
const TEXT_LIMIT = 1024

/** Nesting kept before a value is cut to `…`: a trace sets its own depth. */
const MAX_DEPTH = 8

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * A byte string as printable ASCII (0x20–0x7e), or `null` when any byte is
 * outside that range.
 *
 * Leading NUL bytes are skipped: protocol-prefixed tokens often carry a type
 * or version byte before the readable part. All NULs, or nothing, is not text.
 */
export function bytesAsText(bytes: Uint8Array): string | null {
  let start = 0
  while (start < bytes.length && bytes[start] === 0) start += 1
  if (start === bytes.length || bytes.length - start > TEXT_LIMIT) return null
  let text = ''
  for (let i = start; i < bytes.length; i += 1) {
    const b = bytes[i]!
    if (b < 0x20 || b > 0x7e) return null
    text += String.fromCharCode(b)
  }
  return text
}

/** A byte string as text when it is printable, otherwise as a hex preview. */
export function displayBytes(bytes: Uint8Array): Displayed {
  const text = bytesAsText(bytes)
  if (text !== null) return { $shown: 'text', text, raw: `0x${hex(bytes)}` }
  const head = hex(bytes.subarray(0, BYTES_PREVIEW))
  const cut = bytes.length > BYTES_PREVIEW ? '…' : ''
  return {
    $shown: 'bytes',
    text: `0x${head}${cut} (${bytes.length} bytes)`,
    raw: `0x${hex(bytes.subarray(0, BYTES_PREVIEW * 8))}${bytes.length > BYTES_PREVIEW * 8 ? '…' : ''}`,
  }
}

/**
 * Any decoded value made readable: a safe `bigint` becomes a number, a larger
 * one its full decimal, bytes their text or hex, and maps and arrays are
 * walked. Anything else is returned unchanged.
 */
export function displayValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'bigint') {
    const n = Number(value)
    return Number.isSafeInteger(n)
      ? n
      : ({ $shown: 'integer', text: value.toString(), raw: value.toString() } satisfies Displayed)
  }
  if (value instanceof Uint8Array) return displayBytes(value)
  if (depth >= MAX_DEPTH) return '…'
  if (Array.isArray(value)) return value.map((v) => displayValue(v, depth + 1))
  if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        displayValue(v, depth + 1),
      ]),
    )
  }
  return value
}

/** The first setup version: drafts number theirs `0xff000000 + N`. */
const DRAFT_VERSION_BASE = 0xff000000
const DRAFT_VERSION_LAST = 0xffffffff

/**
 * `draft-14` for a setup version naming a draft, or `null` for anything else,
 * which is shown in hex.
 */
export function setupVersionLabel(version: unknown): string | null {
  const v = typeof version === 'bigint' ? Number(version) : version
  if (typeof v !== 'number' || !Number.isInteger(v)) return null
  if (v < DRAFT_VERSION_BASE || v > DRAFT_VERSION_LAST) return null
  return `draft-${String(v - DRAFT_VERSION_BASE).padStart(2, '0')}`
}

function displayVersion(version: unknown): unknown {
  const v = typeof version === 'bigint' ? Number(version) : version
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return displayValue(version)
  const raw = `0x${v.toString(16).padStart(8, '0')}`
  return { $shown: 'version', text: setupVersionLabel(v) ?? raw, raw } satisfies Displayed
}

/**
 * The message's kind in the codec's spelling (`client_setup`), from its name
 * in any case, or from the `type` key the codec's decoded messages carry.
 */
export function messageKind(name: string | null, fields?: Record<string, unknown>): string | null {
  if (name !== null) return name.toLowerCase()
  return typeof fields?.type === 'string' ? fields.type.toLowerCase() : null
}

/**
 * A control message's fields, made readable, with its setup versions named
 * by draft. `name` is the message's name in either case (`CLIENT_SETUP`).
 *
 * The unified SETUP of draft-17 and later has no version field: its draft
 * comes from the negotiated protocol instead.
 */
export function displayFields(
  name: string | null,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const kind = messageKind(name, fields)
  const shown = displayValue(fields) as Record<string, unknown>
  if (kind === 'client_setup' && Array.isArray(fields.supported_versions)) {
    shown.supported_versions = fields.supported_versions.map(displayVersion)
  }
  if (kind === 'server_setup' && fields.selected_version != null) {
    shown.selected_version = displayVersion(fields.selected_version)
  }
  return shown
}

/** Which end sent a setup message, and the implementation it named. */
export interface SetupImplementation {
  readonly side: 'client' | 'server'
  readonly implementation: string
}

/**
 * The `moqt_implementation` a setup message advertises, and which end it
 * names: the client and the relay name themselves on the wire.
 *
 * Draft-17 merged CLIENT_SETUP and SERVER_SETUP into one SETUP, whose options
 * carry it, so for that message the sender comes from `sentByClient`, and
 * without it the answer is `null`.
 */
export function setupImplementation(
  name: string | null,
  fields: Record<string, unknown>,
  sentByClient?: boolean,
): SetupImplementation | null {
  const kind = messageKind(name, fields)
  let side: SetupImplementation['side']
  if (kind === 'client_setup') side = 'client'
  else if (kind === 'server_setup') side = 'server'
  else if (kind === 'setup' && sentByClient !== undefined) side = sentByClient ? 'client' : 'server'
  else return null
  const params = fields.parameters ?? fields.options
  if (params === null || typeof params !== 'object') return null
  const value = (params as Record<string, unknown>).moqt_implementation
  const implementation = value instanceof Uint8Array ? bytesAsText(value) : value
  if (typeof implementation !== 'string' || implementation.length === 0) return null
  return { side, implementation }
}

/**
 * The draft a protocol identifier names: the WebTransport protocol a session
 * negotiated (`moqt-16`), or a trace header's (`moq-transport-16`). `null`
 * for anything else, rather than digits read off the end of an unrelated
 * string (`moq-transport-rfc9999`).
 */
export function draftOfProtocol(protocol: string): number | null {
  const match = /^(?:moqt|moq-transport)-(\d{1,2})$/.exec(protocol)
  return match === null ? null : Number(match[1])
}
