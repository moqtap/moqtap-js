import type { MoqtMessage, MoqtMessageType } from "@moqtap/codec";
import type { SessionPhase, SessionState, TransitionResult } from "@moqtap/codec/session";
import { describe, expect, it } from "vitest";
import { createRecorder } from "../recorder.js";

function createMockSession(initialPhase: SessionPhase = "idle"): SessionState {
  let phase: SessionPhase = initialPhase;
  return {
    get phase() {
      return phase;
    },
    get role() {
      return "client" as const;
    },
    get subscriptions() {
      return new Map();
    },
    get announces() {
      return new Map();
    },
    get legalOutgoing() {
      return new Set<MoqtMessageType>();
    },
    get legalIncoming() {
      return new Set<MoqtMessageType>();
    },
    receive(_msg: MoqtMessage): TransitionResult {
      if (phase === "idle") phase = "setup";
      else if (phase === "setup") phase = "ready";
      return { ok: true, phase, sideEffects: [] };
    },
    validateOutgoing(_msg: MoqtMessage) {
      return { ok: true as const };
    },
    send(_msg: MoqtMessage): TransitionResult {
      if (phase === "idle") phase = "setup";
      else if (phase === "setup") phase = "ready";
      return { ok: true, phase, sideEffects: [] };
    },
    reset() {
      phase = "idle";
    },
  };
}

// Minimal valid messages for type-safety
const serverSetup: MoqtMessage = {
  type: "server_setup",
  selectedVersion: 0xff000007n,
  parameters: new Map(),
};

const clientSetup: MoqtMessage = {
  type: "client_setup",
  supportedVersions: [0xff000007n],
  parameters: new Map(),
};

