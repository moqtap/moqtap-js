/**
 * Linked workers, the page's half: `linkWorker()`, the handshake, the frames
 * each probe forwards, and the worker that goes silent or is terminated.
 *
 * One set of links serves the page across its sessions. Every handler reads
 * the session that owns the links at the time of the call, so a link follows
 * the page into a new session without touching the customer's worker.
 */

import type { LinkOwner, LinksHost, WorkerLinks, WorkersFeature } from '../api/features.js'
import {
  type CallMessage,
  envelope,
  type ForwardMessage,
  HEARTBEAT_MS,
  type LinkedMessage,
  linkMessage,
  type PageMessage,
  SILENCE_MS,
} from '../api/link.js'
import type { ConnectionSnapshot, ConnectionState } from '../api/realm.js'
import type { LinkEvent, MessageTarget } from '../api/session.js'
import type { Mono } from '../types.js'

/** One `linkWorker()` call. */
interface Link {
  readonly id: string
  readonly target: MessageTarget
  state: 'waiting' | 'linked' | 'timeout' | 'gone'
  port: MessagePort | null
  lastHeard: Mono
  ready: boolean
  /** Records the probe reported dropped, cumulative. */
  dropped: number
  /** Its open connections as of the last forward. */
  conns: readonly ConnectionSnapshot[]
  /** The worker's `performance.timeOrigin`, from its hello. */
  origin: number
  /** `terminate()` was called on it: gone for good, whatever arrives after. */
  terminated: boolean
  timeout: unknown
  onHello: ((e: LinkEvent) => void) | undefined
}

class Links implements WorkerLinks {
  private readonly _host: LinksHost
  private _owner: LinkOwner
  private readonly _links: Link[] = []
  private _timer: unknown

  constructor(host: LinksHost, owner: LinkOwner) {
    this._host = host
    this._owner = owner
  }

  /**
   * Answer `target`'s hello, and report the link either way.
   *
   * Not automatic, and that is a security decision rather than an omission:
   * the page cannot enumerate its workers, and a `message` listener on the
   * page's own global would also hear cross-origin `postMessage` from any frame
   * or opener. So the customer names the target, and only it is answered.
   *
   * `hello` is one the target sent before the session was running, heard on
   * its behalf.
   */
  link(target: MessageTarget, hello?: LinkEvent): void {
    if (this._owner.ended || this._links.some((l) => l.target === target)) return
    const link: Link = {
      id: `w${this._links.length + 1}`,
      target,
      state: 'waiting',
      port: null,
      lastHeard: this._host.clock.now(),
      ready: false,
      dropped: 0,
      conns: [],
      origin: 0,
      terminated: false,
      timeout: undefined,
      onHello: undefined,
    }
    this._links.push(link)
    link.timeout = this._host.timer(() => {
      if (link.state !== 'waiting' || this._owner.ended) return
      link.state = 'timeout'
      this._owner.writeLink(link.id, 'timeout')
    }, this._owner.config.limits.linkTimeoutMs)
    this._wrapTerminate(link)
    const onHello = (e: LinkEvent): void => {
      const m = linkMessage(e.data)
      if (m === null || m.t !== 'hello' || typeof m.timeOrigin !== 'number') return
      this._answer(link, m.timeOrigin)
    }
    link.onHello = onHello
    try {
      target.addEventListener('message', onHello)
      target.start?.()
    } catch (err) {
      this._host.onError(err)
    }
    this._startTimer()
    if (hello !== undefined) onHello(hello)
  }

  open(): boolean {
    return this._links.some((l) => l.conns.length > 0)
  }

  connections(): ConnectionState[] {
    const out: ConnectionState[] = []
    for (const l of this._links) for (const s of l.conns) out.push(s.conn)
    return out
  }

  dropped(): number {
    let n = 0
    for (const l of this._links) n += l.dropped
    return n
  }

