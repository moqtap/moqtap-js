/**
 * What a page that goes away leaves for ingest, in real browsers.
 *
 * Every case reads the bodies ingest received for the instance that went
 * away, from every page load, and checks them as one chain: `seq` from 0 with
 * no hole, each body's `from_us` the previous one's `through_us`, every record
 * number sent exactly once, and a body sent twice carrying the same key and
 * the same frames, compressed or not.
 *
 * - The beacon takes nothing: every body comes from storage on the next load,
 *   after a close or a navigation.
 * - More bodies are waiting at the close than one beacon can carry.
 * - The tab or the browser is killed, with no `pagehide`.
 * - The page goes into the back/forward cache and comes back.
 * - The next page load opens no connection.
 *
 * Needs the Playwright browsers for `playwright-core`'s pinned version
 * (`bunx playwright-core install chromium firefox webkit`). Run with
 * `bun run test:browsers`.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  type Browser,
  type BrowserContext,
  type BrowserType,
  chromium,
  firefox,
  type Page,
  webkit,
} from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readPreamble } from '../../envelope/body.js'
import { readFrames } from '../../envelope/frame-writer.js'
import { afterPreamble, preambleOf } from '../support/uploads.js'

const PKG = resolve(__dirname, '..', '..', '..')
const BUN = process.platform === 'win32' ? 'bun.exe' : 'bun'

interface Rec {
  t: string
  rseq?: number
  [k: string]: unknown
}

interface Body {
  instanceId: string
  sessionId: string
  seq: number
  ik: string
  final: boolean
  bytes: number
  hash: string
  em: [number, number][]
  seal: { seq: number; from_us: number; through_us: number; ms: number; next_us?: number }
  records: Rec[]
}

const received: Body[] = []
const held: ServerResponse[] = []
let holding = false
let dir = ''
let server: Server
let origin = ''

function decode(bytes: Uint8Array): Body {
  const pre = readPreamble(bytes)
  if (pre === null) throw new Error('not a collector body')
  const p = preambleOf(bytes)
  let frames = afterPreamble(bytes)
  if (pre.gzipped) frames = new Uint8Array(gunzipSync(frames))
  const records: Rec[] = []
  for (const f of readFrames(frames)) {
    if (!f.raw) records.push(JSON.parse(new TextDecoder().decode(f.payload)))
  }
  const batch = records[0] as Rec & {
    instanceId: string
    sessionId: string
    seq: number
    idempotencyKey: string
    final?: boolean
  }
  expect(batch.t).toBe('batch')
  return {
    instanceId: batch.instanceId,
    sessionId: batch.sessionId,
    seq: batch.seq,
    ik: batch.idempotencyKey,
    final: batch.final === true,
    bytes: bytes.byteLength,
    // Of the frames uncompressed: a body sent raw and again gzipped is one body.
    hash: createHash('sha256')
      .update(JSON.stringify([p.em, p.seal]))
      .update(frames)
      .digest('hex'),
    em: p.em,
    seal: p.seal,
    records: records.slice(1),
  }
}

// `?beacon=lie`: `sendBeacon` says it took the body and sends nothing, as a
// stub or a network filter does. `?wt=0`: the page opens no connection.
const PAGE = `<!doctype html><meta charset="utf-8"><title>page close</title>
<script>
window.WebTransport = class {
  constructor(url) {
    this.url = String(url)
    this.ready = new Promise(() => {})
    this.closed = new Promise(() => {})
  }
  close() {}
}
const q = new URLSearchParams(location.search)
if (q.get('beacon') === 'lie') navigator.sendBeacon = () => true
window.shows = []
addEventListener('pageshow', (e) => window.shows.push(e.persisted))
</script>
<script type="module">
import './collector.js'
window.collector = window.collectorInit({
  apiKey: 'k',
  endpoint: location.origin + '/v1/ingest',
  onInternalError: (err) => (window.errors ??= []).push(String(err)),
})
if (new URLSearchParams(location.search).get('wt') !== '0') new WebTransport(location.origin + '/moq')
</script>`

const OTHER = '<!doctype html><meta charset="utf-8"><title>other</title><p>other</p>'

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'moqtap-page-close-'))
  const target = JSON.stringify(join(PKG, 'src', 'index.js').replaceAll('\\', '/'))
  writeFileSync(
    join(dir, 'entry.ts'),
    `import { init } from ${target}\n;(globalThis as unknown as Record<string, unknown>).collectorInit = init\n`,
  )
  const r = spawnSync(
    BUN,
    ['build', join(dir, 'entry.ts'), '--target=browser', '--outfile', join(dir, 'collector.js')],
    { encoding: 'utf8', cwd: PKG },
  )
  if (r.status !== 0) throw new Error(`bun build failed\n${r.stdout}\n${r.stderr}`)
  const bundle = readFileSync(join(dir, 'collector.js'))

  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/v1/ingest' && req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (d: Buffer) => chunks.push(d))
      req.on('end', () => {
        received.push(decode(new Uint8Array(Buffer.concat(chunks))))
        if (holding) {
          held.push(res)
          return
        }
        res.writeHead(204)
        res.end()
      })
      return
    }
    const body =
      path === '/collector.js' ? bundle : path === '/' ? PAGE : path === '/other' ? OTHER : null
    if (body === null) {
      res.writeHead(404)
      res.end()
      return
    }
    // A `no-store` page is never put in the back/forward cache.
    const cacheable = (req.url ?? '').includes('bf=1') || path === '/other'
    res.writeHead(200, {
      'content-type': path === '/collector.js' ? 'text/javascript' : 'text/html',
      ...(cacheable ? {} : { 'cache-control': 'no-store' }),
    })
    res.end(body)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  release()
  await new Promise<void>((done) => server?.close(() => done()))
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

/** Stop holding answers, and drop the requests held so far. */
function release(): void {
  holding = false
  for (const res of held.splice(0)) res.destroy()
}

