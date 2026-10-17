/**
 * The viewer page: open a trace, hand it to the worker, render what comes back.
 *
 * Every string rendered here comes out of a file someone else wrote, so text
 * goes in through `textContent` and nothing else: no `innerHTML`, no
 * templates, no attribute built from trace content except the one link `href`,
 * which is built from the registry and not from the trace, and `title`
 * tooltips, which are text too.
 *
 * The markup is moqtap's design system (`mq-` classes from the vendored
 * `bundle.css`, in its compact density); `vw-` classes are this page's own
 * layout, in `styles.css`.
 */

import { Copy } from 'lucide-static'
import type {
  Finding,
  MessageRow,
  ObjectRow,
  SessionSummary,
  StreamRow,
  TraceAnalysis,
} from './analysis'
import {
  bytes,
  count,
  draftLabel,
  duration,
  exactOffset,
  type Heading,
  heading,
  hexId,
  hexLines,
  instant,
  iso,
  middle,
  offset,
} from './format'
import { type IngestedTrace, ingestFile, type ShareCandidate, startIngest } from './ingest'
import { applyTheme } from './theme'
import type { AnalyzeRequest, AnalyzeResponse } from './worker'

/**
 * Where a message's spec page lives. The registry stores a path on the site,
 * and the viewer is on another origin, so the path is resolved against the
 * site rather than against this page.
 */
const SPEC_ORIGIN = 'https://moqtap.com'

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`index.html has no #${id}`)
  return node as T
}

const headerInput = byId<HTMLInputElement>('file-input')
const emptyInput = byId<HTMLInputElement>('empty-file-input')
const header = byId<HTMLElement>('header')
const title = byId<HTMLHeadingElement>('title')
const factsLine = byId<HTMLSpanElement>('facts')
const draftPill = byId<HTMLSpanElement>('draft')
const shareButton = byId<HTMLButtonElement>('share')
const openButton = byId<HTMLButtonElement>('open-capture')
const chooseButton = byId<HTMLButtonElement>('choose')
const tabStrip = byId<HTMLElement>('tabs')
const empty = byId<HTMLDivElement>('empty')
const dropZone = byId<HTMLDivElement>('drop')
const errorBox = byId<HTMLDivElement>('error')
const errorText = byId<HTMLParagraphElement>('error-text')
const results = byId<HTMLDivElement>('results')
const overlay = byId<HTMLDivElement>('drop-overlay')

const EMPTY_TITLE = title.textContent ?? ''

const SOURCE_LABEL: Record<IngestedTrace['source'], string> = {
  file: 'This machine',
  parent: 'The page around this viewer',
}

// Only the outermost page in a nest of frames shows the logo.
if (window.parent === window) {
  byId('wordmark').hidden = false
  byId('wordmark-sep').hidden = false
}

// --------------------------------------------------------------- helpers ---

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * A Lucide icon at 16px with a 1.5px stroke (2.25 in its 24-unit viewBox,
 * drawn at 16px), hidden from assistive technology. The markup is a constant
 * bundled from `lucide-static`, parsed as SVG, never HTML.
 */
function icon(markup: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(markup.trim(), 'image/svg+xml').documentElement
  const svg = document.importNode(parsed, true) as unknown as SVGSVGElement
  svg.removeAttribute('class')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('stroke-width', '2.25')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  return svg
}

type Value = string | Node

/** A `KeyValue` list. Rows whose value is `undefined` are left out. */
function keyValue(rows: [string, Value | Value[] | undefined][]): HTMLDListElement {
  const list = el('dl', 'mq-kv')
  for (const [term, value] of rows) {
    if (value === undefined) continue
    const dd = el('dd')
    for (const part of Array.isArray(value) ? value : [value]) {
      dd.append(typeof part === 'string' ? el('span', 'mq-mono', part) : part)
    }
    list.append(el('dt', undefined, term), dd)
  }
  return list
}

/** Text that is a number and should line up: mono, tabular figures. */
function num(text: string, tooltip?: string): HTMLSpanElement {
  const span = el('span', 'mq-mono mq-num', text)
  if (tooltip !== undefined) span.title = tooltip
  return span
}

function muted(text: string): HTMLSpanElement {
  return el('span', 'mq-muted', text)
}

function sectionHeading(text: string, n?: number): HTMLHeadingElement {
  const h = el('h2', 'vw-heading', text)
  if (n !== undefined) h.append(el('span', 'mq-tab__count', count(n)))
  return h
}

