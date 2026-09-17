/**
 * Every control message name this package answers with, on every draft it
 * implements, is checked against the shared vector corpus.
 *
 * The names are not written here. They are read out of
 * `transport/draftNN/codec/messages/*.json` in `@moqtap/test-vectors`, whose
 * every file carries the pair this is about: `message_type_id`, the number on
 * the wire, and `message_type`, the snake_case name for it on that draft. The
 * Rust codec holds its own tables to the same corpus, so holding this package
 * to it is what keeps the two implementations naming a recorded trace the same
 * way. Neither table is checked against the other directly — they are each
 * checked against the corpus, which is the only arrangement in which a drift
 * between them cannot be split fifty-fifty and argued about.
 *
 * ── Both directions, per draft
 *
 * A name table drifts two ways. An id the corpus assigns and this package
 * cannot name shows up in a dump as a bare number, which is visible. An id this
 * package names and the corpus does not assign is the dangerous one: it puts a
 * confident, wrong label on a message, and it survives any check that walks the
 * corpus and looks each id up. So the two id sets are compared as sets and the
 * two failures are reported separately, each naming its own offenders.
 *
 * The comparison is per draft rather than over the union, because the ids are
 * reused. 0x07 is `announce_ok` through draft-13, `publish_namespace_ok` on
 * draft-14 and `request_ok` from draft-15 on; 0x0e and 0x11 move the same way.
 * A table checked against the union of all fourteen corpora would accept every
 * one of those spellings on every draft, which is a draft-blind lookup wearing
 * a per-draft table's clothes.
 *
 * ── What an empty answer would mean
 *
 * Every assertion below is of the form *these two sets are equal*, and two
 * empty sets are equal. A walk that lost the corpus would therefore report a
 * clean sweep, so the shapes that produce one are refused rather than returned:
 * a draft directory with no message files, and a draft whose files named no ids
 * at all. A directory that is not there throws out of `loadVectorDir` before
 * any of that, and a file with no `message_type_id` throws rather than being
 * skipped — a skipped file is a row missing from the corpus side of a set
 * comparison, which reads as agreement.
 *
 * ── Read through the entry point
 *
 * The maps come from each draft's `index.js` rather than from its
 * `messages.js`, so this gate also holds them to being reachable from outside
 * their own module. That is the drift `error-codes.test.ts` exists to document:
 * a constant that is written but never re-exported sits in the published
 * package with no way to name it from outside.
 */

import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as draft07 from '../drafts/draft07/index.js'
import * as draft08 from '../drafts/draft08/index.js'
import * as draft09 from '../drafts/draft09/index.js'
import * as draft10 from '../drafts/draft10/index.js'
import * as draft11 from '../drafts/draft11/index.js'
import * as draft12 from '../drafts/draft12/index.js'
import * as draft13 from '../drafts/draft13/index.js'
import * as draft14 from '../drafts/draft14/index.js'
import * as draft15 from '../drafts/draft15/index.js'
import * as draft16 from '../drafts/draft16/index.js'
import * as draft17 from '../drafts/draft17/index.js'
import * as draft18 from '../drafts/draft18/index.js'
import * as draft19 from '../drafts/draft19/index.js'
import * as draft20 from '../drafts/draft20/index.js'
import * as draft21 from '../drafts/draft21/index.js'
import { DRAFT_VERSIONS } from '../index.js'
import { loadVectorDir } from './helpers.js'

interface Draft {
  /** The two-digit draft number, which is also its corpus directory suffix. */
  draft: string
  /** Wire id → name, the direction a trace reader looks a type code up in. */
  types: ReadonlyMap<bigint, string>
  /** Name → wire id, the direction an encoder looks a message up in. */
  ids: ReadonlyMap<string, bigint>
}

/**
 * Every draft this package implements.
 *
 * Both maps are taken as whole objects rather than scanned out of the module's
 * `MSG_*` exports, because those exports are not the table. Draft-07 declares
 * its data-stream type ids in the same module and the same namespace, and two
 * of them collide numerically with control codepoints — `STREAM_HEADER_SUBGROUP`
 * is 0x04, which is also `subscribe_ok`. `MESSAGE_TYPE_MAP` is the list of
 * control assignments; the constants around it are not.
 */
