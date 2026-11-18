/**
 * An idle open connection gets one batch-only body per interval in a real
 * page, on the browser's own timers, and none once it closes.
 *
 * The page's WebTransport stands in for one that connected and carries
 * nothing. `upload.intervalMs` is 1 s and the early seal 500 ms, so the
 * measurement covers several intervals in seconds.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { type Browser, type BrowserType, chromium, firefox } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readPreamble } from '../../envelope/body.js'
import { readFrames } from '../../envelope/frame-writer.js'
import { afterPreamble, preambleOf } from '../support/uploads.js'

const PKG = resolve(__dirname, '..', '..', '..')
const BUN = process.platform === 'win32' ? 'bun.exe' : 'bun'
const INTERVAL_MS = 1_000
const EARLY_MS = 500

interface Body {
  seal: ReturnType<typeof preambleOf>['seal']
  em: [number, number][]
  records: { t: string; [k: string]: unknown }[]
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
  const records: Body['records'] = []
  for (const f of readFrames(frames)) {
    if (!f.raw) records.push(JSON.parse(new TextDecoder().decode(f.payload)))
  }
  const p = preambleOf(bytes)
  return { seal: p.seal, em: p.em, records }
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>idle</title>
<script>
window.WebTransport = class {
  constructor(url) {
    this.url = String(url)
    this.protocol = 'moqt-20'
    this.ready = Promise.resolve()
    let end
    this.closed = new Promise((r) => (end = r))
    this.close = () => end({ closeCode: 0, reason: '' })
  }
}
</script>
<script type="module">
import './collector.js'
window.collector = window.collectorInit({
  apiKey: 'k',
  endpoint: location.origin + '/v1/ingest',
  upload: { intervalMs: ${INTERVAL_MS}, earlyFlushesMs: [${EARLY_MS}] },
  onInternalError: (err) => (window.errors ??= []).push(String(err)),
})
window.wt = new WebTransport(location.origin + '/moq')
</script>`

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'moqtap-idle-'))
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
  await new Promise<void>((done) => server?.close(() => done()))
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const ENGINES: [string, BrowserType][] = [
  ['chromium', chromium],
  ['firefox', firefox],
]

describe.each(ENGINES)('%s: idle connection', (_name, engine) => {
  let browser: Browser

  beforeAll(async () => {
    browser = await engine.launch()
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
  })

  it('sends one batch-only body per interval while open, and none after it closes', async () => {
    received.length = 0
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${origin}/`)
    // The ready seal, the early one, then five intervals.
    await until('seven bodies', () => received.length >= 7)
    const open = received.slice(0, 7)
    expect(open.map((b) => b.seal.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(open[0]?.records.some((r) => r.t === 'conn-open')).toBe(true)
    for (let i = 1; i < open.length; i++) {
      const prev = open[i - 1] as Body
      const b = open[i] as Body
      expect(b.seal.from_us).toBe(prev.seal.through_us)
      expect(b.seal.ms).toBe(INTERVAL_MS)
      expect(prev.seal.next_us).toBeDefined()
      // Sealed at the stated time, give or take the browser's timer slack.
      const late = b.seal.through_us - (prev.seal.next_us as number)
      expect(late).toBeGreaterThanOrEqual(-2_000)
      expect(late).toBeLessThan(500_000)
      if (i >= 2) {
        expect(b.records.map((r) => r.t)).toEqual(['batch'])
        expect(b.em).toEqual([])
        const batch = b.records[0] as unknown as { conn: { c: number }[] }
        expect(batch.conn).toHaveLength(1)
      }
    }
    // The stated seals: the early and first interval ones, counted from
    // ready, so short by as much as their seal ran late, then from each
    // interval body's own seal, exactly.
    const stated = open.map((b) => (b.seal.next_us as number) - b.seal.through_us)
    expect(stated[0]).toBeLessThanOrEqual(EARLY_MS * 1000)
    expect(stated[0]).toBeGreaterThan((EARLY_MS - 500) * 1000)
    expect(stated[1]).toBeLessThanOrEqual(INTERVAL_MS * 1000)
    expect(stated[1]).toBeGreaterThan((INTERVAL_MS - 500) * 1000)
    for (const d of stated.slice(2)) expect(d).toBe(INTERVAL_MS * 1000)

    await page.evaluate(() => (window as unknown as { wt: { close(): void } }).wt.close())
    await until('the conn-close', () =>
      received.some((b) => b.records.some((r) => r.t === 'conn-close')),
    )
    const closed = received.length
    await page.waitForTimeout(4 * INTERVAL_MS)
    expect(received).toHaveLength(closed)
    expect(await page.evaluate(() => (window as unknown as { errors?: string[] }).errors)).toBe(
      undefined,
    )
    await context.close()
  }, 60_000)
})
