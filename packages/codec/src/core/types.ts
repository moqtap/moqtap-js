// Draft identifiers
export type Draft =
  | '07'
  | '08'
  | '09'
  | '10'
  | '11'
  | '12'
  | '13'
  | '14'
  | '15'
  | '16'
  | '17'
  | '18'
  | '19'
  | '20'
  | '21'
  | '22'
  | '23'

// Base codec interface — draft-specific codecs extend this
export interface BaseCodec<M> {
  readonly draft: Draft
  encodeMessage(message: M): Uint8Array
  decodeMessage(bytes: Uint8Array): DecodeResult<M>
}

export interface CodecOptions {
  draft: Draft
}

// Result types
export type DecodeResult<T> =
  | { ok: true; value: T; bytesRead: number }
  | { ok: false; error: DecodeError }

export type DecodeErrorCode =
  | 'UNEXPECTED_END'
  | 'INVALID_VARINT'
  | 'UNKNOWN_MESSAGE_TYPE'
  | 'INVALID_PARAMETER'
  | 'CONSTRAINT_VIOLATION'

export class DecodeError extends Error {
  readonly code: DecodeErrorCode
  readonly offset: number
  /**
   * The session termination code the draft names for this failure. Set by
   * draft modules whose decoder names one; undefined otherwise, and for an
   * `UNEXPECTED_END` that only means more bytes are needed.
   */
  readonly closeCode?: bigint

  constructor(code: DecodeErrorCode, message: string, offset: number, closeCode?: bigint) {
    super(message)
    this.name = 'DecodeError'
    this.code = code
    this.offset = offset
    if (closeCode !== undefined) this.closeCode = closeCode
  }
}