const DRAFTS: readonly Draft[] = [
  { draft: '07', types: draft07.MESSAGE_TYPE_MAP, ids: draft07.MESSAGE_ID_MAP },
  { draft: '08', types: draft08.MESSAGE_TYPE_MAP, ids: draft08.MESSAGE_ID_MAP },
  { draft: '09', types: draft09.MESSAGE_TYPE_MAP, ids: draft09.MESSAGE_ID_MAP },
  { draft: '10', types: draft10.MESSAGE_TYPE_MAP, ids: draft10.MESSAGE_ID_MAP },
  { draft: '11', types: draft11.MESSAGE_TYPE_MAP, ids: draft11.MESSAGE_ID_MAP },
  { draft: '12', types: draft12.MESSAGE_TYPE_MAP, ids: draft12.MESSAGE_ID_MAP },
  { draft: '13', types: draft13.MESSAGE_TYPE_MAP, ids: draft13.MESSAGE_ID_MAP },
  { draft: '14', types: draft14.MESSAGE_TYPE_MAP, ids: draft14.MESSAGE_ID_MAP },
  { draft: '15', types: draft15.MESSAGE_TYPE_MAP, ids: draft15.MESSAGE_ID_MAP },
  { draft: '16', types: draft16.MESSAGE_TYPE_MAP, ids: draft16.MESSAGE_ID_MAP },
  { draft: '17', types: draft17.MESSAGE_TYPE_MAP, ids: draft17.MESSAGE_ID_MAP },
  { draft: '18', types: draft18.MESSAGE_TYPE_MAP, ids: draft18.MESSAGE_ID_MAP },
  { draft: '19', types: draft19.MESSAGE_TYPE_MAP, ids: draft19.MESSAGE_ID_MAP },
  { draft: '20', types: draft20.MESSAGE_TYPE_MAP, ids: draft20.MESSAGE_ID_MAP },
  { draft: '21', types: draft21.MESSAGE_TYPE_MAP, ids: draft21.MESSAGE_ID_MAP },
]

/**
 * The corpus's name for a type code no draft assigns.
 *
 * Each draft's `unknown-type.json` is a negative vector wearing the same header
 * as the positive ones: it puts 0x3f on the wire and expects a decoder to
 * refuse it. It names no message, so it is excluded from the corpus's table and
 * then held to what it claims — this package must have no row for that id on
 * that draft.
 */
const UNASSIGNED = 'unknown'

interface Alias {
  /** The draft whose corpus files the second name. */
  draft: string
  /** The second name the corpus files under an already-named id. */
  alias: string
  /** The name this package answers with for that id. */
  canonical: string
}

/**
 * A second corpus file for an id that already has a name.
 *
 * On drafts 18, 19 and 20 PUBLISH_OK is not a codepoint of its own: it is a
 * REQUEST_OK (0x07) sent in reply to a PUBLISH. The corpus carries a
 * `publish-ok.json` on those drafts whose vectors are REQUEST_OK bytes at 0x07,
 * and `MESSAGE_TYPE_MAP` files 0x07 once, as `request_ok`. The alias is a second
 * file name for one assignment, not a second assignment.
 *
 * A row here is the only way two names on one id pass. Anything else is the
 * corpus assigning an id twice, which is a finding rather than a fact — and a
 * row that stops being used fails as loudly as one that is missing, so the list
 * cannot outlive what it excuses.
 */
const ALIASES: readonly Alias[] = [
  { draft: '18', alias: 'publish_ok', canonical: 'request_ok' },
  { draft: '19', alias: 'publish_ok', canonical: 'request_ok' },
  { draft: '20', alias: 'publish_ok', canonical: 'request_ok' },
  { draft: '21', alias: 'publish_ok', canonical: 'request_ok' },
]

/**
 * A wire id for a human to read in a failure message.
 *
 * Shortest form, so 0x3 rather than the corpus's `0x03` and the drafts' `0x3`
 * or `0x03` depending on the table. Nothing compares this string — ids are
 * compared as bigints, which is why the three spellings can disagree without
 * any of them being wrong.
 */
function hex(id: bigint): string {
  return `0x${id.toString(16)}`
}

function byId(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The wire id a vector file declares, as the corpus writes it: `0x` and hex.
 *
 * `message_type_id` is optional in {@link TestVectorFile} and present in every
 * file in fact, so the absent case throws instead of being tolerated. Parsed as
 * a `bigint` because that is what the maps are keyed by; `MESSAGE_TYPE_MAP.get`
 * of a `number` misses every row.
 */
function declaredId(draft: string, file: string, raw: string | undefined): bigint {
  if (raw === undefined) throw new Error(`draft-${draft}/${file}: no message_type_id`)
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(`draft-${draft}/${file}: message_type_id ${JSON.stringify(raw)} is not 0x hex`)
  }
  return BigInt(raw)
}