describe("TraceRecorder", () => {
  it("records control messages on receive", () => {
    let tick = 0;
    const recorder = createRecorder({
      detail: "control",
      protocol: "moq-transport-14",
      perspective: "client",
      clock: () => tick++,
    });
    const wrapped = recorder.wrapSession(createMockSession());
    wrapped.receive(serverSetup);

    const trace = recorder.finalize();
    const controlEvents = trace.events.filter((e) => e.type === "control");
    expect(controlEvents).toHaveLength(1);
    const e = controlEvents[0]!;
    if (e.type === "control") {
      expect(e.direction).toBe(1); // rx
    }
  });

  it("records control messages on send", () => {
    let tick = 0;
    const recorder = createRecorder({
      detail: "control",
      protocol: "moq-transport-14",
      perspective: "client",
      clock: () => tick++,
    });
    const wrapped = recorder.wrapSession(createMockSession());
    wrapped.send(clientSetup);

    const trace = recorder.finalize();
    const controlEvents = trace.events.filter((e) => e.type === "control");
    expect(controlEvents).toHaveLength(1);
    const e = controlEvents[0]!;
    if (e.type === "control") {
      expect(e.direction).toBe(0); // tx
    }
  });

  it("records state-change events on phase transition", () => {
    let tick = 0;
    const recorder = createRecorder({
      detail: "control",
      protocol: "moq-transport-14",
      perspective: "client",
      clock: () => tick++,
    });
    const wrapped = recorder.wrapSession(createMockSession("idle"));
    wrapped.receive(serverSetup); // idle → setup

    const trace = recorder.finalize();
    const stateChanges = trace.events.filter((e) => e.type === "state-change");
    expect(stateChanges).toHaveLength(1);
    const e = stateChanges[0]!;
    if (e.type === "state-change") {
      expect(e.from).toBe("idle");
      expect(e.to).toBe("setup");
    }
  });

  it("assigns monotonically increasing sequence numbers", () => {
    let tick = 0;
    const recorder = createRecorder({
      detail: "control",
      protocol: "moq-transport-14",
      perspective: "client",
      clock: () => tick++,
    });
    const wrapped = recorder.wrapSession(createMockSession());

    wrapped.send(clientSetup);
    wrapped.receive(serverSetup);
    recorder.annotate("test", null);

    const trace = recorder.finalize();
    const seqs = trace.events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it("detail level filters stream events at control level", () => {
    const recorder = createRecorder({
      detail: "control",
      protocol: "moq-transport-14",
      perspective: "client",
      clock: () => 0,
    });

    recorder.recordStreamOpened(1n, 0, 0);
    recorder.recordStreamClosed(1n, 0);
    recorder.recordObjectHeader(1n, 0n, 0n, 128, 0);
    recorder.recordObjectPayload(1n, 0n, 0n, 100);

    const trace = recorder.finalize();
    expect(trace.events).toHaveLength(0);
  });

  it("detail level includes stream events at headers level", () => {
    const recorder = createRecorder({
      detail: "headers",
      protocol: "moq-transport-14",
      perspective: "client",
      clock: () => 0,
    });

    recorder.recordStreamOpened(1n, 0, 0);
    recorder.recordObjectHeader(1n, 0n, 0n, 128, 0);
    recorder.recordStreamClosed(1n, 0);

    const trace = recorder.finalize();
    expect(trace.events).toHaveLength(3);
    expect(trace.events.map((e) => e.type)).toEqual([
      "stream-opened",
      "object-header",
      "stream-closed",
    ]);
  });

  it("detail level filters payload events below headers+sizes", () => {
    const recorder = createRecorder({
      detail: "headers",
      protocol: "moq-transport-14",
      perspective: "client",
      clock: () => 0,
    });

    recorder.recordObjectPayload(1n, 0n, 0n, 100, new Uint8Array([1, 2, 3]));

    const trace = recorder.finalize();
    expect(trace.events).toHaveLength(0);
  });

  it("headers+sizes includes payload size but not bytes", () => {
    const recorder = createRecorder({
      detail: "headers+sizes",
      protocol: "moq-transport-14",
      perspective: "client",
      clock: () => 0,
    });

    recorder.recordObjectPayload(1n, 0n, 0n, 100, new Uint8Array([1, 2, 3]));

    const trace = recorder.finalize();
    expect(trace.events).toHaveLength(1);
    const e = trace.events[0]!;
    if (e.type === "object-payload") {
      expect(e.size).toBe(100);
      expect(e.payload).toBeUndefined();
    }
  });

  it("headers+data includes payload bytes", () => {
    const recorder = createRecorder({
      detail: "headers+data",
      protocol: "moq-transport-14",
      perspective: "client",
      clock: () => 0,
    });

    const payload = new Uint8Array([0xde, 0xad]);
    recorder.recordObjectPayload(1n, 0n, 0n, 2, payload);

    const trace = recorder.finalize();
    expect(trace.events).toHaveLength(1);
    const e = trace.events[0]!;
    if (e.type === "object-payload") {
      expect(e.payload).toEqual(payload);
    }
  });

  it("error events are always recorded", () => {
    const recorder = createRecorder({
      detail: "control",
      protocol: "moq-transport-14",
      perspective: "client",
      clock: () => 0,
    });

    recorder.recordError(1, "Protocol violation");

    const trace = recorder.finalize();
    expect(trace.events).toHaveLength(1);
    const e = trace.events[0]!;
    if (e.type === "error") {
      expect(e.errorCode).toBe(1);
      expect(e.reason).toBe("Protocol violation");
    }
  });

  it("annotation events are always recorded", () => {
    const recorder = createRecorder({
      detail: "control",
      protocol: "moq-transport-14",
      perspective: "client",
      clock: () => 0,
    });

    recorder.annotate("my-label", { key: "value" });

    const trace = recorder.finalize();
    expect(trace.events).toHaveLength(1);
    const e = trace.events[0]!;
    if (e.type === "annotation") {
      expect(e.label).toBe("my-label");
      expect(e.data).toEqual({ key: "value" });
    }
  });

  it("respects maxEvents circular buffer", () => {
    const recorder = createRecorder({
      detail: "control",
      protocol: "moq-transport-14",
      perspective: "client",
      maxEvents: 3,
      clock: () => 0,
    });

    recorder.annotate("a", null);
    recorder.annotate("b", null);
    recorder.annotate("c", null);
    recorder.annotate("d", null);
    recorder.annotate("e", null);

    const trace = recorder.finalize();
    expect(trace.events).toHaveLength(3);
    const labels = trace.events.map((e) => (e.type === "annotation" ? e.label : ""));
    expect(labels).toEqual(["c", "d", "e"]);
  });

  it("stops recording after finalize", () => {
    const recorder = createRecorder({
      detail: "control",
      protocol: "moq-transport-14",
      perspective: "client",
      clock: () => 0,
    });

    recorder.annotate("before", null);
    const trace = recorder.finalize();

    expect(recorder.recording).toBe(false);
    recorder.annotate("after", null);
    expect(trace.events).toHaveLength(1);
  });

  it("record() inserts arbitrary events directly", () => {
    const recorder = createRecorder({
      detail: "control",
      protocol: "moq-transport-14",
      perspective: "observer",
      clock: () => 0,
    });

    recorder.record({
      type: "control",
      seq: 99,
      timestamp: 12345,
      direction: 1,
      messageType: 0x03,
      message: { type: "subscribe" },
    });

    const trace = recorder.finalize();
    expect(trace.events).toHaveLength(1);
    expect(trace.events[0]?.seq).toBe(99);
    expect(trace.events[0]?.timestamp).toBe(12345);
  });

  it("finalize produces correct header metadata", () => {
    const recorder = createRecorder({
      detail: "headers",
      protocol: "moq-transport-07",
      perspective: "server",
      transport: "webtransport",
      source: "test-suite/1.0",
      endpoint: "https://example.com/moq",
      sessionId: "sess-001",
      clock: () => 0,
    });

    const trace = recorder.finalize();
    expect(trace.header.protocol).toBe("moq-transport-07");
    expect(trace.header.perspective).toBe("server");
    expect(trace.header.detail).toBe("headers");
    expect(trace.header.transport).toBe("webtransport");
    expect(trace.header.source).toBe("test-suite/1.0");
    expect(trace.header.endpoint).toBe("https://example.com/moq");
    expect(trace.header.sessionId).toBe("sess-001");
    expect(trace.header.startTime).toBeGreaterThan(0);
    expect(trace.header.endTime).toBeGreaterThanOrEqual(trace.header.startTime);
  });
});
