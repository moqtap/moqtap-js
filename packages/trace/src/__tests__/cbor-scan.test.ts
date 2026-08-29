import { Encoder } from 'cbor-x'
import { describe, expect, it } from 'vitest'
import { cborItemLength, MalformedCborError } from '../cbor-scan.js'

const codec = new Encoder({ useRecords: false, mapsAsObjects: true })
const encode = (value: unknown): Uint8Array => codec.encode(value)

/**
 * The scanner and the encoder must agree on where an item ends. Checking the
 * measured length against the encoder's own output is the only comparison
 * that can catch the scanner mis-measuring a shape: a hand-written expected
 * length would just be the same arithmetic done twice.
 */
function expectMeasuresWholeItem(value: unknown): void {
  const bytes = encode(value)
  expect(cborItemLength(bytes, 0), `measuring ${JSON.stringify(String(value))}`).toBe(bytes.length)
}

describe('cborItemLength', () => {
  describe('agrees with the encoder on one item', () => {
    const cases: [string, unknown][] = [
      ['zero', 0],
      ['small uint', 23],
      ['one-byte uint', 24],
      ['two-byte uint', 1000],
      ['four-byte uint', 1_000_000],
      ['eight-byte uint', 2n ** 40n],
      ['negative', -500],
      ['float', 1.5],
      ['true', true],
      ['false', false],
      ['null', null],
      ['empty string', ''],
      ['short string', 'moqtrace'],
      ['long string', 'x'.repeat(300)],
      ['empty array', []],
      ['array of ints', [1, 2, 3]],
      ['nested array', [[1, [2, [3]]]]],
      ['empty map', {}],
      ['flat map', { a: 1, b: 'two' }],
      ['nested map', { a: { b: { c: [1, 2, { d: null }] } } }],
      ['bytes', new Uint8Array([1, 2, 3, 4])],
      ['long bytes', new Uint8Array(500)],
      ['map with byte values', { raw: new Uint8Array(40), n: 7 }],
      ['array of 30 items', Array.from({ length: 30 }, (_, i) => i)],
      ['map of 30 keys', Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]))],
    ]

    for (const [name, value] of cases) {
      it(name, () => {
        expectMeasuresWholeItem(value)
      })
    }
  })

  it('measures only the first item in a sequence', () => {
    const first = encode({ n: 0, t: 1 })
    const second = encode({ n: 1, t: 2 })
    const sequence = new Uint8Array(first.length + second.length)
    sequence.set(first, 0)
    sequence.set(second, first.length)

    expect(cborItemLength(sequence, 0)).toBe(first.length)
    expect(cborItemLength(sequence, first.length)).toBe(second.length)
  })

  it('reports an item that runs past the end as incomplete', () => {
    const bytes = encode({ label: 'a reasonably long annotation label', n: 3 })
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(cborItemLength(bytes.subarray(0, cut), 0), `cut at ${cut}`).toBeNull()
    }
    expect(cborItemLength(bytes, 0)).toBe(bytes.length)
  })

  it('reports an empty buffer as incomplete rather than zero-length', () => {
    expect(cborItemLength(new Uint8Array(0), 0)).toBeNull()
  })

  it('measures indefinite-length containers', () => {
    // cbor-x writes definite lengths, so these are hand-built: a reader has to
    // cope with an encoder that chose otherwise.
    const indefiniteArray = new Uint8Array([0x9f, 0x01, 0x02, 0xff])
    expect(cborItemLength(indefiniteArray, 0)).toBe(4)

    const indefiniteMap = new Uint8Array([0xbf, 0x61, 0x61, 0x01, 0xff])
    expect(cborItemLength(indefiniteMap, 0)).toBe(5)

    // Indefinite text string: two chunks then a break.
    const indefiniteText = new Uint8Array([0x7f, 0x61, 0x61, 0x61, 0x62, 0xff])
    expect(cborItemLength(indefiniteText, 0)).toBe(6)
  })

  it('rejects reserved additional information', () => {
    // 0x1c..0x1e are reserved; a decoder that guessed a length here would
    // resynchronize onto whatever followed and call it data.
    for (const initial of [0x1c, 0x1d, 0x1e]) {
      expect(() => cborItemLength(new Uint8Array([initial, 0, 0, 0]), 0)).toThrow(
        MalformedCborError,
      )
    }
  })

  it('rejects a break where no indefinite item is open', () => {
    expect(() => cborItemLength(new Uint8Array([0xff]), 0)).toThrow(MalformedCborError)
  })

  it('names the offset it failed at', () => {
    // The offset is what a caller needs to skip the damage or report it.
    const bytes = new Uint8Array([0x82, 0x01, 0x1c])
    try {
      cborItemLength(bytes, 0)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedCborError)
      expect((error as MalformedCborError).offset).toBe(2)
    }
  })
})
