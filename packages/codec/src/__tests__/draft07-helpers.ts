/**
 * Helpers for converting between draft-07 codec types and test vector JSON format.
 *
 * Draft-07 codec uses camelCase fields, Map<bigint, Uint8Array> for params,
 * string enums for filterType/groupOrder, and booleans for contentExists/endOfTrack.
 *
 * Test vectors use snake_case fields, named params, numeric values for everything.
 */

import { BufferReader } from '../core/buffer-reader.js';

// Draft-07 parameter type IDs
const PARAM_ROLE = 0x00n;
const PARAM_PATH = 0x01n;
// 0x02 is context-dependent:
//   Setup messages: MAX_SUBSCRIBE_ID (varint)
//   Everything else: AUTHORIZATION_INFO (string)
const PARAM_02 = 0x02n;
const PARAM_DELIVERY_TIMEOUT = 0x03n;

const SETUP_MESSAGE_TYPES = new Set(['client_setup', 'server_setup']);

const GROUP_ORDER_MAP: Record<string, string> = {
  original: '0',
  ascending: '1',
  descending: '2',
};

const FILTER_TYPE_MAP: Record<string, string> = {
  latest_group: '1',
  latest_object: '2',
  absolute_start: '3',
  absolute_range: '4',
};

/**
 * Convert a Map<bigint, Uint8Array> params to the named-param format used by test vectors.
 * The `msgType` is needed because param ID 0x02 is context-dependent.
 */
function normalizeParams(params: Map<bigint, Uint8Array>, msgType: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const isSetup = SETUP_MESSAGE_TYPES.has(msgType);

  for (const [key, value] of params) {
    if (key === PARAM_ROLE) {
      const reader = new BufferReader(value);
      result['role'] = reader.readVarInt().toString();
    } else if (key === PARAM_PATH) {
      result['path'] = new TextDecoder().decode(value);
    } else if (key === PARAM_02) {
      if (isSetup) {
        const reader = new BufferReader(value);
        result['max_subscribe_id'] = reader.readVarInt().toString();
      } else {
        result['authorization_info'] = new TextDecoder().decode(value);
      }
    } else if (key === PARAM_DELIVERY_TIMEOUT) {
      const reader = new BufferReader(value);
      result['delivery_timeout'] = reader.readVarInt().toString();
    } else {
      if (!result['unknown']) result['unknown'] = [];
      (result['unknown'] as Array<unknown>).push({
        id: '0x' + key.toString(16),
        length: value.byteLength,
        raw_hex: bytesToHex(value),
      });
    }
  }

  return result;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    hex += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Normalize a decoded MoqtMessage into the test vector JSON format.
 */
export function normalizeDraft07Message(msg: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const msgType = msg['type'] as string;

  for (const [key, value] of Object.entries(msg)) {
    if (key === 'type') continue;

    const snakeKey = camelToSnake(key);

    if (key === 'filterType') {
      result['filter_type'] = FILTER_TYPE_MAP[value as string] ?? String(value);
    } else if (key === 'groupOrder') {
      result['group_order'] = GROUP_ORDER_MAP[value as string] ?? String(value);
    } else if (key === 'contentExists') {
      result['content_exists'] = (value as boolean) ? '1' : '0';
    } else if (key === 'endOfTrack') {
      result['end_of_track'] = (value as boolean) ? '1' : '0';
    } else if (key === 'subscriberPriority' || key === 'publisherPriority') {
      result[snakeKey] = String(value);
    } else if (key === 'parameters' && value instanceof Map) {
      result['parameters'] = normalizeParams(value as Map<bigint, Uint8Array>, msgType);
    } else if (typeof value === 'bigint') {
      result[snakeKey] = value.toString();
    } else if (Array.isArray(value)) {
      result[snakeKey] = value.map(item =>
        typeof item === 'bigint' ? item.toString() : item,
      );
    } else if (value instanceof Uint8Array) {
      result[snakeKey] = bytesToHex(value);
    } else {
      result[snakeKey] = value;
    }
  }

  // subscribe_done: our codec uses finalGroupId/finalObjectId,
  // test vectors use final_group/final_object
  if (result['final_group_id'] !== undefined) {
    result['final_group'] = result['final_group_id'];
    delete result['final_group_id'];
  }
  if (result['final_object_id'] !== undefined) {
    result['final_object'] = result['final_object_id'];
    delete result['final_object_id'];
  }

  // subscribe_announces uses trackNamespace but test vectors say track_namespace_prefix
  if (
    (msgType === 'subscribe_announces' ||
      msgType === 'subscribe_announces_ok' ||
      msgType === 'subscribe_announces_error' ||
      msgType === 'unsubscribe_announces') &&
    result['track_namespace'] !== undefined
  ) {
    result['track_namespace_prefix'] = result['track_namespace'];
    delete result['track_namespace'];
  }

  return result;
}

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
}
