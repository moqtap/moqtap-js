/**
 * A real ingest endpoint that can be made to fail on demand.
 *
 * Ingest being down, slow or tarpitted must never affect the customer's
 * playback or publishing, and this is where that is exercised: blackhole the
 * endpoint, then tarpit it, and assert no effect on object arrival or on
 * `writer.ready` latency.
 *
 * It is a real HTTP server on loopback, not a stubbed `fetch`. A stub would
 * exercise the collector's own retry bookkeeping and nothing else; the failure
 * modes that matter live below `fetch` — a socket accepted and then answered by
 * nobody, a request body never drained — and only a real server produces them.
 * `Uploader` runs against `globalThis.fetch` here exactly as it does in a page.
 *
 * | mode | request body | response |
 * | --- | --- | --- |
 * | `ok` | drained | `204` at once, with the clock handshake headers |
 * | `blackhole` | drained | never |
 * | `tarpit` | never drained | withheld for `tarpitMs` |
 * | `500` | drained | `500` at once — the retry-with-backoff path |
 * | `4xx` | drained | `400` at once — the terminal-and-counted path |
 *
 * `blackhole` and `tarpit` differ in which half stalls: a blackholed request
 * has been fully delivered and only the answer is missing, while a tarpitted
 * one stalls with bytes still owed in the send direction. If the collector ever
 * held anything the page's data path also needs — a lock, a stream, a shared
 * buffer — the tarpit is the mode that shows it.
 *
 * {@link FaultServer.release} answers every held request with a terminal `400`,
 * the one status that makes `Uploader` stop rather than retry, so an arm ends
 * without leaving seconds of retry-with-backoff running behind it. It is
 * cleanup, not measurement: every arm calls it after its samples are taken.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

export type FaultMode = 'ok' | 'blackhole' | 'tarpit' | '500' | '4xx'

export interface FaultStats {
  /** Requests whose headers reached the server. The proof a fault was exercised. */
  requests: number
  /** Requests the server answered with a status. */
  answered: number
  /** Requests currently held open with no response — `blackhole` and `tarpit`. */
  held: number
  /** Request-body bytes read. Stays flat under `tarpit`, which never drains. */
  bytes: number
  /** Requests seen per mode, so an arm can prove which fault it ran under. */
  perMode: Record<FaultMode, number>
}

export interface FaultServer {
  /** The endpoint to hand `init({ endpoint })`. */
  readonly url: string
  /** Switch the fault mid-flight. The next request sees the new mode. */
  mode: FaultMode
  readonly stats: FaultStats
  /** Answer every held request with a terminal 400 so no upload stays pinned. */
  release(): void
  close(): Promise<void>
}

export interface FaultServerOptions {
  /** How long `tarpit` withholds its response. Default 10 minutes — i.e. never. */
  readonly tarpitMs?: number
  readonly host?: string
}

interface Held {
  respond(status: number): void
}

const TERMINAL_STATUS = 400

/**
 * Start the server and resolve once it is listening.
 *
 * Loopback, ephemeral port, so a suite can start several and CI never collides
 * with a fixed one.
 */
export function startFaultServer(
  mode: FaultMode,
  options: FaultServerOptions = {},
): Promise<FaultServer> {
  const tarpitMs = options.tarpitMs ?? 600_000
  const host = options.host ?? '127.0.0.1'

  const stats: FaultStats = {
    requests: 0,
    answered: 0,
    held: 0,
    bytes: 0,
    perMode: { ok: 0, blackhole: 0, tarpit: 0, '500': 0, '4xx': 0 },
  }

  // Every socket, so `close()` can finish while requests are held open —
  // `server.close()` waits for connections, and both fault modes hold theirs.
  const sockets = new Set<Socket>()
  const held = new Set<Held>()
  const timers = new Set<NodeJS.Timeout>()

  let current: FaultMode = mode

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const at = current
    stats.requests += 1
    stats.perMode[at] += 1

    const answer = (status: number): void => {
      if (res.writableEnded) return
      stats.answered += 1
      const t2 = Date.now()
      res.writeHead(status, {
        // Metrics the four-timestamp handshake: `t2` receive, `t3` send. The
        // collector's `ClockSync` keeps the lowest-RTT sample. Omitting these
        // would silently exercise the `Date`-header fallback instead.
        'x-moqtap-recv-ms': String(t2),
        'x-moqtap-send-ms': String(Date.now()),
        'content-length': '0',
      })
      res.end()
    }

    const drain = (): void => {
      // No encoding is set on the request, so `data` carries a `Buffer`. The
      // annotation is the only thing that pins it: `Readable.on('data')` is
      // typed `(chunk: any)`.
      req.on('data', (chunk: Buffer) => {
        stats.bytes += chunk.length
      })
    }

    if (at === 'ok' || at === '500' || at === '4xx') {
      const status = at === 'ok' ? 204 : at === '500' ? 500 : TERMINAL_STATUS
      drain()
      req.on('end', () => answer(status))
      return
    }

    // blackhole and tarpit: the response never comes. The difference is the
    // request half — blackhole consumes it (the request arrived; the answer did
    // not), tarpit does not (bytes are still owed in the send direction).
    if (at === 'blackhole') drain()
    else req.pause()

    const entry: Held = {
      respond: (status) => {
        if (!held.delete(entry)) return
        stats.held -= 1
        req.resume()
        answer(status)
      },
    }
    held.add(entry)
    stats.held += 1

    if (at === 'tarpit' && Number.isFinite(tarpitMs)) {
      const t = setTimeout(() => {
        timers.delete(t)
        entry.respond(204)
      }, tarpitMs)
      // Unref'd: a ten-minute timer must never be the reason the test runner
      // refuses to exit.
      t.unref()
      timers.add(t)
    }
  }

  const server = createServer(handler)

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
    })
  })

  return new Promise<FaultServer>((resolve) => {
    server.listen(0, host, () => {
      // `address()` is a string for a unix socket and `null` before listen; a
      // TCP listener inside this callback is neither, but the type covers all
      // three and the port is only meaningful in the third case.
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      resolve({
        url: `http://${host}:${port}/v1/ingest`,
        get mode(): FaultMode {
          return current
        },
        set mode(next: FaultMode) {
          current = next
        },
        stats,
        release(): void {
          for (const h of [...held]) h.respond(TERMINAL_STATUS)
        },
        close(): Promise<void> {
          for (const t of timers) clearTimeout(t)
          timers.clear()
          for (const h of [...held]) h.respond(TERMINAL_STATUS)
          return new Promise<void>((done) => {
            server.close(() => done())
            // Held requests keep their sockets alive; without this `close()`
            // waits for a peer that is never coming back.
            for (const s of sockets) s.destroy()
            sockets.clear()
          })
        },
      })
    })
  })
}
