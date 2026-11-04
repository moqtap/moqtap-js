/**
 * The relay endpoint a connection names in capture contract bodies: scheme,
 * host, port and path, written as ingest writes them, so a viewer and a
 * source on the same relay URL name the same endpoint. Query, fragment and
 * userinfo never leave the device: they can carry a token.
 */

const RELAY_SCHEMES = new Set(['https:', 'http:', 'moqt:'])
const MAX_RELAY_URL = 2048
/** RFC 3986 path-abempty: `/`-led segments of pchars and escapes. */
const PATH_ABEMPTY = /^(?:\/(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})*)*$/

/**
 * The endpoint of the URL a transport was opened with, or `''` when it is not
 * a relay URL. The URL parser lowercases the host and writes it in punycode
 * (for every scheme, as an `https` host) and drops an `https` or `http`
 * default port; a `moqt` port of 443 is dropped too, the scheme's default
 * (draft-23 Section 6.1.2). The path is kept exactly as the connection sends
 * it: for `https` and `http` the URL parser's, which WebTransport sends (an
 * empty path is `/`); for `moqt` the URL's own path-abempty
 * (draft-23 Section 9.1.2), so `moqt://h` and `moqt://h/` are two paths.
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
  const moqt = u.protocol === 'moqt:'
  const path = moqt ? rawPath(url) : u.pathname
  if (path === null) return ''
  const port = u.port === '' || (moqt && u.port === '443') ? '' : `:${u.port}`
  const out = `${u.protocol}//${host}${port}${path}`
  return out.length > MAX_RELAY_URL ? '' : out
}

/** A `moqt` URL's path as written, or null when it is not path-abempty. */
function rawPath(url: string): string | null {
  const rest = url.slice(url.indexOf('://') + 3)
  const start = rest.search(/[/?#]/)
  if (start === -1) return ''
  const tail = rest.slice(start)
  const end = tail.search(/[?#]/)
  const path = end === -1 ? tail : tail.slice(0, end)
  return PATH_ABEMPTY.test(path) ? path : null
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
