/**
 * Ingest's hold in IndexedDB, in every engine.
 *
 * The holds live in a database of their own beside the chunks', so these run
 * against the engines' own IndexedDB rather than the memory backend: a reload
 * keeps the hold, the chunks' database stays at its own version, and a holds
 * database that will not open costs the hold and nothing else.
 *
 * Needs the Playwright browsers for `playwright-core`'s pinned version
 * (`bunx playwright-core install chromium firefox webkit`). Run with
 * `bun run test:browsers`.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  type Browser,
  type BrowserType,
  chromium,
  firefox,
  type Page,
  webkit,
} from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const PKG = resolve(__dirname, '..', '..', '..')
const BUN = process.platform === 'win32' ? 'bun.exe' : 'bun'

let dir = ''
let server: Server
let origin = ''

const PAGE = `<!doctype html><meta charset="utf-8"><title>holds</title>
<script type="module" src="./store.js"></script>`

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'moqtap-holds-'))
  const target = JSON.stringify(join(PKG, 'src', 'flush', 'index.js').replaceAll('\\', '/'))
  writeFileSync(
    join(dir, 'entry.ts'),
    `import { ChunkStore } from ${target}\n;(globalThis as unknown as Record<string, unknown>).ChunkStore = ChunkStore\n`,
  )
  const r = spawnSync(
    BUN,
    ['build', join(dir, 'entry.ts'), '--target=browser', '--outfile', join(dir, 'store.js')],
    { encoding: 'utf8', cwd: PKG },
  )
  if (r.status !== 0) throw new Error(`bun build failed\n${r.stdout}\n${r.stderr}`)
  const bundle = readFileSync(join(dir, 'store.js'))

  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const body = path === '/store.js' ? bundle : path === '/' ? PAGE : null
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

/** What the page script leaves on `window`. */
type PageWindow = {
  ChunkStore: {
    open(
      name: string,
      quota: number,
      o?: { onInternalError?: (e: unknown) => void },
    ): Promise<{
      durable: boolean
      holdUntil(d: object): number | undefined
      setHold(d: object, until: number): void
      put(c: object, d: object): Promise<boolean>
      backlog(d: object): { key: string }[]
      close(): void
    }>
  }
}

async function ready(page: Page): Promise<void> {
  await page.goto(`${origin}/`)
  await page.waitForFunction(() => 'ChunkStore' in window)
}

const ENGINES: [string, BrowserType][] = [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
]

describe.each(ENGINES)('%s: the hold in IndexedDB', (_name, engine) => {
  let browser: Browser

  beforeAll(async () => {
    browser = await engine.launch()
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
  })

  it('keeps the hold across a reload, in a database of its own', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await ready(page)
    const errors = await page.evaluate(async () => {
      const errors: string[] = []
      const store = await (window as unknown as PageWindow).ChunkStore.open('db', 1 << 20, {
        onInternalError: (e) => errors.push(String(e)),
      })
      store.setHold({ endpoint: 'https://ingest.test/v1/ingest', keyHash: 'k1' }, 123_456)
      // The write is behind the call; the reload is what waits on it here.
      for (let i = 0; i < 100; i++) {
        const rows = await new Promise<unknown[]>((done, fail) => {
          const req = indexedDB.open('db:holds')
          req.onsuccess = () => {
            const db = req.result
            const all = db.transaction('holds', 'readonly').objectStore('holds').getAll()
            all.onsuccess = () => {
              db.close()
              done(all.result)
            }
            all.onerror = () => fail(all.error)
          }
          req.onerror = () => fail(req.error)
        })
        if (rows.length > 0) break
        await new Promise((r) => setTimeout(r, 20))
      }
      store.close()
      return errors
    })
    expect(errors).toEqual([])

    await page.reload()
    await page.waitForFunction(() => 'ChunkStore' in window)
    const after = await page.evaluate(async () => {
      const errors: string[] = []
      const dest = { endpoint: 'https://ingest.test/v1/ingest', keyHash: 'k1' }
      const other = { endpoint: 'https://ingest.test/v1/ingest', keyHash: 'k2' }
      const store = await (window as unknown as PageWindow).ChunkStore.open('db', 1 << 20, {
        onInternalError: (e) => errors.push(String(e)),
      })
      const kept = store.holdUntil(dest)
      const none = store.holdUntil(other)
      store.close()
      const stores = (name: string) =>
        new Promise<{ version: number; names: string[] }>((done, fail) => {
          const req = indexedDB.open(name)
          req.onsuccess = () => {
            const db = req.result
            done({ version: db.version, names: Array.from(db.objectStoreNames).sort() })
            db.close()
          }
          req.onerror = () => fail(req.error)
        })
      return { errors, kept, none, chunks: await stores('db'), holds: await stores('db:holds') }
    })
    expect(after.errors).toEqual([])
    expect(after.kept).toBe(123_456)
    expect(after.none).toBeUndefined()
    expect(after.holds).toEqual({ version: 1, names: ['holds'] })
    expect(after.chunks.names).not.toContain('holds')
    await context.close()
  }, 60_000)

  it('stores the chunks all the same when the holds database will not open', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await ready(page)
    const out = await page.evaluate(async () => {
      // A holds database at a version newer than this collector's refuses it.
      await new Promise<void>((done, fail) => {
        const req = indexedDB.open('db:holds', 99)
        req.onsuccess = () => {
          req.result.close()
          done()
        }
        req.onerror = () => fail(req.error)
      })
      const errors: string[] = []
      const dest = { endpoint: 'https://ingest.test/v1/ingest', keyHash: 'k1' }
      const open = () =>
        (window as unknown as PageWindow).ChunkStore.open('db', 1 << 20, {
          onInternalError: (e) => errors.push(String(e)),
        })
      const first = await open()
      first.setHold(dest, 123_456)
      const stored = await first.put(
        {
          sessionId: 's1',
          instanceId: 'i1',
          seq: 0,
          idempotencyKey: 's1:i1:0',
          createdWallMs: 1_000,
          bytes: new Uint8Array(8),
          level: 'baseline',
          attempts: 0,
        },
        dest,
      )
      first.close()
      const second = await open()
      const out = {
        durable: second.durable,
        stored,
        backlog: second.backlog(dest).length,
        hold: second.holdUntil(dest),
        errors: errors.length,
      }
      second.close()
      return out
    })
    expect(out).toEqual({ durable: true, stored: true, backlog: 1, hold: undefined, errors: 2 })
    await context.close()
  }, 60_000)
})
