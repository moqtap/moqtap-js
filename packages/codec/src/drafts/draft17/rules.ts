import type { Draft17MessageType } from "./types.js";

// All draft-17 control messages
export const CONTROL_MESSAGES: ReadonlySet<Draft17MessageType> = new Set([
  "setup",
  "subscribe",
  "subscribe_ok",
  "request_update",
  "publish",
  "publish_ok",
  "publish_done",
  "publish_namespace",
  "namespace",
  "namespace_done",
  "subscribe_namespace",
  "publish_blocked",
  "fetch",
  "fetch_ok",
  "track_status",
  "request_ok",
  "request_error",
  "goaway",
]);

// Draft-17 has a single SETUP message — both roles can send it
export const CLIENT_ONLY_MESSAGES: ReadonlySet<Draft17MessageType> = new Set<Draft17MessageType>();

export const SERVER_ONLY_MESSAGES: ReadonlySet<Draft17MessageType> = new Set<Draft17MessageType>();

// Messages that are bidirectional (both client and server can send)
export const BIDIRECTIONAL_MESSAGES: ReadonlySet<Draft17MessageType> = new Set([
  "setup",
  "subscribe",
  "subscribe_ok",
  "request_update",
  "publish",
  "publish_ok",
  "publish_done",
  "publish_namespace",
  "namespace",
  "namespace_done",
  "subscribe_namespace",
  "publish_blocked",
  "fetch",
  "fetch_ok",
  "track_status",
  "request_ok",
  "request_error",
  "goaway",
]);

// Messages legal in each session phase
export function getLegalOutgoing(
  phase: string,
  _role: "client" | "server",
): Set<Draft17MessageType> {
  const legal = new Set<Draft17MessageType>();

  switch (phase) {
    case "idle":
      legal.add("setup");
      break;
    case "setup":
      legal.add("setup");
      break;
    case "ready": {
      for (const msg of BIDIRECTIONAL_MESSAGES) {
        legal.add(msg);
      }
      break;
    }
    case "draining":
      break;
  }

  return legal;
}

export function getLegalIncoming(
  phase: string,
  role: "client" | "server",
): Set<Draft17MessageType> {
  const remoteRole = role === "client" ? "server" : "client";
  return getLegalOutgoing(phase, remoteRole);
}