  closeForwarded(cause: 'session-end'): void {
    for (const l of this._links) this._closeForwarded(l, cause)
  }

  broadcast(m: PageMessage): void {
    for (const l of this._links) {
      if (l.port === null) continue
      try {
        l.port.postMessage(envelope(m))
      } catch (err) {
        this._host.onError(err)
      }
    }
  }

  /**
   * The next session took over. Every link, gone ones included, reports into
   * it from now: a worker silent past the limit is linked again when it
   * speaks, and the ids `w1, w2 …` stay unique in the page.
   */
  adopt(owner: LinkOwner): void {
    this._owner = owner
    this._host.cancel(this._timer)
    this._timer = undefined
    const now = this._host.clock.now()
    for (const link of this._links) {
      link.conns = []
      link.ready = false
      link.lastHeard = now
      if (link.state === 'linked' || link.state === 'timeout') owner.writeLink(link.id, link.state)
      try {
        link.port?.postMessage(
          envelope<PageMessage>({
            t: 'session',
            sessionId: owner.config.sessionId,
            instanceId: owner.instanceId,
            level: owner.level,
            base: owner.armed ? undefined : owner.base(link.origin),
          }),
        )
      } catch (err) {
        this._host.onError(err)
      }
    }
    if (!owner.armed && this._links.length > 0) this._startTimer()
  }

  teardown(): void {
    this._host.cancel(this._timer)
    this._timer = undefined
    for (const l of this._links) {
      this._host.cancel(l.timeout)
      if (l.onHello !== undefined) l.target.removeEventListener?.('message', l.onHello)
      l.port?.close()
    }
  }

  private _answer(link: Link, workerTimeOrigin: number): void {
    const owner = this._owner
    if (owner.ended || link.port !== null) return
    let channel: MessageChannel
    try {
      channel = new MessageChannel()
    } catch (err) {
      this._host.onError(err)
      return
    }
    const port = channel.port1
    link.port = port
    link.origin = workerTimeOrigin
    port.onmessage = (e: MessageEvent) => this._fromProbe(link, e.data)
    const config = owner.config
    const linked: LinkedMessage = {
      t: 'linked',
      sessionId: config.sessionId,
      instanceId: owner.instanceId,
      base: owner.armed ? undefined : owner.base(workerTimeOrigin),
      level: owner.level,
      config: {
        metrics: config.metrics,
        flightRecorder: config.flightRecorder,
        limits: config.limits,
        privacy: config.privacy,
        upload: config.upload,
        context: owner.context(),
      },
    }
    try {
      link.target.postMessage(envelope(linked), [channel.port2])
    } catch (err) {
      this._host.onError(err)
      return
    }
    this._heard(link)
  }

  private _fromProbe(link: Link, data: unknown): void {
    const owner = this._owner
    if (owner.ended) return
    const m = linkMessage(data) as (ForwardMessage | CallMessage) | null
    if (m === null) return
    try {
      // Before the session begins, all a probe says that matters is that its
      // worker attempted a connection.
      if (owner.armed) {
        if (m.t === 'open') owner.begin()
        return
      }
      this._heard(link)
      switch (m.t) {
        case 'fwd':
          this._forwarded(link, m)
          return
        case 'annotate':
          owner.annotate(m.name, m.data, m.conn)
          return
        case 'observe':
          owner.observe(m.name, m.value, m.labels)
          return
        case 'escalate':
          owner.escalate(m.level, m.reason)
          return
        case 'resolve':
          owner.resolve(m.reason)
          return
        case 'trigger':
          owner.trigger(m.kind, m.at, m.key)
          return
        case 'overrun':
          owner.overrun(m.at, m.signal)
          return
      }
    } catch (err) {
      this._host.onError(err)
    }
  }

