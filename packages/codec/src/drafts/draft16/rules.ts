import type { Draft16MessageType } from "./types.js";

// All draft-16 control messages
export const CONTROL_MESSAGES: ReadonlySet<Draft16MessageType> = new Set([
  "client_setup",
  "server_setup",
  "subscribe",
  "subscribe_ok",
  "request_update",
  "unsubscribe",
  "publish",
  "publish_ok",
  "publish_done",
  "publish_namespace",
  "publish_namespace_done",
  "publish_namespace_cancel",
  "subscribe_namespace",
  "namespace",
  "namespace_done",
  "fetch",
  "fetch_ok",
  "fetch_cancel",
  "track_status",
  "request_ok",
  "request_error",
  "goaway",
  "max_request_id",
  "requests_blocked",
]);

// Draft-16 is symmetric: only setup messages are role-restricted.
export const CLIENT_ONLY_MESSAGES: ReadonlySet<Draft16MessageType> = new Set(["client_setup"]);

export const SERVER_ONLY_MESSAGES: ReadonlySet<Draft16MessageType> = new Set(["server_setup"]);

// Messages that are bidirectional (both client and server can send)
export const BIDIRECTIONAL_MESSAGES: ReadonlySet<Draft16MessageType> = new Set([
  "subscribe",
  "subscribe_ok",
  "request_update",
  "unsubscribe",
  "publish",
  "publish_ok",
  "publish_done",
  "publish_namespace",
  "publish_namespace_done",
  "publish_namespace_cancel",
  "subscribe_namespace",
  "namespace",
  "namespace_done",
  "fetch",
  "fetch_ok",
  "fetch_cancel",
  "track_status",
  "request_ok",
  "request_error",
  "goaway",
  "max_request_id",
  "requests_blocked",
]);

// Messages legal in each session phase -- for outbound validation
export function getLegalOutgoing(
  phase: string,
  role: "client" | "server",
): Set<Draft16MessageType> {
  const legal = new Set<Draft16MessageType>();

  switch (phase) {
    case "idle":
      if (role === "client") legal.add("client_setup");
      break;
    case "setup":
      if (role === "server") legal.add("server_setup");
      break;
    case "ready": {
      legal.add("goaway");
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
): Set<Draft16MessageType> {
  const remoteRole = role === "client" ? "server" : "client";
  return getLegalOutgoing(phase, remoteRole);
}
