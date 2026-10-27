/**
 * Compile-time checks for the accessors' parameter and return types.
 *
 * Listed in this package's tsconfig `files`, so `tsc --build` typechecks it
 * even though the other tests are excluded. Every draft's decoded message must
 * be accepted as it is, without a copy or a cast.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  createCodec,
  joiningRequestIdOf,
  requestIdOf,
  type TrackIdentity,
  trackAliasOf,
  trackOf,
} from '../index.js'

const codecs = [
  createCodec({ draft: '07' }),
  createCodec({ draft: '08' }),
  createCodec({ draft: '09' }),
  createCodec({ draft: '10' }),
  createCodec({ draft: '11' }),
  createCodec({ draft: '12' }),
  createCodec({ draft: '13' }),
  createCodec({ draft: '14' }),
  createCodec({ draft: '15' }),
  createCodec({ draft: '16' }),
  createCodec({ draft: '17' }),
  createCodec({ draft: '18' }),
  createCodec({ draft: '19' }),
  createCodec({ draft: '20' }),
  createCodec({ draft: '21' }),
  createCodec({ draft: '22' }),
] as const

describe('accessor types', () => {
  it('accept every draft decoded message directly', () => {
    for (const codec of codecs) {
      const decoded = codec.decodeMessage(new Uint8Array())
      if (!decoded.ok) continue
      expectTypeOf(requestIdOf(decoded.value)).toEqualTypeOf<bigint | undefined>()
      expectTypeOf(trackAliasOf(decoded.value)).toEqualTypeOf<bigint | undefined>()
      expectTypeOf(trackOf(decoded.value)).toEqualTypeOf<TrackIdentity | undefined>()
      expectTypeOf(joiningRequestIdOf(decoded.value)).toEqualTypeOf<bigint | undefined>()
    }
  })

  it('accept a plain record, such as a message read from a trace', () => {
    const record: Readonly<Record<string, unknown>> = { trackAlias: 9n }
    expectTypeOf(trackAliasOf(record)).toEqualTypeOf<bigint | undefined>()
    // @ts-expect-error - a primitive is not a message
    expect(requestIdOf(42n)).toBeUndefined()
  })
})
