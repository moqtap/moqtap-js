/**
 * The relay endpoint a connection names in capture contract bodies: scheme,
 * host, port and path, normalised as ingest normalises them, so a viewer and
 * a source on the same relay URL name the same endpoint. Query, fragment and
 * userinfo never leave the device: they can carry a token.
 */

const RELAY_SCHEMES = new Set(['https:', 'http:', 'moqt:'])
const MAX_RELAY_URL = 2048
/** An escape, or a character a path does not keep as it is. */
const PATH_ESCAPE = /%[0-9A-Fa-f]{2}|[^A-Za-z0-9._~!$&'()*+,;=:@/-]/g
const UNRESERVED = /^[A-Za-z0-9._~-]$/

/**
 * The endpoint of the URL a transport was opened with, or `''` when it is not
 * a relay URL. The URL parser lowercases the host, writes it in punycode
 * (for every scheme, as an `https` host), drops the default port and removes
 * dot segments; then escapes are written in uppercase hex, an escaped
 * unreserved character is decoded, any other character outside RFC 3986's
 * path set is escaped (a `%` that starts no escape is `%25`), and the root is
 * written as no path.
 */
export function relayOf(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return ''
  }
  if (!RELAY_SCHEMES.has(u.protocol)) return ''
  const host = hostOf(u)
  if (host === '') return ''
  const path = u.pathname.replace(PATH_ESCAPE, (m) => {
    if (m.length === 1) return m === '%' ? '%25' : `%${m.charCodeAt(0).toString(16).toUpperCase()}`
    const c = String.fromCharCode(Number.parseInt(m.slice(1), 16))
    return UNRESERVED.test(c) ? c : m.toUpperCase()
  })
  const port = u.port === '' ? '' : `:${u.port}`
  const out = `${u.protocol}//${host}${port}${path === '/' ? '' : path}`
  return out.length > MAX_RELAY_URL ? '' : out
}

/** A `moqt:` host is opaque to the URL parser, which escapes it instead of writing punycode. */
function hostOf(u: URL): string {
  try {
    const raw = u.protocol === 'moqt:' ? decodeURIComponent(u.hostname) : u.hostname
    return raw === '' ? '' : new URL(`https://${raw}/`).hostname
  } catch {
    return ''
  }
}
