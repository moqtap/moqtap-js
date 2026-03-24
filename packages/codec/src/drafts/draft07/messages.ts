// MoQT draft-ietf-moq-transport-07 message type IDs (wire format)
export const MESSAGE_TYPE_IDS = {
  // Control messages (on control stream)
  subscribe_update: 0x02n,
  subscribe: 0x03n,
  subscribe_ok: 0x04n,
  subscribe_error: 0x05n,
  announce: 0x06n,
  announce_ok: 0x07n,
  announce_error: 0x08n,
  unannounce: 0x09n,
  unsubscribe: 0x0an,
  subscribe_done: 0x0bn,
  announce_cancel: 0x0cn,
  track_status_request: 0x0dn,
  track_status: 0x0en,
  goaway: 0x10n,
  subscribe_announces: 0x11n,
  subscribe_announces_ok: 0x12n,
  subscribe_announces_error: 0x13n,
  unsubscribe_announces: 0x14n,
  max_subscribe_id: 0x15n,
  fetch: 0x16n,
  fetch_cancel: 0x17n,
  fetch_ok: 0x18n,
  fetch_error: 0x19n,
  client_setup: 0x40n,
  server_setup: 0x41n,
  // Data stream messages (Section 7, Table 5)
  object_datagram: 0x01n,
  stream_header_subgroup: 0x04n, // Note: same ID as subscribe_ok but used on data streams, context disambiguates
  fetch_header: 0x05n, // Note: same ID as subscribe_error but used on data streams, context disambiguates
} as const;

// Reverse map: wire ID -> message type name
export const MESSAGE_ID_TO_TYPE = new Map<bigint, string>();
for (const [name, id] of Object.entries(MESSAGE_TYPE_IDS)) {
  // For duplicate IDs, control stream messages take priority in the reverse map
  if (!MESSAGE_ID_TO_TYPE.has(id) || name !== "stream_header_subgroup") {
    MESSAGE_ID_TO_TYPE.set(id, name);
  }
}
