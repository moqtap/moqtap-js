/** Convert a Uint8Array to a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    hex += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return hex;
}

/** Convert a hex string to a Uint8Array. */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