function reset(): void {
  release()
  received.length = 0
}

async function until(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) {
      const seen = received.map(
        (b) =>
          `${b.instanceId.slice(0, 8)}:${b.seq}${b.final ? 'F' : ''}(${b.bytes}B ${b.records
            .map((r) => (r.t === 'note' ? r.name : r.t))
            .join(',')} ${b.seal.from_us}-${b.seal.through_us}/${b.seal.ms})`,
      )
      throw new Error(`timed out waiting for ${what}; received ${seen.join(' ')}`)
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type PageWindow = {
  collector: {
    annotate(name: string, data?: unknown): void
    flush(): Promise<void>
    ids(): { instanceId: string; sessionId: string }
  }
  errors?: string[]
  shows: boolean[]
}

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`${origin}/${query}`)
  await page.waitForFunction(() => 'collector' in window)
}

const annotate = (page: Page, name: string, data?: unknown): Promise<void> =>
  page.evaluate(([n, d]) => (window as unknown as PageWindow).collector.annotate(n, d), [
    name,
    data,
  ] as const)

const flush = (page: Page): Promise<void> =>
  page.evaluate(() => (window as unknown as PageWindow).collector.flush())

/** Seal now and wait for nothing: the upload may be held. */
const seal = (page: Page): Promise<void> =>
  page.evaluate(() => {
    void (window as unknown as PageWindow).collector.flush()
  })

const instanceOf = (page: Page): Promise<string> =>
  page.evaluate(() => (window as unknown as PageWindow).collector.ids().instanceId)

const errorsOf = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as PageWindow).errors ?? [])

