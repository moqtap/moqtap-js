/**
 * Closing the tab delivers the instance's last bodies, in every engine.
 *
 * A real page in Chromium, Firefox and WebKit, a real loopback ingest, and
 * `page.close()`, with a connection attempt begun before it. Before the close, ingest stops answering, so one body sits in
 * the outbox unconfirmed, and one more record is buffered and never sealed.
 * After it, ingest must receive all three: the unconfirmed body again, the tail
 * holding the buffered record, and the final body with `end{unload}`.
 *
 * A body the browser drops after taking it may instead come from IndexedDB
 * on the origin's next page load, in one run per engine.
 *
 * Firefox is the engine this exists for. Closing a tab there cancels the
 * page's running script, and a cancel that finds none stops the first
 * `pagehide` listener at its first call. A collector that is that listener
 * sends nothing at all.
 *
 * Needs the Playwright browsers for `playwright-core`'s pinned version
 * (`bunx playwright-core install chromium firefox webkit`). Run with
 * `bun run test:browsers`.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { type Browser, type BrowserType, chromium, firefox, webkit } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BODY_PREAMBLE_BYTES, readPreamble } from '../../envelope/body.js'
import { readFrames } from '../../envelope/frame-writer.js'

const PKG = resolve(__dirname, '..', '..', '..')
const BUN = process.platform === 'win32' ? 'bun.exe' : 'bun'

interface Body {
  instanceId: string
  seq: number
  final: boolean
  records: { t: string; [k: string]: unknown }[]
}

/** Every body ingest received, in arrival order, and whether it was answered. */
const received: Body[] = []
const held: ServerResponse[] = []
let holding = false
let dir = ''
let server: Server
let origin = ''

function decode(bytes: Uint8Array): Body {
  const pre = readPreamble(bytes)
  if (pre === null) throw new Error('not a collector body')
  let frames = bytes.subarray(BODY_PREAMBLE_BYTES)
  if (pre.gzipped) frames = new Uint8Array(gunzipSync(frames))
  const records: Body['records'] = []
  for (const f of readFrames(frames)) {
    if (!f.raw) records.push(JSON.parse(new TextDecoder().decode(f.payload)))
  }
  const batch = records[0] as { t: string; instanceId: string; seq: number; final?: boolean }
  expect(batch.t).toBe('batch')
  return {
    instanceId: batch.instanceId,
    seq: batch.seq,
    final: batch.final === true,
    records: records.slice(1),
  }
}

// A session begins with a WebTransport. The page's stands in for one that
// never connects, in every engine and with no network: still connecting when
// the tab closes.
const PAGE = `<!doctype html><meta charset="utf-8"><title>unload</title>
<script>
window.WebTransport = class {
  constructor(url) {
    this.url = String(url)
    this.ready = new Promise(() => {})
    this.closed = new Promise(() => {})
  }
  close() {}
}
</script>
<script type="module">
import './collector.js'
window.collector = window.collectorInit({
  apiKey: 'k',
  endpoint: location.origin + '/v1/ingest',
  onInternalError: (err) => (window.errors ??= []).push(String(err)),
})
new WebTransport(location.origin + '/moq')
</script>`

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'moqtap-unload-'))
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
  // The marker that says the bundler kept the graph rather than truncating it.
  expect(bundle.includes('sendBeacon')).toBe(true)

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
    const body = path === '/collector.js' ? bundle : path === '/' ? PAGE : null
    if (body === null) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': path === '/' ? 'text/html' : 'text/javascript',
      'cache-control': 'no-store',
    })
    res.end(body)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  for (const res of held.splice(0)) res.destroy()
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

/** The page's collector, as the page script left it on `window`. */
type PageWindow = {
  collector: { annotate(name: string): void; flush(): Promise<void> }
  errors?: string[]
}

const hasNote = (b: Body, name: string): boolean =>
  b.records.some((r) => r.t === 'note' && r.name === name)

const ENGINES: [string, BrowserType][] = [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
]

describe.each(ENGINES)('%s: page.close()', (_name, engine) => {
  let browser: Browser
  let reloaded = 0

  beforeAll(async () => {
    browser = await engine.launch()
    // A first page closed in a freshly launched Firefox can wait out
    // Playwright's close without the page ever unloading; one throwaway page
    // keeps that out of the measurement.
    const warm = await browser.newPage()
    await warm.close()
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
  })

  // Repeated: in Firefox the cancel races the close, so one pass proves little.
  for (const run of [1, 2, 3, 4, 5]) {
    it(`delivers the unconfirmed body, the tail and end{unload} (run ${run})`, async () => {
      received.length = 0
      holding = false
      const context = await browser.newContext()
      const page = await context.newPage()
      await page.goto(`${origin}/`)
      await page.evaluate(() => {
        const c = (window as unknown as PageWindow).collector
        c.annotate('first')
        return c.flush()
      })
      await until('the first body', () =>
        received.some((b) => b.records.some((r) => r.t === 'setup')),
      )

      holding = true
      await page.evaluate(() => {
        const c = (window as unknown as PageWindow).collector
        c.annotate('unconfirmed')
        void c.flush()
      })
      await until('the unconfirmed body', () => received.some((b) => hasNote(b, 'unconfirmed')))
      await page.evaluate(() => {
        ;(window as unknown as PageWindow).collector.annotate('buffered')
      })
      const errors = await page.evaluate(() => (window as unknown as PageWindow).errors ?? [])
      expect(errors).toEqual([])

      const before = received.length
      const instance = (received.find((b) => hasNote(b, 'unconfirmed')) as Body).instanceId
      holding = false
      await page.close()
      const since = (): Body[] => received.slice(before).filter((b) => b.instanceId === instance)
      const final = (): Body | undefined => since().find((b) => b.final)
      const all = (): boolean => {
        const a = since()
        return (
          final() !== undefined &&
          a.some((b) => hasNote(b, 'unconfirmed')) &&
          a.some((b) => hasNote(b, 'buffered'))
        )
      }
      try {
        await until('every body after the close', all)
      } catch {
        // Firefox on a loaded machine sometimes drops beacons a page handed
        // over as it closed. Each body was stored too, and the origin's next
        // page load sends it. That covers one run; more mean beacons fail.
        expect(++reloaded, 'runs whose bodies only the next load delivered').toBe(1)
        const next = await context.newPage()
        await next.goto(`${origin}/`)
        await until('every body after the close, or on the next load', all)
      }
      await context.close()

      const last = final() as Body
      const end = last.records.find((r) => r.t === 'end')
      expect(end).toMatchObject({ t: 'end', reason: 'unload', finalSeq: last.seq })
      // The unconfirmed body went again under its own number, and the tail
      // came between it and the final body.
      const unconfirmed = since().find((b) => hasNote(b, 'unconfirmed')) as Body
      const tail = since().find((b) => hasNote(b, 'buffered')) as Body
      expect(unconfirmed.seq).toBeLessThan(tail.seq)
      expect(tail.seq).toBeLessThan(last.seq)
    }, 60_000)
  }
})
