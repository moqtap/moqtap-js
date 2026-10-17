/**
 * The bundle has to run under the view origin's CSP, which allows nothing
 * inline and no `eval`. A violation there is not an error anyone sees in a
 * test run (the browser silently refuses the script or style), so the page
 * and the built output are checked for the constructs that would be refused.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** Every file `bun run build` writes, and nothing else. The release hashes each. */
const BUNDLE_FILES = [
  'LICENSE-lucide-static.txt',
  'bundle.css',
  'fonts/ibm-plex-mono-latin-400-normal.woff2',
  'fonts/ibm-plex-mono-latin-500-normal.woff2',
  'fonts/ibm-plex-mono-latin-600-normal.woff2',
  'fonts/ibm-plex-sans-latin-400-italic.woff2',
  'fonts/ibm-plex-sans-latin-400-normal.woff2',
  'fonts/ibm-plex-sans-latin-500-normal.woff2',
  'fonts/ibm-plex-sans-latin-600-normal.woff2',
  'index.html',
  'licenses/IBM-Plex-OFL.txt',
  'main.js',
  'styles.css',
  'theme-boot.js',
  'tokens.css',
  'worker.js',
]

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .sort()
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
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

describe('the logo', () => {
  // One logo file for every moqtap surface; the page carries it inline so the
  // wordmark takes the theme's ink, hidden until the script finds no frame.
  it('is brand/moqtap-logo.svg, inline and hidden in the markup', () => {
    const logo = readFileSync(join(ROOT, 'brand', 'moqtap-logo.svg'), 'utf8').trim()
    const wrap = page.match(/<span\b[^>]*\sid="wordmark"[^>]*>([\s\S]*?)<\/span>/)
    expect(wrap?.[0]).toMatch(/\shidden(?=[\s>])/)
    expect(wrap?.[1]).toBe(logo)
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
  it('starts hidden in the markup, beside the header file input', () => {
    const tag = page.match(/<button\b[^>]*\sid="open-capture"[^>]*>/)?.[0]
    expect(tag).toBeDefined()
    expect(tag).toMatch(/\shidden(?=[\s>])/)
    expect(page).toMatch(/<input\b[^>]*\sid="file-input"[^>]*\stype="file"/)
  })
})

describe('the theme', () => {
  // The parent's theme has to be on <html> before the first paint, or a dark
  // parent shows a light frame for a moment. A module script runs too late
  // for that, so the boot script is a classic one, ahead of main.js.
  it('is applied by a blocking script in the head, before the page script', () => {
    const head = page.slice(0, page.indexOf('</head>'))
    const boot = head.match(/<script\b[^>]*src="\.\/theme-boot\.js"[^>]*>/)?.[0]
    expect(boot).toBeDefined()
    expect(boot).not.toMatch(/\stype="module"|\sdefer|\sasync/)
    expect(head.indexOf('theme-boot.js')).toBeLessThan(head.indexOf('main.js'))
  })

  it('loads the design system before the page styles, as files', () => {
    const sheets = [...page.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map(
      (m) => m[1],
    )
    expect(sheets).toEqual(['./tokens.css', './bundle.css', './styles.css'])
  })
})

describe('the built bundle', () => {
  const out = mkdtempSync(join(tmpdir(), 'moqtap-view-'))
  afterAll(() => rmSync(out, { recursive: true, force: true }))

  const build = (dir: string) =>
    spawnSync('bun', ['run', 'scripts/build.ts', '--out', dir], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    })

  it('is a static directory with no network or HTML-injection sinks', () => {
    const built = build(out)
    expect(built.status, built.stderr).toBe(0)
    expect(listFiles(out)).toEqual(BUNDLE_FILES)
    const main = readFileSync(join(out, 'main.js'), 'utf8')
    const worker = readFileSync(join(out, 'worker.js'), 'utf8')
    const boot = readFileSync(join(out, 'theme-boot.js'), 'utf8')
    for (const code of [main, worker, boot]) {
      expect(code).not.toMatch(/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write/)
      expect(code).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/)
    }
    // The worker is started by URL from the origin itself, never from a blob.
    expect(main).toContain('worker.js')
    expect(main).not.toMatch(/createObjectURL|blob:/)
    // A classic script: an `import` or `export` would be a syntax error in one.
    expect(boot).not.toMatch(/^\s*(import|export)\b/m)
  }, 60_000)

  it('brings its fonts with it and loads nothing from another origin', () => {
    const css = ['tokens.css', 'bundle.css', 'styles.css'].map((f) =>
      readFileSync(join(out, f), 'utf8'),
    )
    for (const sheet of css) {
      expect(sheet).not.toMatch(/@import|https?:|\/\/fonts\./)
      for (const [, ref] of sheet.matchAll(/url\("?([^")]+)"?\)/g)) {
        expect(ref).toMatch(/^fonts\/[\w-]+\.woff2$/)
        expect(existsSync(join(out, ref!)), ref).toBe(true)
      }
    }
  })

  it('builds the same bytes twice, so a release can be checked against its checksums', () => {
    const again = mkdtempSync(join(tmpdir(), 'moqtap-view-'))
    try {
      const built = build(again)
      expect(built.status, built.stderr).toBe(0)
      for (const file of BUNDLE_FILES) {
        expect(sha256(join(again, file)), file).toBe(sha256(join(out, file)))
      }
    } finally {
      rmSync(again, { recursive: true, force: true })
    }
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
