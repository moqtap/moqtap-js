/**
 * A session's start and end in Chromium, Firefox and WebKit: the first body
 * at the first `WebTransport`, a close the page asked for, the connections
 * still open ending with the page when it navigates away, a final body that
 * states no next seal, and a page the back/forward cache holds and restores.
 *
 * The page's `WebTransport` is a stand-in the test drives, so no relay or
 * network is needed. Run with `bun run test:browsers`.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  type Browser,
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

type Rec = { t: string; [k: string]: unknown }

interface Body {
  sessionId: string
  instanceId: string
  ss: string
  final: boolean
  seal: ReturnType<typeof preambleOf>['seal']
  key: string
  records: Rec[]
}

const received: Body[] = []
let dir = ''
let server: Server
let origin = ''

function decode(bytes: Uint8Array): Body {
  const pre = readPreamble(bytes)
  if (pre === null) throw new Error('not a collector body')
  let frames = afterPreamble(bytes)
  if (pre.gzipped) frames = new Uint8Array(gunzipSync(frames))
  const records: Rec[] = []
  for (const f of readFrames(frames)) {
    if (!f.raw) records.push(JSON.parse(new TextDecoder().decode(f.payload)))
  }
  const batch = records[0] as Rec
  expect(batch.t).toBe('batch')
  return {
    sessionId: batch.sessionId as string,
    instanceId: batch.instanceId as string,
    ss: batch.ss as string,
    final: batch.final === true,
    seal: preambleOf(bytes).seal,
    key: batch.idempotencyKey as string,
    records: records.slice(1),
  }
}

// A `WebTransport` the test settles from the page: `wts[i].open()`,
// `wts[i].close(info)`.
const STAND_IN = `<script>
window.WebTransport = class {
  constructor(url) {
    this.url = String(url)
    this.ready = new Promise((ok, no) => { this.ok = ok; this.no = no })
    this.closed = new Promise((ok) => { this.done = ok })
    ;(window.wts ??= []).push(this)
  }
  open() { this.ok() }
  close(info = {}) { this.done({ closeCode: info.closeCode ?? 0, reason: info.reason ?? '' }) }
}
</script>`

const COLLECTOR = `<script type="module">
import './collector.js'
window.collector = window.collectorInit({
  apiKey: 'k',
  endpoint: location.origin + '/v1/ingest',
  onInternalError: (err) => (window.errors ??= []).push(String(err)),
})
window.ready = true
</script>`

const PAGE = `<!doctype html><meta charset="utf-8"><title>session</title>${STAND_IN}${COLLECTOR}`
const OTHER = '<!doctype html><meta charset="utf-8"><title>other</title><p>other</p>'

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'moqtap-session-'))
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
        res.writeHead(204)
        res.end()
      })
      return
    }
    const pages: Record<string, [Buffer | string, string]> = {
      '/': [PAGE, 'text/html'],
      '/other': [OTHER, 'text/html'],
      '/collector.js': [bundle, 'text/javascript'],
    }
    const hit = pages[path ?? '']
    if (hit === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': hit[1] })
    res.end(hit[0])
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  await new Promise<void>((done) => server?.close(() => done()))
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** One instance's distinct bodies, by key, in sequence order. */
function bodiesOf(instance: string): Body[] {
  const byKey = new Map<string, Body>()
  for (const b of received) if (b.instanceId === instance) byKey.set(b.key, b)
  return [...byKey.values()].sort((a, b) => a.seal.seq - b.seal.seq)
}

const all = (bodies: readonly Body[], t: string): Rec[] =>
  bodies.flatMap((b) => b.records.filter((r) => r.t === t))

/** The instance's bodies form one whole: contiguous, chained, final last and only last. */
function expectWhole(bodies: readonly Body[], reason: string): void {
  expect(bodies.map((b) => b.seal.seq)).toEqual(bodies.map((_, i) => i))
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i] as Body
    if (i > 0) expect(b.seal.from_us).toBe((bodies[i - 1] as Body).seal.through_us)
    const last = i === bodies.length - 1
    expect(b.final, `body ${i} final`).toBe(last)
    if (last) expect(b.seal).not.toHaveProperty('next_us')
    else expect(b.seal.next_us).toBeGreaterThanOrEqual(b.seal.through_us)
  }
  const last = bodies.at(-1) as Body
  expect(all(bodies, 'end')).toEqual([expect.objectContaining({ reason, finalSeq: last.seal.seq })])
}

/** Load `path`, begin the session with one open connection, and wait for its first body. */
async function begin(page: Page, path: string): Promise<string> {
  const before = received.length
  await page.goto(`${origin}${path}`)
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true)
  await page.evaluate(() => {
    const W = (window as unknown as { WebTransport: new (u: string) => { open(): void } })
      .WebTransport
    new W(`${location.origin}/moq`).open()
  })
  await until('the first body', () =>
    received.slice(before).some((b) => b.records.some((r) => r.t === 'conn-open')),
  )
  const first = received.slice(before).find((b) => b.records.some((r) => r.t === 'conn-open'))
  return (first as Body).instanceId
}

const ENGINES: [string, BrowserType][] = [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
]