  /**
   * A probe spoke: it is linked, and alive. A message a terminated worker
   * posted before it died is still taken, but does not bring the link back.
   */
  private _heard(link: Link): void {
    link.lastHeard = this._host.clock.now()
    if (link.state === 'linked' || link.terminated) return
    link.state = 'linked'
    this._owner.writeLink(link.id, 'linked')
  }

  private _forwarded(link: Link, m: ForwardMessage): void {
    const owner = this._owner
    link.dropped = Math.max(link.dropped, m.dropped)
    // A terminated worker's connections were reported closed when it went.
    if (!link.terminated) {
      const before = link.conns.length
      link.conns = m.conns
      if (m.conns.length < before) owner.noteClosed()
    }
    if (m.ready && !link.ready) {
      link.ready = true
      owner.connReady()
    }
    if (m.parts === undefined || m.n === 0) return
    owner.ensureSetup()
    for (const part of m.parts) {
      if ('deflate' in part) {
        owner.sealSegment(part)
        continue
      }
      owner.append(new Uint8Array(part.frames, 0, part.byteLength), part.n)
    }
  }

  /**
   * The worker is gone: terminated, or silent past {@link SILENCE_MS}. Its open
   * connections are reported closed with what its last forward said about them.
   * If it speaks again, it is linked again and its connections continue.
   */
  private _workerGone(link: Link): void {
    const owner = this._owner
    if (link.state !== 'linked' || owner.ended) return
    link.state = 'gone'
    owner.writeLink(link.id, 'gone')
    this._closeForwarded(link, 'worker-gone')
    link.conns = []
    owner.sealNow()
    owner.noteClosed()
  }

  /** Report a link's open connections closed, from its last forward. */
  private _closeForwarded(link: Link, cause: 'worker-gone' | 'session-end'): void {
    const owner = this._owner
    const ts = owner.relNow()
    for (const s of link.conns) {
      if (s.conn.state === 'closed') continue
      if (s.rollup !== null) owner.json(s.rollup)
      owner.json({
        t: 'conn-close',
        ts,
        lvl: owner.level,
        conn: s.conn.id,
        cause,
        counters: s.counters,
      })
    }
  }

  /**
   * Notice `terminate()` on this one `Worker` object the moment it is called,
   * without touching `Worker.prototype`. A call that bypasses the instance —
   * `Worker.prototype.terminate.call(w)` — is caught by the silence check.
   */
  private _wrapTerminate(link: Link): void {
    const w = link.target as { terminate?: unknown }
    const original = w.terminate
    if (typeof original !== 'function') return
    const gone = (): void => {
      link.terminated = true
      this._workerGone(link)
    }
    try {
      w.terminate = function terminate(this: unknown, ...args: unknown[]): unknown {
        try {
          gone()
        } catch {
          // Reporting never stands between the page and its own call.
        }
        return (original as (...a: unknown[]) => unknown).apply(this, args)
      }
    } catch (err) {
      this._host.onError(err)
    }
  }

  private _startTimer(): void {
    if (this._timer !== undefined) return
    const run = (): void => {
      if (this._owner.ended) {
        this._timer = undefined
        return
      }
      const now = this._host.clock.now()
      for (const l of this._links) {
        if (l.state === 'linked' && now - l.lastHeard > SILENCE_MS) this._workerGone(l)
      }
      this._timer = this._host.timer(run, HEARTBEAT_MS)
    }
    this._timer = this._host.timer(run, HEARTBEAT_MS)
  }
}

export const workers: WorkersFeature = {
  feature: 'workers',
  create: (host: LinksHost, owner: LinkOwner): WorkerLinks => new Links(host, owner),
  hold(target, onError) {
    let hello: LinkEvent | undefined
    const early = (e: LinkEvent): void => {
      if (linkMessage(e.data)?.t === 'hello') hello = e
    }
    try {
      target.addEventListener('message', early)
      target.start?.()
    } catch (err) {
      onError(err)
    }
    return () => {
      target.removeEventListener?.('message', early)
      return hello
    }
  },
}
