import type { MoqtMessageType } from "../../core/types.js";

export const CONTROL_MESSAGES: ReadonlySet<MoqtMessageType> = new Set([
  "client_setup",
  "server_setup",
  "subscribe",
  "subscribe_ok",
  "subscribe_error",
  "subscribe_done",
  "subscribe_update",
  "unsubscribe",
  "announce",
  "announce_ok",
  "announce_error",
  "announce_cancel",
  "unannounce",
  "track_status_request",
  "track_status",
  "goaway",
  "subscribe_announces",
  "subscribe_announces_ok",
  "subscribe_announces_error",
  "unsubscribe_announces",
  "max_subscribe_id",
  "fetch",
  "fetch_ok",
  "fetch_error",
  "fetch_cancel",
]);

export const DATA_MESSAGES: ReadonlySet<MoqtMessageType> = new Set([
  "object_stream",
  "object_datagram",
  "stream_header_track",
  "stream_header_group",
  "stream_header_subgroup",
]);

// Messages that only a client can send
export const CLIENT_ONLY_MESSAGES: ReadonlySet<MoqtMessageType> = new Set([
  "client_setup",
  "subscribe",
  "subscribe_update",
  "unsubscribe",
  "announce",
  "unannounce",
  "subscribe_announces",
  "unsubscribe_announces",
  "fetch",
  "fetch_cancel",
  "track_status_request",
]);

// Messages that only a server can send
export const SERVER_ONLY_MESSAGES: ReadonlySet<MoqtMessageType> = new Set([
  "server_setup",
  "subscribe_ok",
  "subscribe_error",
  "subscribe_done",
  "announce_ok",
  "announce_error",
  "announce_cancel",
  "subscribe_announces_ok",
  "subscribe_announces_error",
  "max_subscribe_id",
  "fetch_ok",
  "fetch_error",
  "track_status",
  "goaway",
]);

// Messages legal in each session phase -- for outbound validation
export function getLegalOutgoing(phase: string, role: "client" | "server"): Set<MoqtMessageType> {
  const legal = new Set<MoqtMessageType>();

  switch (phase) {
    case "idle":
      if (role === "client") legal.add("client_setup");
      break;
    case "setup":
      if (role === "server") legal.add("server_setup");
      break;
    case "ready": {
      const roleMessages = role === "client" ? CLIENT_ONLY_MESSAGES : SERVER_ONLY_MESSAGES;
      for (const msg of roleMessages) {
        if (msg !== "client_setup" && msg !== "server_setup") {
          legal.add(msg);
        }
      }
      break;
    }
    case "draining":
      // Limited set during draining - can still finish active operations
      break;
  }

  return legal;
}

export function getLegalIncoming(phase: string, role: "client" | "server"): Set<MoqtMessageType> {
  // Incoming from remote = the other role's outgoing
  const remoteRole = role === "client" ? "server" : "client";
  return getLegalOutgoing(phase, remoteRole);
}