/** The direction glyph in its colour, with its meaning for a screen reader. */
function directionGlyph(dir: Heading, className: string): HTMLSpanElement {
  const span = el('span', `${className} ${className}--${dir.side}`)
  const glyph = el('span', undefined, dir.glyph)
  glyph.setAttribute('aria-hidden', 'true')
  span.title = dir.label
  span.append(glyph, el('span', 'mq-sr', dir.label))
  return span
}

function directionBadge(dir: Heading): HTMLSpanElement {
  return el('span', `mq-badge mq-badge--${dir.side}`, `${dir.glyph} ${dir.label}`)
}

/**
 * An identifier too long to show whole: shortened in the middle, the full
 * value in a tooltip, and a copy control beside it.
 */
function identifier(value: string, what: string): HTMLSpanElement {
  const wrap = el('span', 'vw-id')
  const text = el('span', 'mq-mono', middle(value))
  text.title = value
  wrap.append(text)
  if (text.textContent !== value) wrap.append(copyButton(value, what))
  return wrap
}

/**
 * An address shown whole, wrapping where it must, with a copy control. Not
 * shortened like an identifier: the host is the part people read, and a
 * middle cut takes it out first.
 */
function address(value: string, what: string): HTMLSpanElement {
  const wrap = el('span', 'vw-id')
  wrap.append(el('span', 'mq-mono vw-wrap', value), copyButton(value, what))
  return wrap
}

const live = el('span', 'mq-sr')
live.setAttribute('aria-live', 'polite')
document.body.append(live)

function copyButton(value: string, what: string): HTMLButtonElement {
  const button = el('button', 'mq-btn mq-btn--quiet mq-btn--icon mq-copy')
  button.type = 'button'
  button.setAttribute('aria-label', `Copy ${what}`)
  button.title = `Copy ${what}`
  button.append(icon(Copy))
  let timer: ReturnType<typeof setTimeout> | undefined
  button.addEventListener('click', () => {
    void copy(value).then((ok) => {
      live.textContent = ok
        ? 'Copied'
        : `Couldn't copy the ${what}. Your browser or the page around this viewer blocked the clipboard.`
      if (!ok) return
      button.dataset.state = 'copied'
      clearTimeout(timer)
      timer = setTimeout(() => {
        delete button.dataset.state
        live.textContent = ''
      }, 1600)
    })
  })
  return button
}

/**
 * Copy text to the clipboard. A framed page may be refused the async
 * clipboard by its embedder's permissions policy, so the older selection
 * copy is the fallback rather than an error.
 */
async function copy(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    const area = el('textarea', 'mq-sr')
    area.value = value
    area.setAttribute('readonly', '')
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}

/** Raw bytes as a `HexView`: offset, sixteen bytes, ASCII. */
function hexView(data: Uint8Array, label: string): HTMLPreElement {
  const pre = el('pre', 'mq-hex vw-hex')
  // Focusable because it scrolls sideways, and a region that scrolls has to
  // be reachable without a mouse.
  pre.tabIndex = 0
  pre.setAttribute('role', 'region')
  pre.setAttribute('aria-label', label)
  hexLines(data).forEach((line, i) => {
    if (i > 0) pre.append('\n')
    pre.append(el('span', 'off', line.offset), `  ${line.hex}  `, el('span', 'asc', line.ascii))
  })
  return pre
}

// ------------------------------------------------------------- JSON tree ---

function treeValue(value: unknown): HTMLSpanElement {
  if (value === null || value === undefined) return el('span', 'null', 'null')
  if (typeof value === 'string') return el('span', 's', JSON.stringify(value))
  if (typeof value === 'number') return el('span', 'n', String(value))
  if (typeof value === 'boolean') return el('span', 'b', String(value))
  return el('span', undefined, String(value))
}

function treeNodes(value: object, depth: number): HTMLUListElement {
  const list = el('ul')
  for (const [key, child] of Object.entries(value)) {
    const item = el('li')
    if (child !== null && typeof child === 'object' && Object.keys(child).length > 0) {
      const details = el('details')
      details.open = depth === 0
      const summary = el('summary')
      const size = Array.isArray(child) ? `[${child.length}]` : `{${Object.keys(child).length}}`
      summary.append(el('span', 'k', key), ' ', muted(size))
      details.append(summary, treeNodes(child, depth + 1))
      item.append(details)
    } else {
      item.className = 'leaf'
      const shown =
        child !== null && typeof child === 'object'
          ? muted(Array.isArray(child) ? '[]' : '{}')
          : treeValue(child)
      item.append(el('span', 'k', key), ': ', shown)
    }
    list.append(item)
  }
  return list
}

