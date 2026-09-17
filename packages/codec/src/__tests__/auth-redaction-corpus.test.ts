/**
 * The mask, run over the whole external corpus rather than over fixtures we wrote.
 *
 * `auth-redaction.test.ts` builds its own frames, which means it can only find
 * the cases somebody thought of. `@moqtap/test-vectors` was authored against the
 * drafts by someone else and carries a credential in up to eight message types
 * per draft — SUBSCRIBE, FETCH, PUBLISH, PUBLISH_NAMESPACE, SUBSCRIBE_NAMESPACE,
 * SUBSCRIBE_TRACKS, TRACK_STATUS and SETUP — in every Alias Type shape the draft
 * has. Every one of them is a message layout the mask has to walk past to reach
 * the parameter block, and not one of them was chosen by the code being tested.
 *
 * The assertion is the same one that matters everywhere else: the credential's
 * bytes are not in the redacted frame, and everything else still decodes.
 *
 * ── Two credentials, not one
 *
 * Drafts 07 through 10 have no Authorization Token. They carry
 * AUTHORIZATION_INFO, a bare UTF-8 string, and that string **is** the bearer
 * credential — there is no alias, no token type, and nothing structural to keep.
 * So the whole parameter value is overwritten there, while from draft-11 on only
 * the Token Value goes and the Alias Type, Token Alias and Token Type stay.
 * {@link declaredSecretsIn} reads both shapes out of the corpus, which is why
 * the same assertion covers all fourteen drafts.
 */

import { describe, expect, it } from 'vitest'
import {
  decodeMessage as decodeMessage07,
  redactAuthTokens as redact07,
} from '../drafts/draft07/index.js'
import {
  decodeMessage as decodeMessage08,
  redactAuthTokens as redact08,
} from '../drafts/draft08/index.js'
import {
  decodeMessage as decodeMessage09,
  redactAuthTokens as redact09,
} from '../drafts/draft09/index.js'
import {
  decodeMessage as decodeMessage10,
  redactAuthTokens as redact10,
} from '../drafts/draft10/index.js'
import {
  decodeMessage as decodeMessage11,
  redactAuthTokens as redact11,
} from '../drafts/draft11/index.js'
import {
  decodeMessage as decodeMessage12,
  redactAuthTokens as redact12,
} from '../drafts/draft12/index.js'
import {
  decodeMessage as decodeMessage13,
  redactAuthTokens as redact13,
} from '../drafts/draft13/index.js'
import {
  decodeMessage as decodeMessage14,
  redactAuthTokens as redact14,
} from '../drafts/draft14/index.js'
import {
  decodeMessage as decodeMessage15,
  redactAuthTokens as redact15,
} from '../drafts/draft15/index.js'
import {
  decodeMessage as decodeMessage16,
  redactAuthTokens as redact16,
} from '../drafts/draft16/index.js'
import {
  decodeMessage as decodeMessage17,
  redactAuthTokens as redact17,
} from '../drafts/draft17/index.js'
import {
  decodeMessage as decodeMessage18,
  redactAuthTokens as redact18,
} from '../drafts/draft18/index.js'
import {
  decodeMessage as decodeMessage19,
  redactAuthTokens as redact19,
} from '../drafts/draft19/index.js'
import {
  decodeMessage as decodeMessage20,
  redactAuthTokens as redact20,
} from '../drafts/draft20/index.js'
import {
  decodeMessage as decodeMessage21,
  redactAuthTokens as redact21,
} from '../drafts/draft21/index.js'
import { hexToBytes, loadVectorDir, type TestVector } from './helpers.js'

interface SecretBearing {
  file: string
  vector: TestVector
  /** Every non-empty credential the vector declares, as hex. */
  values: string[]
}

const textEncoder = new TextEncoder()

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

/**
 * Pull the declared credentials straight out of the vector JSON.
 *
 * Read off the corpus rather than off our own decoder: a value the decoder
 * mis-parsed would then be compared against itself and the test would pass on a
 * bug. The corpus states what is in the bytes; this test holds us to that.
 *
 * Two shapes, because the wire has two. `token_value` is already hex in the
 * corpus (drafts 11-20). `authorization_info` is the decoded string (drafts
 * 07-10), so it is encoded back to the bytes that must be gone.
 */