/**
 * What one draft's corpus names each control message id, and which file said so.
 *
 * Keyed by id, and carrying every name filed under that id — one name for all
 * but the rows {@link ALIASES} records. The directory is read rather than a
 * file list, so a message added upstream is compared rather than silently
 * ignored, which is the whole point of checking against a corpus instead of
 * against a second copy of the table.
 */
function corpusNames(
  draft: string,
  ours: ReadonlyMap<bigint, string>,
): Map<bigint, Map<string, string>> {
  const files = loadVectorDir(`transport/draft${draft}/codec/messages`)
  expect(
    files.length,
    `draft-${draft}: no vector files — an empty sweep proves nothing`,
  ).toBeGreaterThan(0)

  const named = new Map<bigint, Map<string, string>>()
  let unassigned = 0

  for (const { file, data } of files) {
    const id = declaredId(draft, file, data.message_type_id)

    if (data.message_type === UNASSIGNED) {
      unassigned++
      expect(
        ours.has(id),
        `draft-${draft}/${file} says ${hex(id)} is a type code the draft does not assign, and ` +
          `this package names it ${ours.get(id)}`,
      ).toBe(false)
      continue
    }

    const spellings = named.get(id) ?? new Map<string, string>()
    const previous = spellings.get(data.message_type)
    expect(
      previous,
      `draft-${draft}: ${data.message_type} is declared at ${hex(id)} by two files, ${file} and ` +
        `${previous}`,
    ).toBeUndefined()
    spellings.set(data.message_type, file)
    named.set(id, spellings)
  }

  expect(
    unassigned,
    `draft-${draft}: expected exactly one file declaring the unassigned type code, found ` +
      `${unassigned} — every draft's corpus carries one, so this is the walk having lost it`,
  ).toBe(1)
  expect(named.size, `draft-${draft}: the message corpus named no ids at all`).toBeGreaterThan(0)

  return named
}

/**
 * Require this package's names for one draft and the corpus's to be the same
 * set of ids with the same name on each.
 */
function namesAgreeWithTheCorpus({ draft, types }: Draft): void {
  const corpus = corpusNames(draft, types)

  const missing = [...corpus.keys()]
    .filter((id) => !types.has(id))
    .sort(byId)
    .map((id) => `${hex(id)} ${[...(corpus.get(id) as Map<string, string>).keys()].join('/')}`)
  expect(
    missing,
    `draft-${draft}: assigned by the corpus, not named by this package: ${missing.join(', ')}`,
  ).toEqual([])

  const extra = [...types.keys()]
    .filter((id) => !corpus.has(id))
    .sort(byId)
    .map((id) => `${hex(id)} ${types.get(id)}`)
  expect(
    extra,
    `draft-${draft}: named by this package, not assigned by the corpus: ${extra.join(', ')}`,
  ).toEqual([])

  const aliasesUsed = new Set<string>()
  for (const [id, spellings] of corpus) {
    // Every corpus id is a row of `types` by the time control reaches here: the
    // two set comparisons above have already passed.
    const ours = types.get(id) as string
    const filed = [...spellings.keys()]
    expect(
      filed,
      `draft-${draft}: ${hex(id)} is ${filed.join('/')} in the corpus, ${ours} in this package`,
    ).toContain(ours)

    // Any other spelling the corpus files under this id has to be a recorded
    // alias for the one this package answers with. Two unexplained names on one
    // id is the corpus assigning it twice.
    for (const [name, file] of spellings) {
      if (name === ours) continue
      const recorded = ALIASES.some(
        (a) => a.draft === draft && a.alias === name && a.canonical === ours,
      )
      expect(
        recorded,
        `draft-${draft}/${file}: ${hex(id)} is also filed as ${name}, and this package answers ` +
          `${ours}. Either the corpus assigns one id to two messages, or ${name} is an alias ` +
          `that needs a row in ALIASES saying so.`,
      ).toBe(true)
      aliasesUsed.add(name)
    }
  }

  const stale = ALIASES.filter((a) => a.draft === draft && !aliasesUsed.has(a.alias)).map(
    (a) => a.alias,
  )
  expect(
    stale,
    `draft-${draft}: ALIASES records ${stale.join(', ')} as a second name the corpus files, and ` +
      `the corpus no longer does. The row excuses nothing and must go.`,
  ).toEqual([])
}