/** A message's fields as a `JsonTree`, its first level open. */
function jsonTree(fields: Readonly<Record<string, unknown>>): HTMLUListElement {
  const root = treeNodes(fields, 0)
  root.className = 'mq-tree'
  return root
}

// -------------------------------------------------------------- findings ---

const SEVERITY_ORDER = { error: 0, warning: 1, note: 2 } as const
const SEVERITY_BADGE: Record<Finding['severity'], [string, string]> = {
  error: ['mq-badge--error', '✕ Error'],
  warning: ['mq-badge--check', '▲ Check'],
  note: ['mq-badge--note', 'i Note'],
}

function renderFindings(findings: readonly Finding[]): HTMLElement {
  const node = el('section', 'vw-card')
  node.append(sectionHeading('Findings', findings.length))
  if (findings.length === 0) {
    node.append(
      el(
        'p',
        'vw-card-note mq-muted',
        'Nothing to flag. No errors, dropped events or ambiguity this viewer knows how to spot.',
      ),
    )
    return node
  }
  const list = el('div', 'vw-findings')
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  )
  for (const finding of sorted) {
    const [badgeClass, badgeText] = SEVERITY_BADGE[finding.severity]
    const row = el('div', 'mq-finding')
    row.append(
      el('span', `mq-badge ${badgeClass}`, badgeText),
      el('span', 'mq-finding__title', finding.title),
      el('span', 'mq-finding__body', finding.detail),
    )
    list.append(row)
  }
  node.append(list)
  return node
}

// --------------------------------------------------------------- summary ---