/** The bodies of `instance` that IndexedDB holds, by seq. */
const storedSeqs = (page: Page, instance: string): Promise<number[]> =>
  page.evaluate(
    (i) =>
      new Promise<number[]>((done, fail) => {
        const req = indexedDB.open('moqtap-collector')
        req.onsuccess = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('index')) {
            db.close()
            done([])
            return
          }
          const all = db.transaction('index', 'readonly').objectStore('index').getAll()
          all.onsuccess = () => {
            db.close()
            const rows = all.result as { instanceId: string; seq: number }[]
            done(
              rows
                .filter((r) => r.instanceId === i)
                .map((r) => r.seq)
                .sort((a, b) => a - b),
            )
          }
          all.onerror = () => fail(all.error)
        }
        req.onerror = () => fail(req.error)
      }),
    instance,
  )

/** The stored seqs of `instance`, once IndexedDB holds at least one. */
async function waitStored(page: Page, instance: string): Promise<number[]> {
  const end = Date.now() + 10_000
  for (;;) {
    const seqs = await storedSeqs(page, instance)
    if (seqs.length > 0 || Date.now() > end) return seqs
    await pause(50)
  }
}

const of = (instance: string): Body[] => received.filter((b) => b.instanceId === instance)

const noted = (bodies: Body[], name: string): boolean =>
  bodies.some((b) => b.records.some((r) => r.t === 'note' && r.name === name))

/** Every seq from 0 to the highest received, and the final body among them. */
const complete = (instance: string): boolean => {
  const bodies = of(instance)
  const last = bodies.find((b) => b.final)
  if (last === undefined) return false
  const seqs = new Set(bodies.map((b) => b.seq))
  for (let s = 0; s <= last.seq; s++) if (!seqs.has(s)) return false
  return true
}

/**
 * The instance's bodies as one chain, each seq once. Fails on a hole, a seq
 * sent twice with other bytes, a broken seal chain, a record number sent
 * twice or never.
 */
function chain(instance: string): Body[] {
  const bySeq = new Map<number, Body>()
  for (const b of of(instance)) {
    const first = bySeq.get(b.seq)
    if (first === undefined) {
      bySeq.set(b.seq, b)
      continue
    }
    expect(b.ik, `seq ${b.seq} sent again under its own key`).toBe(first.ik)
    expect(b.hash, `seq ${b.seq} sent again with the same frames`).toBe(first.hash)
  }
  const bodies = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  expect(bodies.map((b) => b.seq)).toEqual(bodies.map((_, i) => i))
  for (let i = 1; i < bodies.length; i++) {
    const prev = bodies[i - 1] as Body
    const b = bodies[i] as Body
    expect(b.seal.from_us, `seq ${b.seq} starts where seq ${prev.seq} ended`).toBe(
      prev.seal.through_us,
    )
    expect(prev.final).toBe(false)
    expect(prev.seal.next_us).toBeGreaterThanOrEqual(prev.seal.through_us)
  }
  const last = bodies[bodies.length - 1] as Body
  if (last.final) expect(last.seal.next_us).toBeUndefined()
  const rseqs: number[] = []
  for (const b of bodies) {
    for (const [first, n] of b.em) for (let r = first; r < first + n; r++) rseqs.push(r)
    // Each record's own number is one the body's `em` lists.
    const listed = new Set<number>()
    for (const [first, n] of b.em) for (let r = first; r < first + n; r++) listed.add(r)
    for (const r of b.records) if (r.rseq !== undefined) expect(listed.has(r.rseq)).toBe(true)
  }
  expect(rseqs).toEqual(rseqs.map((_, i) => i))
  return bodies
}

/** How many times ingest received the body holding note `name`. */
const copiesOf = (instance: string, name: string): number =>
  of(instance).filter((b) => b.records.some((r) => r.t === 'note' && r.name === name)).length

function endOf(bodies: Body[]): Rec | undefined {
  for (const b of bodies) {
    const end = b.records.find((r) => r.t === 'end')
    if (end !== undefined) return end
  }
  return undefined
}

/**
 * A browser on a profile of its own, so it can be killed and started again
 * on the same IndexedDB.
 */
class Profile {
  readonly dir = mkdtempSync(join(tmpdir(), 'moqtap-profile-'))
  context: BrowserContext | undefined

