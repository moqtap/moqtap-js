// Binary .moqtrace format

export type { MoqtraceWriter, ReadOptions } from './binary.js'
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
export type { TraceRecorder } from './recorder.js'
// Recorder
export { createRecorder } from './recorder.js'

// Types
export type {
  AnnotationEvent,
  ControlMessageEvent,
  DerivationKind,
  DetailLevel,
  DropPolicy,
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