describe.each(ENGINES)('%s', (name, engine) => {
  /** Playwright's defaults, which keep no page in the back/forward cache. */
  let browser: Browser
  /**
   * The back/forward cache on, which Playwright turns off in Chromium and
   * Firefox. Chromium's headless shell keeps no page in it, so the full build.
   */
  let caching: Browser

  beforeAll(async () => {
    browser = await engine.launch()
    caching = await engine.launch(
      name === 'chromium'
        ? { channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] }
        : name === 'firefox'
          ? { firefoxUserPrefs: { 'fission.bfcacheInParent': true } }
          : {},
    )
    for (const b of [browser, caching]) await (await b.newPage()).close()
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await caching?.close()
  }, 30_000)

  it('begins at the first WebTransport and ends with the page that navigates away', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const instance = await begin(page, '/')

    const [first] = bodiesOf(instance)
    expect(first?.seal.seq).toBe(0)
    expect(first?.final).toBe(false)
    expect(first?.seal.next_us).toBeGreaterThan(first?.seal.through_us as number)
    expect(first?.records.map((r) => r.t)).toEqual(expect.arrayContaining(['setup', 'conn-open']))
    expect(['stored', 'new']).toContain(first?.ss)

    // The page closes the first connection, and a second is still connecting as it leaves.
    await page.evaluate(() => {
      const w = window as unknown as {
        wts: { close(i: object): void }[]
        WebTransport: new (u: string) => unknown
      }
      w.wts[0]?.close({ closeCode: 5, reason: 'done' })
      new w.WebTransport(`${location.origin}/moq2`)
    })
    await until('the close', () => all(bodiesOf(instance), 'conn-close').length > 0)
    expect(
      await page.evaluate(() => (window as unknown as { errors?: string[] }).errors ?? []),
    ).toEqual([])

    await page.goto(`${origin}/other`)
    try {
      await until('the final body', () => bodiesOf(instance).some((b) => b.final))
    } catch {
      // A beacon the browser dropped as the page went is in IndexedDB, and
      // the origin's next session sends it.
      await begin(page, '/')
      await until('the final body on the next load', () => bodiesOf(instance).some((b) => b.final))
    }
    await context.close()

    const bodies = bodiesOf(instance)
    expectWhole(bodies, 'unload')
    const ends = all(bodies, 'conn-close')
    expect(ends.map((e) => [e.cause, e.by ?? null, e.code ?? null])).toEqual([
      ['closed', 'client', 5],
      ['page-end', null, null],
    ])
    const final = bodies.at(-1) as Body
    expect(final.records.map((r) => r.t)).toEqual(['conn-close', 'end'])
    expect(final.records[0]?.at_us as number).toBeLessThanOrEqual(final.seal.through_us)
    expect(final.records[0]?.at_us as number).toBeGreaterThanOrEqual(final.seal.from_us)
  }, 60_000)

  it('holds the session in the back/forward cache, or ends it and joins the next load to it', async () => {
    const context = await caching.newContext()
    const page = await context.newPage()
    const instance = await begin(page, '/')
    const session = (bodiesOf(instance)[0] as Body).sessionId

    await page.goto(`${origin}/other`)
    await new Promise((r) => setTimeout(r, 1_000))
    // A page restored from the cache fires no `load`.
    await page.goBack({ waitUntil: 'commit' })
    await new Promise((r) => setTimeout(r, 1_000))
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true)
    const restored = await page.evaluate(() => {
      const w = window as unknown as {
        wts?: unknown[]
        WebTransport: new (u: string) => { open(): void }
      }
      const kept = w.wts?.length ?? 0
      new w.WebTransport(`${location.origin}/moq`).open()
      return kept
    })
    await page.waitForTimeout(500)
    await page.close()
    await until('the final body', () => bodiesOf(instance).some((b) => b.final))

    const bodies = bodiesOf(instance)
    const lives = all(bodies, 'life').map((l) => l.ev)
    expectWhole(bodies, 'unload')
    if (lives.includes('frozen')) {
      // Kept: the page that came back is the same page load, with its connection.
      expect(restored, `${name}: restored page keeps its transport`).toBe(1)
      expect(lives.filter((e) => e === 'frozen' || e === 'resumed')).toEqual(['frozen', 'resumed'])
      expect(all(bodies, 'conn-close').map((e) => e.cause)).toEqual(['page-end', 'page-end'])
      // Nothing ended it while it was cached: the end is in the final body only.
      expect(all(bodies.slice(0, -1), 'end')).toEqual([])
    } else {
      // Not kept: the navigation ended it, and the load that came back is a
      // new page load of the same browsing session.
      expect(all(bodies, 'conn-close').map((e) => e.cause)).toEqual(['page-end'])
      const next = received.filter((b) => b.instanceId !== instance && b.sessionId === session)
      expect(next.length, `${name}: the next load joins the session`).toBeGreaterThan(0)
      expect(next.every((b) => b.ss === 'stored')).toBe(true)
    }
    console.log(
      `${name}: back/forward cache ${lives.includes('frozen') ? 'kept' : 'did not keep'} the page`,
    )
    await context.close()
  }, 60_000)
})