function renderSummary(summary: SessionSummary, opened: Opened): HTMLElement {
  const node = el('section', 'vw-card')
  node.append(sectionHeading('Session'))

  const events = Object.entries(summary.eventCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${type} ${count(n)}`)
    .join(' · ')

  const started = num(instant(summary.startTime), iso(summary.startTime) ?? undefined)
  const protocol: Value[] =
    summary.draft === null
      ? [summary.protocol, muted(' no draft this viewer carries')]
      : [
          el('span', 'mq-badge mq-badge--draft', draftLabel(summary.draft)),
          muted(` ${summary.protocol}`),
        ]

  const list = keyValue([
    ['Protocol', protocol],
    ['Perspective', summary.perspective],
    ['Detail level', summary.detail],
    [
      'Format',
      `version ${summary.formatVersion}${summary.segments > 1 ? ` · ${count(summary.segments)} segments` : ''}`,
    ],
    ['Started', started],
    // "Event span", not "duration": this measures first event to last, which
    // is not the session's length. A recorder that opened its file seconds
    // before the first message makes the two differ, and the offsets in the
    // message log are from the header's start time.
    [
      'Event span',
      summary.durationUs === undefined
        ? muted('not recorded')
        : num(duration(summary.durationUs), `${count(summary.durationUs)} µs`),
    ],
    ['Recorder', summary.source],
    [
      'Endpoint',
      summary.endpoint === undefined ? undefined : address(summary.endpoint, 'endpoint'),
    ],
    ['Transport', summary.transport],
    [
      'Session ID',
      summary.sessionId === undefined ? undefined : identifier(summary.sessionId, 'session ID'),
    ],
    ['Streams', num(count(summary.streams))],
    [
      'Objects',
      num(
        `${count(summary.objects)}${summary.payloadBytes > 0 ? ` · ${bytes(summary.payloadBytes)}` : ''}`,
      ),
    ],
    ['Track aliases', summary.tracks.length > 0 ? summary.tracks.join(', ') : undefined],
    ['Peers', summary.peers.length > 0 ? summary.peers.join(', ') : undefined],
    ['Events', events.length > 0 ? events : muted('none')],
    ['File', [opened.name, muted(` · ${bytes(opened.size)}`)]],
    ['Opened from', el('span', undefined, SOURCE_LABEL[opened.source])],
  ])
  node.append(list)
  return node
}

// -------------------------------------------------------------- log pane ---

interface LogRow {
  readonly time: number
  readonly dir: Heading | null
  readonly type: string
  readonly sub?: string
  readonly meta: string
  readonly error?: boolean
}

/**
 * A `MessageLog` on the left of a split pane and the selected row's detail on
 * the right.
 *
 * The rows are a listbox: one tab stop, arrow keys move, Home and End jump.
 * The detail is a region of its own, focusable because it scrolls.
 */
function logPane<T>(
  idPrefix: string,
  label: string,
  items: readonly T[],
  toRow: (item: T) => LogRow,
  detail: (item: T) => Node[],
  heads: [string, string],
): HTMLElement {
  const split = el('div', 'mq-split-pane vw-split')

  const left = el('div', 'vw-logpane')
  const head = el('div', 'mq-log__head')
  head.setAttribute('aria-hidden', 'true')
  head.append(
    el('span', undefined, 'Time'),
    el('span'),
    el('span', undefined, heads[0]),
    el('span', undefined, heads[1]),
  )
  const list = el('div', 'mq-log vw-log')
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', label)
  list.tabIndex = 0
  left.append(head, list)

  const right = el('div', 'vw-detail')
  right.tabIndex = 0
  right.setAttribute('role', 'region')
  right.setAttribute('aria-label', `${label}: details`)

  const rows: HTMLDivElement[] = []
  let selected = -1

  const select = (index: number, scroll: boolean) => {
    if (index < 0 || index >= items.length || index === selected) return
    rows[selected]?.setAttribute('aria-selected', 'false')
    selected = index
    const row = rows[index]!
    row.setAttribute('aria-selected', 'true')
    list.setAttribute('aria-activedescendant', row.id)
    if (scroll) row.scrollIntoView({ block: 'nearest' })
    right.replaceChildren(...detail(items[index]!))
    right.scrollTop = 0
  }

  items.forEach((item, index) => {
    const data = toRow(item)
    const row = el('div', `mq-log__row${data.error === true ? ' mq-log__row--error' : ''}`)
    row.id = `${idPrefix}-${index}`
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', 'false')
    const type = el('span', 'mq-log__type', data.type)
    if (data.sub !== undefined) type.append(' ', muted(data.sub))
    const time = el('span', 'mq-log__time', offset(data.time))
    time.title = exactOffset(data.time)
    row.append(
      time,
      data.dir === null ? el('span', 'mq-log__dir') : directionGlyph(data.dir, 'mq-log__dir'),
      type,
      el('span', 'mq-log__meta', data.meta),
    )
    row.addEventListener('click', () => select(index, false))
    rows.push(row)
  })
  list.append(...rows)

  list.addEventListener('keydown', (event) => {
    const page = Math.max(1, Math.floor(list.clientHeight / 22) - 1)
    const to: Record<string, number> = {
      ArrowDown: selected + 1,
      ArrowUp: selected - 1,
      PageDown: Math.min(items.length - 1, selected + page),
      PageUp: Math.max(0, selected - page),
      Home: 0,
      End: items.length - 1,
    }
    const next = to[event.key]
    if (next !== undefined) {
      event.preventDefault()
      select(next, true)
    } else if (event.key === 'Enter') {
      // Enter takes you into the detail of the row you are on.
      event.preventDefault()
      right.focus()
    }
  })

  split.append(left, right)
  select(0, false)
  return split
}

// -------------------------------------------------------------- messages ---

/**
 * A link to the spec page for a message, or `null` when the registry path is
 * not one.
 *
 * The path comes from the committed registry, never from the trace, but it is
 * still resolved and checked to land on the site: a link is the one thing on
 * this page that leaves it.
 */
function specHref(specPath: string): string | null {
  if (!specPath.startsWith('/')) return null
  const url = new URL(specPath, SPEC_ORIGIN)
  return url.origin === SPEC_ORIGIN ? url.href : null
}

function messageDetail(message: MessageRow, summary: SessionSummary): Node[] {
  const out: Node[] = []
  const hex = hexId(message.messageType)
  const head = el('div', 'vw-detail-head')
  head.append(el('h2', 'vw-detail-title', message.name ?? hex))

  const href =
    message.name !== null && message.specPath !== null ? specHref(message.specPath) : null
  if (href !== null && message.name !== null) {
    const cite = message.section === null ? message.name : `§ ${message.section} ${message.name}`
    const link = el('a', 'mq-link vw-cite', cite)
    link.href = href
    // A new tab, because this one holds the whole analysis and none of it is
    // in the URL: a trace that arrived by postMessage cannot be re-opened by
    // navigating back. `noopener noreferrer` because a spec page has no
    // business reaching back into a frame holding someone's capture. Framed,
    // this needs `allow-popups allow-popups-to-escape-sandbox` on the parent's
    // sandbox: without the first the browser drops the click silently, and
    // without the second the spec page would open under the viewer's sandbox.
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    const draft = summary.draft === null ? '' : `${draftLabel(summary.draft)} `
    link.title = `${draft}${cite} (opens in a new tab)`
    head.append(link)
  }
  out.push(head)
  if (href !== null) {
    // The address as text as well, so it can be copied, and so the spec is
    // still reachable under a parent whose sandbox refuses popups.
    out.push(el('p', 'mq-mono mq-muted vw-spec-address', href))
  }

  const time = num(offset(message.at), exactOffset(message.at))
  const codePoint: Value[] = [hex]
  if (message.reserved) {
    codePoint.push(
      el(
        'span',
        'vw-reserved',
        message.note === null ? ' ▲ reserved code point' : ` ▲ reserved: ${message.note}`,
      ),
    )
  }
  out.push(
    keyValue([
      ['Type', codePoint],
      ['Direction', directionBadge(heading(message.direction, summary.perspective))],
      ['Time', time],
      ['Stream', message.streamId],
      ['Peer', message.peer],
      ['Size', message.size === undefined ? undefined : num(bytes(message.size))],
      ['Event', `segment ${message.segment} · seq ${message.seq}`],
    ]),
  )

  out.push(el('h3', 'vw-subhead', 'Fields'))
  if (message.fields !== undefined && Object.keys(message.fields).length > 0) {
    out.push(jsonTree(message.fields))
  } else if (message.fields !== undefined) {
    out.push(el('p', 'mq-muted vw-note', 'The message has no fields.'))
  } else if (message.opaque !== undefined) {
    // No explanation beside it: that belongs to the recorder, not to this
    // message, and the `opaque-messages` finding states it once.
    out.push(el('pre', 'vw-opaque', message.opaque))
  } else {
    out.push(el('p', 'mq-muted vw-note', 'The recorder decoded no fields for this message.'))
  }

  if (message.raw !== undefined && message.size !== undefined) {
    out.push(el('h3', 'vw-subhead', 'Bytes'))
    if (message.raw.length < message.size) {
      out.push(
        el(
          'p',
          'mq-muted vw-note',
          `The first ${bytes(message.raw.length)} of ${bytes(message.size)}.`,
        ),
      )
    }
    out.push(hexView(message.raw, `Bytes of ${message.name ?? hex}`))
  }
  return out
}

function renderMessages(analysis: TraceAnalysis): HTMLElement {
  const { messages, summary } = analysis
  if (messages.length === 0) {
    return emptyPanel(
      'No control messages recorded.',
      'A trace taken below the session layer, or one filtered to data events, legitimately has none.',
    )
  }
  return logPane(
    'message',
    'Control messages',
    messages,
    (m) => ({
      time: m.at,
      dir: heading(m.direction, summary.perspective),
      type: m.name ?? hexId(m.messageType),
      ...(m.name === null
        ? m.reserved
          ? { sub: 'reserved' }
          : {}
        : { sub: hexId(m.messageType) }),
      meta: m.size === undefined ? '' : bytes(m.size),
      error: m.name?.endsWith('_ERROR') === true,
    }),
    (m) => messageDetail(m, summary),
    ['Message', 'Size'],
  )
}

// --------------------------------------------------------------- streams ---

const STREAM_TYPE = ['subgroup', 'datagram', 'fetch'] as const

/** `subgroup`, `datagram` or `fetch`; `null` when the file recorded no open for it. */
function streamKind(stream: StreamRow): string | null {
  return stream.streamType === undefined ? null : STREAM_TYPE[stream.streamType]
}

function objectsTable(stream: StreamRow): HTMLElement {
  const wrap = el('div', 'mq-table-wrap vw-objects')
  wrap.tabIndex = 0
  wrap.setAttribute('role', 'region')
  wrap.setAttribute('aria-label', `Objects on stream ${stream.streamId}`)
  const table = el('table', 'mq-table')
  const head = el('tr')
  for (const [text, right] of [
    ['Time', false],
    ['Group', true],
    ['Object', true],
    ['Status', true],
    ['Priority', true],
    ['Size', true],
  ] as const) {
    const th = el('th', right ? 'mq-r' : undefined, text)
    th.scope = 'col'
    head.append(th)
  }
  const thead = el('thead')
  thead.append(head)
  const tbody = el('tbody')
  for (const object of stream.objectRows) tbody.append(objectRow(object))
  table.append(thead, tbody)
  wrap.append(table)
  return wrap
}

function objectRow(object: ObjectRow): HTMLTableRowElement {
  const tr = el('tr')
  const time = el('td', 'mq-mono', offset(object.at))
  time.title = exactOffset(object.at)
  tr.append(
    time,
    el('td', 'mq-r mq-mono', object.groupId),
    el('td', 'mq-r mq-mono', object.objectId),
    el('td', 'mq-r mq-mono', object.status === undefined ? '' : hexId(object.status)),
    el('td', 'mq-r mq-mono', object.priority === undefined ? '' : String(object.priority)),
    el('td', 'mq-r mq-mono', object.size === undefined ? '' : bytes(object.size)),
  )
  return tr
}

function streamDetail(stream: StreamRow, summary: SessionSummary): Node[] {
  const out: Node[] = []
  const head = el('div', 'vw-detail-head')
  head.append(
    el('h2', 'vw-detail-title', `Stream ${stream.streamId}`),
    streamKind(stream) === null
      ? muted('no open recorded')
      : el('span', 'mq-badge mq-badge--mono', streamKind(stream)!),
  )
  out.push(head)

  const closed =
    stream.closedAt === undefined
      ? undefined
      : [
          num(offset(stream.closedAt), exactOffset(stream.closedAt)),
          muted(
            stream.closeCode === 0 || stream.closeCode === undefined
              ? ''
              : ` code ${hexId(stream.closeCode)}`,
          ),
        ]
  out.push(
    keyValue([
      [
        'Direction',
        stream.direction === undefined
          ? muted('not recorded')
          : directionBadge(heading(stream.direction, summary.perspective)),
      ],
      [
        'Track alias',
        stream.trackAlias ?? (stream.streamType === undefined ? undefined : muted('not recorded')),
      ],
      ['Group', stream.groupId],
      ['Subgroup', stream.subgroupId],
      ['Fetch request', stream.fetchRequestId],
      ['First seen', num(offset(stream.at), exactOffset(stream.at))],
      ['Closed', closed],
      ['Peer', stream.peer],
      ['Objects', num(count(stream.objects))],
      ['Payload', stream.bytes > 0 ? num(bytes(stream.bytes)) : undefined],
    ]),
  )

  out.push(el('h3', 'vw-subhead', 'Objects'))
  if (stream.objectRows.length === 0) {
    out.push(el('p', 'mq-muted vw-note', 'No objects recorded on this stream.'))
    return out
  }
  out.push(objectsTable(stream))
  if (stream.objectRows.length < stream.objects) {
    out.push(
      el(
        'p',
        'mq-muted vw-note',
        `The first ${count(stream.objectRows.length)} of ${count(stream.objects)} objects.`,
      ),
    )
  }

  const withPayload = stream.objectRows.find((o) => o.payload !== undefined)
  if (withPayload?.payload !== undefined) {
    const label = `Payload of group ${withPayload.groupId}, object ${withPayload.objectId}`
    out.push(el('h3', 'vw-subhead', label))
    if (withPayload.size !== undefined && withPayload.payload.length < withPayload.size) {
      out.push(
        el(
          'p',
          'mq-muted vw-note',
          `The first ${bytes(withPayload.payload.length)} of ${bytes(withPayload.size)}.`,
        ),
      )
    }
    out.push(hexView(withPayload.payload, label))
  }
  return out
}

function renderStreams(analysis: TraceAnalysis): HTMLElement {
  const { streams, summary } = analysis
  if (streams.length === 0) {
    return emptyPanel(
      'No streams recorded.',
      'A trace recorded at the control detail level, or a session that sent no objects, has none.',
    )
  }
  return logPane(
    'stream',
    'Streams and objects',
    streams,
    (s) => ({
      time: s.at,
      dir: s.direction === undefined ? null : heading(s.direction, summary.perspective),
      type: `stream ${s.streamId}`,
      sub: [streamKind(s), s.trackAlias === undefined ? null : `track ${s.trackAlias}`]
        .filter((p) => p !== null)
        .join(' · '),
      meta: `${count(s.objects)} ${s.objects === 1 ? 'object' : 'objects'}${s.bytes > 0 ? ` · ${bytes(s.bytes)}` : ''}`,
    }),
    (s) => streamDetail(s, summary),
    ['Stream', 'Objects'],
  )
}

function emptyPanel(what: string, detail: string): HTMLElement {
  const node = el('div', 'mq-empty vw-panel-empty')
  node.append(el('h2', 'mq-empty__title', what), el('p', undefined, detail))
  return node
}

// ------------------------------------------------------------------ tabs ---

interface View {
  readonly id: string
  readonly label: string
  readonly count?: number
  readonly render: () => HTMLElement
}

function showViews(views: readonly View[]) {
  tabStrip.replaceChildren()
  results.replaceChildren()
  const panels = new Map<string, HTMLElement>()
  const tabs: HTMLButtonElement[] = []

  const select = (id: string, focus: boolean) => {
    for (const [panelId, panel] of panels) panel.hidden = panelId !== id
    for (const tab of tabs) {
      const on = tab.dataset.view === id
      tab.setAttribute('aria-selected', String(on))
      tab.tabIndex = on ? 0 : -1
      if (on && focus) tab.focus()
    }
  }

  views.forEach((view, index) => {
    const panel = el('div', 'vw-panel')
    panel.id = `panel-${view.id}`
    panel.setAttribute('role', 'tabpanel')
    panel.setAttribute('aria-labelledby', `tab-${view.id}`)
    panel.append(view.render())
    panel.hidden = true
    panels.set(view.id, panel)
    results.append(panel)

    const tab = el('button', 'mq-tab', view.label)
    tab.type = 'button'
    tab.id = `tab-${view.id}`
    tab.dataset.view = view.id
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-controls', panel.id)
    if (view.count !== undefined) tab.append(el('span', 'mq-tab__count', count(view.count)))
    tab.addEventListener('click', () => select(view.id, false))
    tab.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      const to = event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : index + step
      if (step === 0 && event.key !== 'Home' && event.key !== 'End') return
      event.preventDefault()
      select(views[(to + views.length) % views.length]!.id, true)
    })
    tabs.push(tab)
    tabStrip.append(tab)
  })

  tabStrip.hidden = false
  select(views[0]!.id, false)
}

// ------------------------------------------------------------------ flow ---

/**
 * What the page says about the file, kept apart from the bytes.
 *
 * Read before the bytes are handed to the worker, because handing them over
 * transfers the buffer and leaves the array behind empty, and a size read
 * afterwards is `0 B`, for every file, with nothing to show it went wrong.
 */
interface Opened {
  readonly name: string
  readonly size: number
  readonly source: IngestedTrace['source']
  /** Whether this page names it, or a framing page already does. */
  readonly titled: boolean
}

// A title the parent already shows is kept for assistive technology, so the
// framed document still has its heading, and taken off the screen.
function setTitle(text: string, shown: boolean) {
  title.textContent = text.length > 48 ? middle(text, 22) : text
  title.title = text
  title.classList.toggle('vw-offscreen', !shown)
}

// Framed, the header can be left with nothing on screen: no title (the parent
// names the trace, or nothing is open) and no facts or buttons yet. An empty
// bar is chrome for its own sake, so it goes the same way as the title.
function fitHeader() {
  const bare =
    title.classList.contains('vw-offscreen') &&
    [factsLine, draftPill, shareButton, openButton].every((node) => node.hidden)
  header.classList.toggle('vw-offscreen', bare)
}

function show(analysis: TraceAnalysis, opened: Opened) {
  showViews([
    {
      id: 'overview',
      label: 'Overview',
      render: () => {
        const panel = el('div', 'vw-overview')
        // Focusable because it scrolls; see `hexView`.
        panel.tabIndex = 0
        panel.append(renderFindings(analysis.findings), renderSummary(analysis.summary, opened))
        return panel
      },
    },
    {
      id: 'messages',
      label: 'Control messages',
      count: analysis.messages.length,
      render: () => renderMessages(analysis),
    },
    {
      id: 'streams',
      label: 'Streams and objects',
      count: analysis.streams.length,
      render: () => renderStreams(analysis),
    },
  ])

  empty.hidden = true
  results.hidden = false
  errorBox.hidden = true
  delete dropZone.dataset.rejected
  setTitle(opened.name, opened.titled)
  const messages = analysis.messages.length
  factsLine.textContent = `${count(messages)} ${messages === 1 ? 'message' : 'messages'} · ${bytes(opened.size)}`
  factsLine.hidden = false
  const { draft } = analysis.summary
  draftPill.textContent = draft === null ? '' : draftLabel(draft)
  draftPill.hidden = draft === null
}

// What the header's buttons are about: where the trace on screen came from
// and how the parent marked it. The bytes are not kept, so none are held
// for this. `ingest` makes both decisions; this only shows or hides buttons.
let onScreen: ShareCandidate | null = null

function offerActions(trace: IngestedTrace | null) {
  onScreen =
    trace === null
      ? null
      : {
          source: trace.source,
          ...(trace.shareable === true ? { shareable: true } : {}),
          ...(trace.local === true ? { local: true } : {}),
        }
  shareButton.hidden = !ingest.canShare(onScreen)
  openButton.hidden = !ingest.canOpenLocal(onScreen)
  fitHeader()
}

function resetHeader() {
  setTitle(EMPTY_TITLE, ingest.showsTitle(null))
  factsLine.hidden = true
  draftPill.hidden = true
  fitHeader()
}

function fail(message: string) {
  // Back to the empty state, which is where the error belongs: the previous
  // file's analysis left on screen under a new file's error reads as though
  // the error were about what is shown.
  results.hidden = true
  results.replaceChildren()
  tabStrip.hidden = true
  resetHeader()
  offerActions(null)
  empty.hidden = false
  errorText.textContent = message
  errorBox.hidden = false
  dropZone.dataset.rejected = ''
}

function working(opened: Opened) {
  offerActions(null)
  errorBox.hidden = true
  delete dropZone.dataset.rejected
  factsLine.hidden = true
  draftPill.hidden = true
  setTitle(`Reading ${opened.name}…`, opened.titled)
  fitHeader()
}

// One worker per file rather than one for the page: a capture large enough to
// be worth a worker is also large enough that abandoning it mid-decode is the
// only way to open a second file promptly.
let current: Worker | null = null

const ingest = startIngest({
  onTrace: analyze,
  onReject: fail,
  onTheme: (theme) => applyTheme(document.documentElement, theme),
})
resetHeader()
offerActions(null)

function analyze(trace: IngestedTrace) {
  current?.terminate()
  const opened: Opened = {
    name: trace.name ?? 'Capture',
    size: trace.bytes.byteLength,
    source: trace.source,
    titled: ingest.showsTitle(trace),
  }
  working(opened)

  // Resolved against this script, so the worker comes from the view origin
  // itself and `worker-src 'self'` is all the CSP has to allow.
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
  current = worker
  const done = () => {
    worker.terminate()
    if (current === worker) current = null
  }
  worker.addEventListener('message', (event: MessageEvent<AnalyzeResponse>) => {
    done()
    if (event.data.ok) {
      show(event.data.analysis, opened)
      offerActions(trace)
      ingest.report(trace, 'opened')
    } else {
      fail(event.data.message)
      ingest.report(trace, 'failed')
    }
  })
  worker.addEventListener('error', () => {
    done()
    fail(
      'The decoder stopped unexpectedly. The file may be a .moqtrace version this viewer cannot read.',
    )
    ingest.report(trace, 'failed')
  })

  // Transferred rather than copied, so a large capture is never held twice,
  // but only when the array covers its whole buffer. A view into part of a
  // larger one is copied out first: transferring the buffer would hand over
  // bytes outside the view along with it.
  const { buffer, byteOffset, byteLength } = trace.bytes
  const whole = byteOffset === 0 && byteLength === buffer.byteLength
  const payload = (
    whole ? buffer : buffer.slice(byteOffset, byteOffset + byteLength)
  ) as ArrayBuffer
  const request: AnalyzeRequest = { bytes: payload }
  worker.postMessage(request, [payload])
}

shareButton.addEventListener('click', () => {
  ingest.requestShare(onScreen)
})

async function openFile(file: File) {
  try {
    analyze(await ingestFile(file))
  } catch (e) {
    fail(e instanceof Error ? e.message : 'The file could not be read.')
  }
}

// The file inputs stay hidden behind real buttons, so choosing a file is a
// keyboard action like any other.
openButton.addEventListener('click', () => headerInput.click())
chooseButton.addEventListener('click', () => emptyInput.click())
for (const input of [headerInput, emptyInput]) {
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) void openFile(file)
    // Cleared so that choosing the same file twice fires `change` again,
    // which is what someone re-opening a capture they just re-recorded does.
    input.value = ''
  })
}

// Dropping anywhere. The counter is what keeps the overlay stable: dragging
// across a child element fires `dragleave` on the parent, so a boolean makes
// the overlay flicker as the pointer crosses the page.
let dragDepth = 0

function carriesFile(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

window.addEventListener('dragenter', (event) => {
  if (!carriesFile(event)) return
  event.preventDefault()
  dragDepth += 1
  overlay.hidden = false
})
// The default drop behaviour is to navigate to the file, which loses the page
// and everything on it, so `dragover` is cancelled too, not just `drop`.
window.addEventListener('dragover', (event) => {
  if (carriesFile(event)) event.preventDefault()
})
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) overlay.hidden = true
})
window.addEventListener('drop', (event) => {
  event.preventDefault()
  dragDepth = 0
  overlay.hidden = true
  const file = event.dataTransfer?.files?.[0]
  if (file) void openFile(file)
})
