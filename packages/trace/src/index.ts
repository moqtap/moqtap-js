// Binary .moqtrace format

export type { MoqtraceWriter, ReadOptions, RecoveredRegion } from './binary.js'
export {
  createMoqtraceWriter,
  FORMAT_VERSION,
  MalformedHeaderError,
  readMoqtrace,
  readMoqtraceHeader,
  readMoqtraceSegments,
  SUPPORTED_VERSIONS,
  TruncatedTraceError,
  writeMoqtrace,
  writeMoqtraceSegments,
} from './binary.js'
// JSON (convenience)
export { traceToJSON } from './json.js'
// Incremental reader, for a stream that arrives in pieces
export type { MoqtraceReader, ReadItem } from './reader.js'
export { createMoqtraceReader, TruncatedStreamError } from './reader.js'
export type { ErrorDetails, TraceRecorder } from './recorder.js'
// Recorder
export { createRecorder, MAX_ERROR_RAW_BYTES } from './recorder.js'

// Types
export type {
  AnnotationEvent,
  ControlMessageEvent,
  DerivationKind,
  DetailLevel,
  DropPolicy,
  ErrorKind,
  ObjectHeaderEvent,
  ObjectPayloadEvent,
  PeerConnectedEvent,
  PeerDisconnectedEvent,
  PeerRole,
  Perspective,
  RecorderOptions,
  SamplingInfo,
  SegmentInfo,
  Side,
  StateChangeEvent,
  StreamClosedEvent,
  StreamOpenedEvent,
  SubscriptionDerivationEvent,
  SubscriptionRef,
  Trace,
  TraceErrorEvent,
  TraceEvent,
  TraceHeader,
  UnknownEvent,
} from './types.js'
export { controlMessageFields, TRACE_ID_LENGTH } from './types.js'
