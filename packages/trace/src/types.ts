export type DetailLevel = 'control' | 'headers' | 'headers+sizes' | 'headers+data' | 'full'
export type Perspective = 'client' | 'server' | 'observer'

export interface TraceHeader {
  readonly protocol: string
  readonly perspective: Perspective
  readonly detail: DetailLevel
  readonly startTime: number
  readonly endTime?: number
  readonly transport?: string
  readonly source?: string
  readonly endpoint?: string
  readonly sessionId?: string
  readonly custom?: Record<string, unknown>
}

interface BaseEvent {
  readonly seq: number
  readonly timestamp: number
}

export interface ControlMessageEvent extends BaseEvent {
  readonly type: 'control'
  readonly direction: 0 | 1
  readonly messageType: number
  readonly message: Record<string, unknown>
  readonly raw?: Uint8Array
}

export interface StreamOpenedEvent extends BaseEvent {
  readonly type: 'stream-opened'
  readonly streamId: bigint
  readonly direction: 0 | 1
  readonly streamType: 0 | 1 | 2
}

export interface StreamClosedEvent extends BaseEvent {
  readonly type: 'stream-closed'
  readonly streamId: bigint
  readonly errorCode: number
}

export interface ObjectHeaderEvent extends BaseEvent {
  readonly type: 'object-header'
  readonly streamId: bigint
  readonly groupId: bigint
  readonly objectId: bigint
  readonly publisherPriority: number
  readonly objectStatus: number
}

export interface ObjectPayloadEvent extends BaseEvent {
  readonly type: 'object-payload'
  readonly streamId: bigint
  readonly groupId: bigint
  readonly objectId: bigint
  readonly size: number
  readonly payload?: Uint8Array
}

export interface StateChangeEvent extends BaseEvent {
  readonly type: 'state-change'
  readonly from: string
  readonly to: string
}

export interface TraceErrorEvent extends BaseEvent {
  readonly type: 'error'
  readonly errorCode: number
  readonly reason: string
}

export interface AnnotationEvent extends BaseEvent {
  readonly type: 'annotation'
  readonly label: string
  readonly data: unknown
}

export type TraceEvent =
  | ControlMessageEvent
  | StreamOpenedEvent
  | StreamClosedEvent
  | ObjectHeaderEvent
  | ObjectPayloadEvent
  | StateChangeEvent
  | TraceErrorEvent
  | AnnotationEvent

export interface Trace {
  readonly header: TraceHeader
  readonly events: TraceEvent[]
}

export interface RecorderOptions {
  readonly detail: DetailLevel
  readonly protocol: string
  readonly perspective: Perspective
  readonly transport?: string
  readonly source?: string
  readonly endpoint?: string
  readonly sessionId?: string
  readonly maxEvents?: number
  readonly clock?: () => number
  /** Map message type name (e.g. 'subscribe') to wire ID (e.g. 0x03). Required for session-layer recording. */
  readonly messageTypeId?: (name: string) => number
}
