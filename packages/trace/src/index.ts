// Binary .moqtrace format
export {
  writeMoqtrace,
  readMoqtrace,
  readMoqtraceHeader,
  createMoqtraceWriter,
} from './binary.js';
export type { MoqtraceWriter } from './binary.js';

// Recorder
export { createRecorder } from './recorder.js';
export type { TraceRecorder } from './recorder.js';

// JSON (convenience)
export { traceToJSON } from './json.js';

// Types
export type {
  Trace,
  TraceHeader,
  TraceEvent,
  ControlMessageEvent,
  StreamOpenedEvent,
  StreamClosedEvent,
  ObjectHeaderEvent,
  ObjectPayloadEvent,
  StateChangeEvent,
  TraceErrorEvent,
  AnnotationEvent,
  DetailLevel,
  Perspective,
  RecorderOptions,
} from './types.js';