  constructor(
    private readonly engine: BrowserType,
    private readonly args: string[] = [],
  ) {}

  async launch(): Promise<BrowserContext> {
    this.context = await this.engine.launchPersistentContext(this.dir, { args: this.args })
    return this.context
  }

  /** SIGKILL every process this profile's browser runs, found by the profile's path. */
  kill(): void {
    const tag = basename(this.dir)
    let pids: number[]
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${tag}*' -and $_.Name -ne 'powershell.exe' } | ForEach-Object { $_.ProcessId }`,
        ],
        { encoding: 'utf8' },
      )
      pids = out.split(/\s+/).filter(Boolean).map(Number)
    } else {
      const r = spawnSync('pgrep', ['-f', tag], { encoding: 'utf8' })
      pids = r.stdout.split(/\s+/).filter(Boolean).map(Number)
    }
    pids = pids.filter((p) => p !== process.pid)
    expect(pids.length).toBeGreaterThan(0)
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone with its parent.
      }
    }
  }

  async dispose(): Promise<void> {
    await this.context?.close().catch(() => undefined)
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

/** Records one confirmed body, then one held unconfirmed, then one record left buffered. */
async function leaveWork(page: Page): Promise<string> {
  const instance = await instanceOf(page)
  await annotate(page, 'confirmed')
  await flush(page)
  await until('the confirmed body', () => noted(of(instance), 'confirmed'))
  holding = true
  await annotate(page, 'unconfirmed')
  await seal(page)
  await until('the unconfirmed body', () => noted(of(instance), 'unconfirmed'))
  await annotate(page, 'buffered')
  return instance
}

const ENGINES: [string, BrowserType][] = [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
]

describe.each(ENGINES)('%s: page close', (_name, engine) => {
  let browser: Browser

  beforeAll(async () => {
    browser = await engine.launch()
    const warm = await browser.newPage()
    await warm.close()
  }, 60_000)

  afterAll(async () => {
    release()
    await browser?.close()
  }, 30_000)

  it.each([
    ['closes', true],
    ['navigates away', false],
  ])(
    'sends every body from storage on the next load when the beacon takes nothing and the page %s',
    async (_how, closes) => {
      reset()
      const context = await browser.newContext()
      const page = await context.newPage()
      await open(page, '?beacon=lie')
      const instance = await leaveWork(page)
      expect((await waitStored(page, instance)).length).toBeGreaterThan(0)
      expect(await errorsOf(page)).toEqual([])

      holding = false
      if (closes) await page.close()
      else await page.goto(`${origin}/other`)
      release()
      await pause(1_000)
      // A body the page sent by fetch as it was hidden may have arrived; every
      // other one comes from storage.

      const next = closes ? await context.newPage() : page
      await open(next)
      await until('every body of the closed page load', () => complete(instance))
      const bodies = chain(instance)
      const all = of(instance)
      expect(noted(all, 'buffered')).toBe(true)
      expect(endOf(bodies)).toMatchObject({ reason: 'unload', finalSeq: bodies.at(-1)?.seq })
      // A body ingest confirmed is not sent again.
      expect(copiesOf(instance, 'confirmed')).toBe(1)
      // The next load moved the closing page's localStorage copies into IndexedDB.
      expect(
        await next.evaluate(() =>
          Object.keys(localStorage).filter((k) => k.startsWith('moqtap-collector:')),
        ),
      ).toEqual([])
      const nextInstance = await instanceOf(next)
      expect(nextInstance).not.toBe(instance)
      await context.close()
    },
    60_000,
  )

  it('sends what one beacon cannot carry, each body within the beacon cap, or on the next load', async () => {
    reset()
    const context = await browser.newContext()
    const page = await context.newPage()
    await open(page)
    const instance = await instanceOf(page)
    await annotate(page, 'confirmed')
    await flush(page)
    await until('the confirmed body', () => noted(of(instance), 'confirmed'))

    // Eight bodies of 15,000 random letters each wait unconfirmed: more than one beacon carries.
    holding = true
    const names: string[] = []
    for (let i = 0; i < 8; i++) {
      const name = `big-${i}`
      names.push(name)
      await page.evaluate((n) => {
        const bytes = new Uint8Array(15_000)
        crypto.getRandomValues(bytes)
        let s = ''
        for (const b of bytes) s += String.fromCharCode(65 + (b % 58))
        ;(window as unknown as PageWindow).collector.annotate(n, s)
      }, name)
      await seal(page)
    }
    for (const end = Date.now() + 15_000; Date.now() < end; await pause(50)) {
      if ((await storedSeqs(page, instance)).length >= names.length) break
    }
    expect((await storedSeqs(page, instance)).length).toBeGreaterThanOrEqual(names.length)
    await annotate(page, 'buffered')
    expect(await errorsOf(page)).toEqual([])

    holding = false
    const before = received.length
    await page.close()
    release()
    const closeOnly = (): Body[] => received.slice(before).filter((b) => b.instanceId === instance)
    try {
      await until('every body after the close', () => complete(instance), 5_000)
    } catch {
      const next = await context.newPage()
      await open(next)
      await until('every body after the close, or on the next load', () => complete(instance))
    }
    const atClose = closeOnly()
    // A body sent at the close, by beacon or keepalive fetch, fits the cap.
    for (const b of atClose) expect(b.bytes).toBeLessThanOrEqual(64 * 1024)
    const bodies = chain(instance)
    for (const n of [...names, 'buffered']) expect(noted(of(instance), n), n).toBe(true)
    expect(endOf(bodies)).toMatchObject({ reason: 'unload' })
    expect(copiesOf(instance, 'confirmed')).toBe(1)
    await context.close()
  }, 90_000)

  it('sends the stored bodies from the next load that begins a session, not one that opens no connection', async () => {
    reset()
    const context = await browser.newContext()
    const page = await context.newPage()
    await open(page, '?beacon=lie')
    const instance = await leaveWork(page)
    expect((await waitStored(page, instance)).length).toBeGreaterThan(0)
    holding = false
    await page.close()
    release()

    const idle = await context.newPage()
    await open(idle, '?wt=0')
    const stored = await storedSeqs(idle, instance)
    expect(stored.length).toBeGreaterThan(0)
    const before = received.length
    await pause(2_000)
    // A page load that opens no connection sends nothing, its own or stored.
    expect(received.slice(before)).toEqual([])
    await idle.evaluate(() => new WebTransport(`${location.origin}/moq`))
    await until('the stored bodies once a session begins', () =>
      stored.every((s) =>
        received.slice(before).some((b) => b.instanceId === instance && b.seq === s),
      ),
    )
    chain(instance)
    await context.close()
  }, 60_000)

  it('comes back from the back/forward cache with the same instance and its chain intact, or ends it', async () => {
    reset()
    const b =
      engine === chromium
        ? // The headless shell never restores a page from the cache; the full build does.
          await chromium.launch({
            channel: 'chromium',
            ignoreDefaultArgs: ['--disable-back-forward-cache'],
          })
        : browser
    const context = await b.newContext()
    const page = await context.newPage()
    const why: unknown[] = []
    if (engine === chromium) {
      const cdp = await context.newCDPSession(page)
      await cdp.send('Page.enable')
      cdp.on('Page.backForwardCacheNotUsed', (e) => why.push(e.notRestoredExplanations))
    }
    await open(page, '?bf=1')
    const instance = await instanceOf(page)
    await annotate(page, 'before')
    await flush(page)
    await until('the first body', () => noted(of(instance), 'before'))
    await annotate(page, 'left-buffered')

    await page.goto(`${origin}/other`)
    await pause(500)
    // A page restored from the cache fires no `load`.
    await page.goBack({ waitUntil: 'commit' })
    await page.waitForFunction(() => 'collector' in window)
    const shows = await page.evaluate(() => (window as unknown as PageWindow).shows)
    const restored = shows.includes(true)
    const now = await instanceOf(page)
    if (restored) {
      expect(now).toBe(instance)
      await annotate(page, 'after')
      await flush(page)
      await until('the body after the restore', () => noted(of(instance), 'after'))
      const life = of(instance)
        .flatMap((x) => x.records)
        .filter((r) => r.t === 'life')
        .map((r) => r.ev)
      expect(life).toEqual(expect.arrayContaining(['frozen', 'resumed']))
      expect(endOf(of(instance))).toBeUndefined()
      expect(noted(of(instance), 'left-buffered')).toBe(true)
      chain(instance)
    } else {
      expect(now).not.toBe(instance)
      await until('every body of the page load that left', () => complete(instance))
      const bodies = chain(instance)
      expect(endOf(bodies)).toMatchObject({ reason: 'unload' })
      expect(noted(of(instance), 'left-buffered')).toBe(true)
    }
    console.info(
      `${_name}: back/forward cache ${restored ? 'restored the page' : 'not used'} ${JSON.stringify(why)}`,
    )
    await context.close()
    if (b !== browser) await b.close()
  }, 60_000)
})

const KILLABLE: [string, BrowserType, string[]][] = [
  ['chromium', chromium, []],
  ['firefox', firefox, []],
]

describe.each(KILLABLE)('%s: killed with no pagehide', (_name, engine, args) => {
  it('sends the sealed bodies from the next load, and loses only what was not sealed', async () => {
    reset()
    const profile = new Profile(engine, args)
    try {
      const context = await profile.launch()
      const page = context.pages()[0] ?? (await context.newPage())
      await open(page)
      const instance = await leaveWork(page)
      const stored = await waitStored(page, instance)
      expect(stored.length).toBeGreaterThan(0)
      const sent = new Set(of(instance).map((b) => b.seq))

      profile.kill()
      release()
      await pause(1_000)
      const before = received.length
      profile.context = undefined

      const again = await profile.launch()
      const next = again.pages()[0] ?? (await again.newPage())
      await open(next)
      await until('the stored bodies from the next load', () =>
        stored.every((s) =>
          received.slice(before).some((b) => b.instanceId === instance && b.seq === s),
        ),
      )
      await pause(500)
      const bodies = chain(instance)
      // No close was seen: no end, and the record never sealed is lost.
      expect(bodies.some((b) => b.final)).toBe(false)
      expect(endOf(bodies)).toBeUndefined()
      expect(noted(of(instance), 'buffered')).toBe(false)
      expect(copiesOf(instance, 'confirmed')).toBe(1)
      for (const s of stored) expect(sent.has(s) || bodies.some((b) => b.seq === s)).toBe(true)
    } finally {
      await profile.dispose()
    }
  }, 120_000)

  if (engine === chromium) {
    it('sends the sealed bodies from the next load after the tab crashes', async () => {
      reset()
      const browser = await chromium.launch()
      try {
        const context = await browser.newContext()
        const page = await context.newPage()
        await open(page)
        const instance = await leaveWork(page)
        const stored = await waitStored(page, instance)
        expect(stored.length).toBeGreaterThan(0)
        const cdp = await context.newCDPSession(page)
        const crashed = new Promise<void>((done) => page.once('crash', () => done()))
        void cdp.send('Page.crash').catch(() => undefined)
        await crashed
        release()
        const before = received.length

        const next = await context.newPage()
        await open(next)
        await until('the stored bodies from the next load', () =>
          stored.every((s) =>
            received.slice(before).some((b) => b.instanceId === instance && b.seq === s),
          ),
        )
        await pause(500)
        const bodies = chain(instance)
        expect(endOf(bodies)).toBeUndefined()
        expect(noted(of(instance), 'buffered')).toBe(false)
        expect(copiesOf(instance, 'confirmed')).toBe(1)
      } finally {
        await browser.close()
      }
    }, 60_000)
  }
})