/**
 * The draft pairs whose whole name table coincides.
 *
 * A per-draft comparison catches a map wired to the wrong draft only where the
 * two drafts disagree about something, so which drafts agree completely is the
 * measure of what the fifteen tests above cannot see. Drafts 08, 09 and 10
 * assign exactly the same ids to exactly the same names, so those three tables
 * are interchangeable as far as any corpus check can tell. Draft-21 restructures
 * draft-20 without changing the wire, so it assigns every id exactly as draft-20
 * does and the two are told apart only by the protocol string they negotiate,
 * `moqt-21` against `moqt-20`. Every other pair in the range differs somewhere
 * and is held apart by its own test.
 *
 * Written down rather than derived, so a draft joining or leaving the run is a
 * change to this list.
 */
const IDENTICAL_TABLES: readonly string[] = ['08/09', '08/10', '09/10', '20/21']

/** One draft's table as a comparable string, in id order. */
function tableShape(types: ReadonlyMap<bigint, string>): string {
  return [...types.keys()]
    .sort(byId)
    .map((id) => `${hex(id)} ${types.get(id)}`)
    .join('\n')
}

describe('message type names', () => {
  // Both of the package's own answers to "which drafts do you ship", because a
  // draft can be absent from either one independently: `DRAFT_VERSIONS` is what
  // `createCodec` will accept, and `src/drafts/` is what exists to be imported.
  // A draft added to one and not the other is itself a defect worth failing on.
  //
  // Neither is a list written in this file. A list here could only be compared
  // against the list above it, which is the same list, and two copies of one
  // list agree with each other no matter what the package does — so a fifteenth
  // draft would ship ungated and every test here would stay green.
  it('covers every draft the package ships', () => {
    const walked = DRAFTS.map((d) => d.draft).sort()

    const accepted = Object.keys(DRAFT_VERSIONS).sort()
    expect(
      walked,
      `DRAFT_VERSIONS accepts ${accepted.join(', ')}; this file walks ${walked.join(', ')}`,
    ).toEqual(accepted)

    const shipped = readdirSync(new URL('../drafts/', import.meta.url), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^draft\d\d$/.test(e.name))
      .map((e) => e.name.slice('draft'.length))
      .sort()
    expect(
      shipped.length,
      'no draft modules found — an empty sweep proves nothing',
    ).toBeGreaterThan(0)
    expect(
      walked,
      `src/drafts/ ships ${shipped.join(', ')}; this file walks ${walked.join(', ')}`,
    ).toEqual(shipped)
  })

  it('records aliases only for drafts in the run', () => {
    // A row naming a draft nobody walks is never reached by the stale check,
    // so it would sit in ALIASES forever excusing nothing.
    const known = new Set(DRAFTS.map((d) => d.draft))
    const orphaned = ALIASES.filter((a) => !known.has(a.draft)).map((a) => `${a.draft}/${a.alias}`)
    expect(
      orphaned,
      `ALIASES names drafts this package does not ship: ${orphaned.join(', ')}`,
    ).toEqual([])
  })

  it.each(DRAFTS)('draft-$draft names exactly what the corpus assigns', (draft) => {
    namesAgreeWithTheCorpus(draft)
  })

  it.each(DRAFTS)('draft-$draft inverts its own table without collapsing', ({
    draft,
    types,
    ids,
  }) => {
    // `MESSAGE_ID_MAP` is built from `MESSAGE_TYPE_MAP`, so it cannot hold a
    // name the other does not — but two ids sharing a name would quietly cost
    // it a row, and the corpus comparison above reads only the forward map and
    // would stay green through it.
    expect(
      ids.size,
      `draft-${draft}: ${types.size} ids share ${ids.size} names, so a name is filed twice`,
    ).toBe(types.size)
    for (const [id, name] of types) {
      expect(ids.get(name), `draft-${draft}: ${name} is ${hex(id)} forwards`).toBe(id)
    }
  })

  it('keeps the drafts distinguishable from each other', () => {
    const coinciding: string[] = []
    for (let i = 0; i < DRAFTS.length; i++) {
      const a = DRAFTS[i] as Draft
      for (const b of DRAFTS.slice(i + 1)) {
        if (tableShape(a.types) === tableShape(b.types)) coinciding.push(`${a.draft}/${b.draft}`)
      }
    }

    expect(
      coinciding,
      'which drafts name every id the same way has changed. A pair that has joined this list is ' +
        'a pair the per-draft tests can no longer tell apart; a pair that has left it is a draft ' +
        'whose table moved.',
    ).toEqual(IDENTICAL_TABLES)
  })
})