function declaredSecretsIn(decoded: unknown, into: string[]): void {
  if (Array.isArray(decoded)) {
    for (const item of decoded) declaredSecretsIn(item, into)
    return
  }
  if (decoded === null || typeof decoded !== 'object') return
  const rec = decoded as Record<string, unknown>
  const tv = rec.token_value
  if (typeof tv === 'string' && tv.length > 0) into.push(tv.toLowerCase())
  if (rec.name === 'authorization_info' && typeof rec.value === 'string' && rec.value.length > 0) {
    into.push(toHex(textEncoder.encode(rec.value)))
  }
  for (const v of Object.values(rec)) declaredSecretsIn(v, into)
}

function secretBearingVectors(draft: string): SecretBearing[] {
  const out: SecretBearing[] = []
  for (const { file, data } of loadVectorDir(`transport/draft${draft}/codec/messages`)) {
    for (const vector of data.vectors) {
      if (vector.decoded === undefined || vector.error !== undefined) continue
      const values: string[] = []
      declaredSecretsIn(vector.decoded, values)
      if (values.length > 0) out.push({ file, vector, values })
    }
  }
  return out
}

/**
 * How many credential-bearing vectors each draft's corpus holds today.
 *
 * Pinned rather than checked against a single floor, because the number differs
 * per draft by an order of two and a shared floor would let the thinnest draft
 * silently drop to nothing. If the corpus grows, raise the number; if it
 * shrinks, find out why before lowering it.
 */
const MIN_VECTORS: Readonly<Record<string, number>> = {
  '07': 3,
  '08': 4,
  '09': 4,
  '10': 4,
  '11': 5,
  '12': 6,
  '13': 9,
  '14': 6,
  '15': 4,
  '16': 6,
  '17': 10,
  '18': 11,
  '19': 11,
  '20': 11,
  '21': 11,
}

const DRAFTS = [
  { draft: '07', redact: redact07, decode: decodeMessage07 },
  { draft: '08', redact: redact08, decode: decodeMessage08 },
  { draft: '09', redact: redact09, decode: decodeMessage09 },
  { draft: '10', redact: redact10, decode: decodeMessage10 },
  { draft: '11', redact: redact11, decode: decodeMessage11 },
  { draft: '12', redact: redact12, decode: decodeMessage12 },
  { draft: '13', redact: redact13, decode: decodeMessage13 },
  { draft: '14', redact: redact14, decode: decodeMessage14 },
  { draft: '15', redact: redact15, decode: decodeMessage15 },
  { draft: '16', redact: redact16, decode: decodeMessage16 },
  { draft: '17', redact: redact17, decode: decodeMessage17 },
  { draft: '18', redact: redact18, decode: decodeMessage18 },
  { draft: '19', redact: redact19, decode: decodeMessage19 },
  { draft: '20', redact: redact20, decode: decodeMessage20 },
  { draft: '21', redact: redact21, decode: decodeMessage21 },
].map((d) => ({ ...d, name: `draft-${d.draft}`, vectors: secretBearingVectors(d.draft) }))

describe.each(DRAFTS)('$name corpus', ({ draft, vectors, redact, decode }) => {
  it('finds credential-bearing vectors at all', () => {
    // If the corpus is ever reshaped, this test must fail loudly rather than
    // pass over an empty list — a green suite that asserted nothing is the
    // failure mode this whole file exists to avoid elsewhere.
    expect(vectors.length).toBeGreaterThanOrEqual(MIN_VECTORS[draft] as number)
  })

  it('covers more than one message type', () => {
    expect(new Set(vectors.map((v) => v.file)).size).toBeGreaterThan(1)
  })

  for (const { file, vector, values } of vectors) {
    it(`removes every credential from ${file} / ${vector.id}`, () => {
      const frame = hexToBytes(vector.hex)
      const before = toHex(frame)
      for (const value of values) {
        expect(before, `${file}/${vector.id} declares a value not in its own hex`).toContain(value)
      }

      const r = redact(frame)
      expect(r.incomplete).toBe(false)
      expect(r.redacted).toBe(values.length)

      const after = toHex(r.bytes)
      for (const value of values) {
        expect(after, `${file}/${vector.id} still carries a credential`).not.toContain(value)
      }
      // Length-preserving, and still a message.
      expect(r.bytes.length).toBe(frame.length)
      expect(decode(r.bytes).ok).toBe(true)
    })
  }
})
