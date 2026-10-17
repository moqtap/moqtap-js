/**
 * The bundle has to run under the view origin's CSP, which allows nothing
 * inline and no `eval`. A violation there is not an error anyone sees in a
 * test run (the browser silently refuses the script or style), so the page
 * and the built output are checked for the constructs that would be refused.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
// Comments stripped: the page's own comment describes the rules it follows,
// and quoting a `<style>` there is not using one.
const page = readFileSync(join(ROOT, 'static', 'index.html'), 'utf8').replace(
  /<!--[\s\S]*?-->/g,
  '',
)

describe('index.html under script-src/style-src self', () => {
  it('has no inline script: every <script> has a src', () => {
    const scripts = page.match(/<script\b[^>]*>/g) ?? []
    expect(scripts.length).toBeGreaterThan(0)
    for (const tag of scripts) expect(tag).toMatch(/\ssrc="\.\/[\w.-]+\.js"/)
  })

  it('has no <style> element, no style attribute and no on* handler', () => {
    expect(page).not.toMatch(/<style\b/i)
    expect(page).not.toMatch(/\sstyle=/i)
    expect(page).not.toMatch(/\son[a-z]+=/i)
  })

  it('loads only same-origin relative resources', () => {
    const refs = [...page.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1])
    for (const ref of refs) expect(ref).toMatch(/^\.\//)
  })
})

describe('the Share button', () => {
  // Shown only by script, once a trace the parent marked is on screen. Hidden
  // in the markup, so a portal page, a plain visit or a script that fails to
  // load never shows a button that asks a parent for something.
  it('starts hidden in the markup', () => {
    const tag = page.match(/<button\b[^>]*\sid="share"[^>]*>/)?.[0]
    expect(tag).toBeDefined()
    expect(tag).toMatch(/\shidden(?=[\s>])/)
  })
})

describe('the Open capture button', () => {
  // Shown only by script, which hides it beside a trace a parent handed over
  // to be read. Hidden in the markup, so the portal never flashes it before
  // its trace arrives.
  it('starts hidden in the markup and holds the header file input', () => {
    const tag = page.match(/<label\b[^>]*\sid="open-capture"[^>]*>[\s\S]*?<\/label>/)?.[0]
    expect(tag).toBeDefined()
    expect(tag).toMatch(/^<label\b[^>]*\shidden(?=[\s>])/)
    expect(tag).toContain('id="file-input"')
  })
})

describe('the built bundle', () => {
  const out = mkdtempSync(join(tmpdir(), 'moqtap-view-'))
  afterAll(() => rmSync(out, { recursive: true, force: true }))

  it('is a static directory of four files with no network or HTML-injection sinks', () => {
    const build = spawnSync('bun', ['run', 'scripts/build.ts', '--out', out], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    })
    expect(build.status, build.stderr).toBe(0)
    for (const file of ['index.html', 'styles.css', 'main.js', 'worker.js']) {
      expect(existsSync(join(out, file)), file).toBe(true)
    }
    const main = readFileSync(join(out, 'main.js'), 'utf8')
    const worker = readFileSync(join(out, 'worker.js'), 'utf8')
    for (const code of [main, worker]) {
      expect(code).not.toMatch(/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write/)
      expect(code).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/)
    }
    // The worker is started by URL from the origin itself, never from a blob.
    expect(main).toContain('worker.js')
    expect(main).not.toMatch(/createObjectURL|blob:/)
  }, 60_000)

  it('refuses a staging parent that is not a bare workers.dev origin', () => {
    for (const bad of ['https://evil.example', 'http://x.workers.dev', 'https://x.workers.dev/']) {
      const build = spawnSync(
        'bun',
        ['run', 'scripts/build.ts', '--out', out, '--staging-parent', bad],
        { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' },
      )
      expect(build.status, bad).not.toBe(0)
    }
  }, 60_000)
})
