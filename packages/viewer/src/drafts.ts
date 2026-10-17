/**
 * Naming the control messages in a trace.
 *
 * A trace records a message's wire type ID and nothing that names it, so `0x03`
 * has to become `SUBSCRIBE` here, and only with a draft in hand, because the
 * same ID means different messages in different drafts. A confident wrong name
 * is worse than a hex code.
 *
 * The tables come from `src/data/message-tables.json`, which
 * `scripts/registries.ts` slims down from the site's registries, which are
 * extracted from the draft documents. A hand-written list would drift from the
 * reference pages that show the same code points; a generated one is checked
 * against them (`bun run registries:check`).
 */

/** One row of a draft's control message type registry. */
export interface MessageDef {
  readonly value: number
  readonly name: string
  /** A code point the draft set aside. Its `note` says what it was assigned to before. */
  readonly reserved: boolean
  readonly note: string | null
  /** Where this message is specified, as a path on moqtap.com. */
  readonly specPath: string | null
}

/** Every draft's message registry, keyed by draft number. */
export type MessageTables = Readonly<Record<number, readonly MessageDef[]>>

/**
 * `moq-transport-16` is what the recorders here write; `moqt-20` is the
 * protocol string the drafts define. Anything else names no draft rather than
 * yielding a number pulled hopefully off the end: `moq-transport-rfc9999` is
 * a real value in the conformance corpus, and reading `99` out of it would
 * attach a whole registry of wrong names to the trace.
 */
const PROTOCOL = /^(?:moq-transport|moqt)-(\d{1,2})$/

/**
 * The draft a protocol string names, or `null` when we cannot say. That is a
 * real answer, and shown as one: a trace from a draft the viewer does not carry is
 * still readable, just without message names.
 */
export function draftOf(protocol: string, tables: MessageTables): number | null {
  const match = PROTOCOL.exec(protocol)
  if (match === null) return null
  const draft = Number(match[1])
  return draft in tables ? draft : null
}

/** Index a draft's rows by wire ID. Registry values are unique within a draft. */
export function byId(defs: readonly MessageDef[]): ReadonlyMap<number, MessageDef> {
  return new Map(defs.map((def) => [def.value, def]))
}

/**
 * The wire IDs for a set of message names, skipping names this draft lacks.
 *
 * Callers ask by name because the names are what kept their meaning while the
 * IDs moved. A subscription's response is `SUBSCRIBE_OK` up to draft 14 and
 * `REQUEST_OK` from 15, so asking for both gets whichever this draft defines
 * without special-casing the changeover.
 */
export function idsNamed(
  defs: readonly MessageDef[],
  names: readonly string[],
): ReadonlySet<number> {
  const wanted = new Set(names)
  return new Set(defs.filter((def) => !def.reserved && wanted.has(def.name)).map((d) => d.value))
}
