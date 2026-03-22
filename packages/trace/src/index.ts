// Binary .moqtrace format

export type { MoqtraceWriter } from "./binary.js";
export {
  createMoqtraceWriter,
  readMoqtrace,
  readMoqtraceHeader,
  writeMoqtrace,
} from "./binary.js";
// JSON (convenience)
export { traceToJSON } from "./json.js";
export type { TraceRecorder } from "./recorder.js";
// Recorder
export { createRecorder } from "./recorder.js";

// Types
export type {
  AnnotationEvent,
  ControlMessageEvent,
  DetailLevel,
  ObjectHeaderEvent,
  ObjectPayloadEvent,
  Perspective,
  RecorderOptions,
  StateChangeEvent,
  StreamClosedEvent,
  StreamOpenedEvent,
  Trace,
  TraceErrorEvent,
  TraceEvent,
  TraceHeader,
} from "./types.js";
