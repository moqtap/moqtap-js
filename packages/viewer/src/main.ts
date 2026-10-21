/**
 * The viewer page: open a trace, hand it to the worker, render what comes back.
 *
 * Every string rendered here comes out of a file someone else wrote, so text
 * goes in through `textContent` and nothing else: no `innerHTML`, no
 * templates, no attribute built from trace content except the spec link
 * `href`s, which are built from the registry and not from the trace, and
 * `title` tooltips, which are text too.
 *
 * The markup is moqtap's design system (`mq-` classes from the vendored
 * `bundle.css`, in its compact density); `vw-` classes are this page's own
 * layout, in `styles.css`.
 *
 * Only types come from `analysis.ts`: the page never loads the decoder or the
 * inspection code, which run in the worker.
 */

import { Copy } from 'lucide-static'
import type {
  ConnectionRow,
  Finding,
  MessageRow,
  ObjectRow,
  SessionSummary,
  StreamRow,
  TraceAnalysis,
  TrackRow,
} from './analysis'
import { el, muted, num } from './dom'
import {
  asShown,
  bucketRange,
  bytes,
  citation,
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
  plainValue,
  specHref,
  threshold,
  unknownParameter,
  wallClock,
} from './format'
import { type IngestedTrace, ingestFile, type ShareCandidate, startIngest } from './ingest'
import { isErrorRow, keyAction, matchesFilter, messageKey, nextGap, stepProblem } from './navigate'
import type { Selection } from './parents'
import type { DeliveryStats } from './rollups'
import { applyTheme } from './theme'
import { renderTimeline, type TimelineHandle } from './timeline'
import type { AnalyzeRequest, AnalyzeResponse } from './worker'

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
const connectionBar = byId<HTMLDivElement>('connection-bar')
const connectionPicker = byId<HTMLSelectElement>('connection')
const empty = byId<HTMLDivElement>('empty')
const dropZone = byId<HTMLDivElement>('drop')
const errorBox = byId<HTMLDivElement>('error')
const errorText = byId<HTMLParagraphElement>('error-text')
const results = byId<HTMLDivElement>('results')
const overlay = byId<HTMLDivElement>('drop-overlay')

const EMPTY_TITLE = title.textContent ?? ''

const SOURCE_LABEL: Record<IngestedTrace['source'], string> = {
  file: 'This machine',
  parent: 'The page',
}

// Only the outermost page in a nest of frames shows the logo.
if (window.parent === window) {
  byId('wordmark').hidden = false
  byId('wordmark-sep').hidden = false
}

// --------------------------------------------------------------- helpers ---

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

/**
 * A track's series swatch. Tracks take the categorical colours `chart-1` to
 * `chart-8` in the order the summary lists them, so a track keeps its colour
 * in every view; past the eighth they share `chart-8`, the system's "Other".
 * Never shown alone: the alias is written beside it.
 */
function trackSwatch(alias: string, tracks: readonly string[]): HTMLSpanElement {
  const index = tracks.indexOf(alias)
  const series = index < 0 ? 8 : Math.min(index, 7) + 1
  const swatch = el('span', series > 1 ? `mq-swatch mq-swatch--${series}` : 'mq-swatch')
  swatch.setAttribute('aria-hidden', 'true')
  return swatch
}

function trackLabel(alias: string, tracks: readonly string[], text: string): HTMLSpanElement {
  const label = el('span', 'vw-track')
  label.append(trackSwatch(alias, tracks), text)
  return label
}

/** Every track with its swatch: the legend for the colours the views use. */
function trackLegend(tracks: readonly string[]): HTMLSpanElement {
  const legend = el('span', 'mq-legend')
  for (const alias of tracks) legend.append(trackLabel(alias, tracks, alias))
  return legend
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
  wrap.append(el('span', 'mq-addr', value), copyButton(value, what))
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
        : `Couldn't copy the ${what}. The browser or the page blocked the clipboard.`
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

/** A text button that copies, for actions a reader names: "Copy thread". */
function copyTextButton(value: () => string, label: string, what: string): HTMLButtonElement {
  const button = el('button', 'mq-btn mq-btn--quiet vw-copy-text', label)
  button.type = 'button'
  button.addEventListener('click', () => {
    void copy(value()).then((ok) => {
      live.textContent = ok
        ? 'Copied'
        : `Couldn't copy the ${what}. The browser or the page blocked the clipboard.`
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

/**
 * A value the analysis made readable: printable bytes as quoted text, other
 * bytes in hex, a large integer in full, a setup version as its draft. What
 * was recorded is in the tooltip.
 */
function shownValue(text: string, raw: string, kind: string): HTMLSpanElement {
  const span =
    kind === 'text'
      ? el('span', 's', JSON.stringify(text))
      : el('span', kind === 'integer' ? 'n' : undefined, text)
  if (raw !== text) span.title = raw
  return span
}

function treeValue(value: unknown): HTMLSpanElement {
  const shown = asShown(value)
  if (shown !== null) return shownValue(shown.text, shown.raw, shown.$shown)
  const unknown = unknownParameter(value)
  if (unknown !== null) return el('span', 'vw-unknown-param', unknown)
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
    const leafObject = asShown(child) !== null || unknownParameter(child) !== null
    const branch =
      child !== null && typeof child === 'object' && !leafObject && Object.keys(child).length > 0
    if (branch) {
      const details = el('details')
      details.open = depth === 0 || key === 'unknown'
      const summary = el('summary')
      const size = Array.isArray(child) ? `[${child.length}]` : `{${Object.keys(child).length}}`
      summary.append(el('span', 'k', key), ' ', muted(size))
      details.append(summary, treeNodes(child, depth + 1))
      item.append(details)
    } else {
      item.className = 'leaf'
      const shown =
        child !== null && typeof child === 'object' && !leafObject
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

/** The findings card, or `null` when there are none. */
function renderFindings(findings: readonly Finding[]): HTMLElement | null {
  if (findings.length === 0) return null
  const node = el('section', 'vw-card')
  node.append(sectionHeading('Findings', findings.length))
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
    )
    if (finding.detail.length > 0) row.append(el('span', 'mq-finding__body', finding.detail))
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
      ? [summary.protocol, muted(' unknown draft')]
      : [
          el('span', 'mq-badge mq-badge--draft', draftLabel(summary.draft)),
          muted(` ${summary.protocol}`),
        ]

  const negotiated =
    summary.negotiatedProtocol === undefined
      ? undefined
      : el('span', 'mq-mono', summary.negotiatedProtocol)
  const draftFrom: Value[] | undefined =
    summary.draftFrom === 'negotiated-protocol' && negotiated !== undefined
      ? [el('span', undefined, 'Negotiated protocol '), negotiated]
      : summary.draftFrom === 'setup-version'
        ? [el('span', undefined, 'Version in SERVER_SETUP')]
        : undefined

  const list = keyValue([
    ['Protocol', protocol],
    ['Draft from', draftFrom],
    // Said once: as where the draft came from, or here when it named none.
    ['Negotiated protocol', draftFrom === undefined ? negotiated : undefined],
    ['Client', summary.clientImplementation],
    ['Relay', summary.relayImplementation],
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
    ['Track aliases', summary.tracks.length > 0 ? trackLegend(summary.tracks) : undefined],
    ['Peers', summary.peers.length > 0 ? summary.peers.join(', ') : undefined],
    ['Events', events.length > 0 ? events : muted('none')],
    ['File', [opened.name, muted(` · ${bytes(opened.size)}`)]],
    ['Opened from', el('span', undefined, SOURCE_LABEL[opened.source])],
  ])
  node.append(list)
  return node
}

const CLOSE_CAUSE: Record<string, string> = {
  closed: 'closed',
  failed: 'failed',
  'worker-gone': 'worker terminated',
  'session-end': 'session ended',
}

/** What a connection is, in a few words: `page · subscriber · moqt-14`. */
function connectionFacts(connection: ConnectionRow): string {
  return [connection.realm, ...(connection.roles ?? []), connection.protocol]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(' · ')
}

function connectionName(connection: ConnectionRow): string {
  const facts = connectionFacts(connection)
  return facts.length > 0 ? `${connection.label} (${facts})` : connection.label
}

function renderConnections(connections: readonly ConnectionRow[]): HTMLElement | null {
  if (connections.length < 2) return null
  const node = el('section', 'vw-card')
  node.append(sectionHeading('Connections', connections.length))
  const list = keyValue(
    connections.map((c): [string, Value[]] => {
      const parts: Value[] = []
      const facts = connectionFacts(c)
      if (facts.length > 0) parts.push(el('span', undefined, facts))
      if (c.origin !== undefined) parts.push(muted(` ${c.origin}`))
      if (c.openedAt !== undefined) parts.push(muted(` · opened ${offset(c.openedAt)}`))
      if (c.closedAt !== undefined) {
        const cause = c.cause === undefined ? 'closed' : (CLOSE_CAUSE[c.cause] ?? c.cause)
        const code = c.code === undefined ? '' : ` ${hexId(c.code)}`
        const reason = c.reason === undefined ? '' : ` "${c.reason}"`
        parts.push(muted(` · ${cause}${code}${reason} ${offset(c.closedAt)}`))
      }
      return [c.label, parts]
    }),
  )
  node.append(list)
  return node
}

// -------------------------------------------------------------- log pane ---

interface LogRow {
  readonly time: number
  /** The wall-clock time, for the tooltip. */
  readonly wall?: string | null
  readonly dir: Heading | null
  readonly type: string
  /** Shown before the type: which connection, when several share the log. */
  readonly tag?: string
  readonly sub?: string
  /**
   * The track alias and the summary's track order, for its swatch, and the
   * track's name where the control plane gave one.
   */
  readonly track?: {
    readonly alias: string
    readonly tracks: readonly string[]
    readonly name?: string | undefined
  }
  readonly meta: string
  readonly error?: boolean
  /** Went past the pending threshold. */
  readonly pending?: boolean
}

interface LogPane {
  readonly node: HTMLElement
  /** How many rows it holds. */
  readonly size: number
  /** The selected row, or -1. */
  selected(): number
  /** Select a row; `user` when the reader chose it, which the parent hears about. */
  select(index: number, scroll: boolean, user: boolean): void
  /** The row with this key, or -1. */
  find(key: string): number
  /** Draw the selected row's detail again, as after a display toggle. */
  refresh(): void
}

interface LogOptions<T> {
  readonly idPrefix: string
  readonly label: string
  readonly items: readonly T[]
  readonly toRow: (item: T) => LogRow
  readonly detail: (item: T) => Node[]
  readonly heads: [string, string]
  readonly keyOf: (item: T) => string
  /** The row to select first, by key. */
  readonly initial?: string | undefined
  readonly onSelect?: (item: T, user: boolean) => void
}

/**
 * A `MessageLog` on the left of a split pane and the selected row's detail on
 * the right.
 *
 * The rows are a listbox: one tab stop, arrow keys move, Home and End jump.
 * The detail is a region of its own, focusable because it scrolls.
 */
function logPane<T>(options: LogOptions<T>): LogPane {
  const { idPrefix, label, items, toRow, detail, heads, keyOf } = options
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
  list.dataset.pane = idPrefix
  list.dataset.keep = `${idPrefix}-list`
  left.append(head, list)

  const right = el('div', 'vw-detail')
  right.tabIndex = 0
  right.setAttribute('role', 'region')
  right.setAttribute('aria-label', `${label}: details`)
  right.dataset.keep = `${idPrefix}-detail`

  const rows: HTMLDivElement[] = []
  let selected = -1

  const select = (index: number, scroll: boolean, user: boolean) => {
    if (index < 0 || index >= items.length || index === selected) return
    rows[selected]?.setAttribute('aria-selected', 'false')
    selected = index
    const row = rows[index]!
    row.setAttribute('aria-selected', 'true')
    list.setAttribute('aria-activedescendant', row.id)
    list.dataset.selected = keyOf(items[index]!)
    if (scroll) row.scrollIntoView({ block: 'nearest' })
    right.replaceChildren(...detail(items[index]!))
    right.scrollTop = 0
    options.onSelect?.(items[index]!, user)
  }

  items.forEach((item, index) => {
    const data = toRow(item)
    const classes = ['mq-log__row']
    if (data.error === true) classes.push('mq-log__row--error')
    if (data.pending === true) classes.push('vw-row--pending')
    const row = el('div', classes.join(' '))
    row.id = `${idPrefix}-${index}`
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', 'false')
    const type = el('span', 'mq-log__type')
    if (data.tag !== undefined) type.append(el('span', 'vw-conn-tag', data.tag), ' ')
    type.append(data.type)
    // The track before the kind: a narrow pane cuts the end of this cell,
    // and a swatch must not lose the alias written beside it.
    if (data.track !== undefined) {
      const { alias, tracks, name } = data.track
      type.append(' ', trackLabel(alias, tracks, name ?? `track ${alias}`))
    }
    if (data.sub !== undefined) type.append(' ', muted(data.sub))
    const time = el('span', 'mq-log__time', offset(data.time))
    time.title =
      data.wall === undefined || data.wall === null
        ? exactOffset(data.time)
        : `${exactOffset(data.time)} · ${data.wall}`
    row.append(
      time,
      data.dir === null ? el('span', 'mq-log__dir') : directionGlyph(data.dir, 'mq-log__dir'),
      type,
      el('span', 'mq-log__meta', data.meta),
    )
    row.addEventListener('click', () => select(index, false, true))
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
      select(next, true, true)
    } else if (event.key === 'Enter') {
      // Enter takes you into the detail of the row you are on.
      event.preventDefault()
      right.focus()
    }
  })

  split.append(left, right)
  const find = (key: string) => items.findIndex((item) => keyOf(item) === key)
  const at = options.initial === undefined ? -1 : find(options.initial)
  select(Math.max(0, at), false, false)
  return {
    node: split,
    size: items.length,
    selected: () => selected,
    select,
    find,
    refresh: () => {
      if (selected >= 0) right.replaceChildren(...detail(items[selected]!))
    },
  }
}

// -------------------------------------------------------------- messages ---

/**
 * A link to a message's spec page.
 *
 * A new tab, because this one holds the whole analysis and none of it is in
 * the URL: a trace that arrived by postMessage cannot be re-opened by
 * navigating back. `noopener noreferrer` because a spec page has no business
 * reaching back into a frame holding someone's capture. Framed, this needs
 * `allow-popups allow-popups-to-escape-sandbox` on the parent's sandbox:
 * without the first the browser drops the click silently, and without the
 * second the spec page would open under the viewer's sandbox.
 */
function specLink(href: string, text: string): HTMLAnchorElement {
  const link = el('a', 'mq-link', text)
  link.href = href
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.title = `${text} (opens in a new tab)`
  return link
}

/** A message's name as the log shows it. */
function shownName(message: MessageRow): string {
  if (message.undecodable !== undefined) return 'Undecodable bytes'
  return message.name ?? hexId(message.messageType ?? 0)
}

/** Everything known about a message, for Copy as JSON and Copy thread. */
function messageObject(message: MessageRow, summary: SessionSummary): Record<string, unknown> {
  return {
    name: message.name,
    type: message.messageType === null ? null : hexId(message.messageType),
    draft: summary.draft === null ? null : draftLabel(summary.draft),
    section: message.section,
    direction:
      message.direction === null ? null : heading(message.direction, summary.perspective).label,
    atUs: message.at,
    segment: message.segment,
    seq: message.seq,
    connection: message.peer ?? null,
    stream: message.streamId ?? null,
    requestId: message.requestId ?? null,
    track: message.track ?? null,
    size: message.size ?? null,
    ...(message.error === undefined ? {} : { error: message.error }),
    ...(message.undecodable === undefined ? {} : { undecodable: message.undecodable }),
    fields: message.fields === undefined ? null : plainValue(message.fields),
    ...(message.opaque === undefined ? {} : { opaque: message.opaque }),
  }
}

/** An error code as read: `TRACK_DOES_NOT_EXIST (0x4)`, or `0x4, unknown for draft-14`. */
function errorCode(message: MessageRow): Value[] | undefined {
  const label = message.error?.label ?? ''
  return label === '' ? undefined : [el('span', 'mq-mono', label)]
}

/** A control that selects another message, such as a request's response. */
function jumpTo(index: number, text: string): HTMLButtonElement {
  const button = el('button', 'mq-btn mq-btn--link vw-jump', text)
  button.type = 'button'
  button.addEventListener('click', () => gotoMessage(index, true))
  return button
}

/** Whether a message's detail shows its fields or its bytes. Kept across messages. */
let detailMode: 'fields' | 'hex' = 'fields'

function modeToggle(): HTMLElement {
  const group = el('div', 'vw-mode')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', 'Show')
  for (const [mode, text] of [
    ['fields', 'Fields'],
    ['hex', 'Hex'],
  ] as const) {
    const button = el('button', 'mq-btn mq-btn--quiet', text)
    button.type = 'button'
    button.setAttribute('aria-pressed', String(detailMode === mode))
    button.addEventListener('click', () => {
      detailMode = mode
      messagesPane?.refresh()
    })
    group.append(button)
  }
  return group
}

function messageDetail(message: MessageRow, analysis: TraceAnalysis): Node[] {
  const { summary, messages } = analysis
  const out: Node[] = []
  const hex = message.messageType === null ? null : hexId(message.messageType)
  const href =
    message.name !== null && message.specPath !== null ? specHref(message.specPath) : null

  const head = el('div', 'vw-detail-head')
  const heading2 = el('h2', 'vw-detail-title')
  if (href !== null && message.name !== null) {
    heading2.append(specLink(href, message.name))
  } else {
    heading2.textContent = shownName(message)
  }
  head.append(heading2)
  if (message.name !== null && hex !== null) head.append(muted(hex))
  if (message.aliases !== undefined && message.aliases.length > 0) {
    head.append(muted(`also ${message.aliases.join(', ')}`))
  }
  if (message.reserved) {
    head.append(
      el(
        'span',
        'vw-reserved',
        message.note === null ? '▲ reserved code point' : `▲ reserved: ${message.note}`,
      ),
    )
  }
  const cite = citation(summary.draft, message.section)
  if (cite !== null) head.append(el('span', 'mq-muted vw-cite', cite))
  const actions = el('span', 'vw-detail-copy')
  const thread =
    message.thread === undefined ? [] : messages.filter((m) => m.thread === message.thread)
  if (thread.length > 1) {
    actions.append(
      copyTextButton(
        () =>
          JSON.stringify(
            thread.map((m) => messageObject(m, summary)),
            null,
            2,
          ),
        'Copy thread',
        'thread',
      ),
    )
  }
  actions.append(
    copyButton(JSON.stringify(messageObject(message, summary), null, 2), 'message as JSON'),
  )
  head.append(actions)
  out.push(head)

  const wall = wallClock(summary.startTime, message.at)
  const connection = analysis.connections.find((c) => c.id === message.peer)
  const response = message.response
  const answers = message.answers
  out.push(
    keyValue([
      [
        'Direction',
        message.direction === null
          ? undefined
          : directionBadge(heading(message.direction, summary.perspective)),
      ],
      [
        'Time',
        [
          num(offset(message.at), exactOffset(message.at)),
          ...(wall === null ? [] : [muted(` ${wall}`)]),
        ],
      ],
      ['Connection', connection === undefined ? undefined : connectionName(connection)],
      ['Request', message.requestId === undefined ? undefined : `#${message.requestId}`],
      ['Track', message.track],
      [
        'Response',
        response === undefined
          ? message.pending !== undefined && !message.pending.answered
            ? el('span', 'vw-pending', `No response after ${threshold(analysis.pendingMs)}`)
            : undefined
          : [
              jumpTo(response.index, response.name),
              muted(response.rttUs === null ? '' : ` after ${duration(response.rttUs)}`),
            ],
      ],
      [
        'Answers',
        answers === undefined
          ? undefined
          : [
              jumpTo(
                answers.index,
                `${answers.name}${answers.requestId === undefined ? '' : ` #${answers.requestId}`}`,
              ),
              muted(answers.rttUs === null ? '' : ` ${duration(answers.rttUs)} earlier`),
            ],
      ],
      ['Error code', errorCode(message)],
      [
        'Reason',
        message.error !== undefined && message.error.reason.length > 0
          ? message.error.reason
          : message.undecodable,
      ],
      ['Stream', message.streamId],
      ['Size', message.size === undefined ? undefined : num(bytes(message.size))],
    ]),
  )

  const hasFields =
    (message.fields !== undefined && Object.keys(message.fields).length > 0) ||
    message.opaque !== undefined
  const hasBytes = message.raw !== undefined && message.size !== undefined
  const mode = !hasBytes ? 'fields' : !hasFields ? 'hex' : detailMode
  if (hasFields && hasBytes) out.push(modeToggle())

  // Bytes that did not decode have no fields to say are missing.
  if (mode === 'fields' && message.undecodable !== undefined) return out
  if (mode === 'fields') {
    out.push(el('h3', 'vw-subhead', 'Fields'))
    if (message.fields !== undefined && Object.keys(message.fields).length > 0) {
      out.push(jsonTree(message.fields))
    } else if (message.opaque !== undefined) {
      // No explanation beside it: that belongs to the recorder, not to this
      // message, and the `opaque-messages` finding states it once.
      out.push(el('pre', 'vw-opaque', message.opaque))
    } else {
      out.push(el('p', 'mq-muted vw-note', 'No fields'))
    }
  } else if (message.raw !== undefined && message.size !== undefined) {
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
    out.push(hexView(message.raw, `Bytes of ${shownName(message)}`))
  }
  return out
}

/** What a message's row shows after its name: the wire ID, its request id, its error's name. */
function messageSub(message: MessageRow): string | undefined {
  const id =
    message.undecodable !== undefined
      ? null
      : message.name === null
        ? message.reserved
          ? 'reserved'
          : null
        : hexId(message.messageType ?? 0)
  const parts = [
    id,
    message.requestId === undefined ? null : `#${message.requestId}`,
    message.error?.codeName ?? null,
    message.track ?? null,
  ].filter((part): part is string => part !== null)
  return parts.length === 0 ? undefined : parts.join('  ')
}

/** What a message's row says in its last column: its response, or that none came. */
function messageMeta(message: MessageRow, pendingMs: number): string {
  const response = message.response
  if (response !== undefined) {
    return `→ ${response.name}${response.rttUs === null ? '' : ` ${duration(response.rttUs)}`}`
  }
  if (message.pending !== undefined) return `no response after ${threshold(pendingMs)}`
  if (message.undecodable !== undefined && message.size !== undefined) return bytes(message.size)
  return ''
}

interface Indexed {
  readonly message: MessageRow
  readonly index: number
}

/** Where the view is, beyond the place a replacement keeps: the picker and the filter. */
interface ViewState {
  /** The connection shown, or `null` for all. */
  connection: string | null
  filter: string
}

const view: ViewState = { connection: null, filter: '' }

let shown: { analysis: TraceAnalysis; opened: Opened } | null = null
let messagesPane: LogPane | null = null
let messageItems: readonly Indexed[] = []
let rebuildMessages: ((keep: string | undefined) => void) | null = null
let filterInput: HTMLInputElement | null = null
let timeline: TimelineHandle | null = null
let selectTab: ((id: string) => void) | null = null

function connectionShown(peer: string | undefined): boolean {
  return view.connection === null || (peer ?? '') === view.connection
}

function connectionTag(analysis: TraceAnalysis, peer: string | undefined): string | undefined {
  if (view.connection !== null || analysis.connections.length < 2) return undefined
  const index = analysis.connections.findIndex((c) => c.id === peer)
  return index < 0 ? undefined : `C${index + 1}`
}

function report(selection: Selection) {
  ingest.reportSelection(onScreen, selection)
}

function renderMessages(analysis: TraceAnalysis, initial: string | undefined): HTMLElement {
  const { messages, summary } = analysis
  if (messages.length === 0) {
    messagesPane = null
    return emptyPanel(
      'No control messages recorded.',
      'A trace taken below the session layer, or one filtered to data events, legitimately has none.',
    )
  }
  const wrap = el('div', 'vw-messages')
  const bar = el('div', 'vw-filterbar')
  const input = el('input', 'mq-input vw-filter')
  input.type = 'search'
  input.placeholder = 'Filter: name, #request, track'
  input.setAttribute('aria-label', 'Filter messages')
  input.value = view.filter
  filterInput = input
  bar.append(input)
  const holder = el('div', 'vw-messages-pane')

  const build = (keep: string | undefined) => {
    messageItems = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => connectionShown(message.peer))
      .filter(({ message }) => matchesFilter(message, view.filter))
    if (messageItems.length === 0) {
      messagesPane = null
      holder.replaceChildren(emptyPanel('No messages match.'))
      return
    }
    messagesPane = logPane<Indexed>({
      idPrefix: 'message',
      label: 'Control messages',
      items: messageItems,
      toRow: ({ message: m }) => {
        const sub = messageSub(m)
        const tag = connectionTag(analysis, m.peer)
        return {
          time: m.at,
          wall: wallClock(summary.startTime, m.at),
          dir: m.direction === null ? null : heading(m.direction, summary.perspective),
          type: shownName(m),
          ...(tag === undefined ? {} : { tag }),
          ...(sub === undefined ? {} : { sub }),
          meta: messageMeta(m, analysis.pendingMs),
          error: isErrorRow(m),
          pending: m.pending !== undefined,
        }
      },
      detail: ({ message: m }) => messageDetail(m, analysis),
      heads: ['Message', 'Response'],
      keyOf: ({ message: m }) => messageKey(m),
      initial: keep,
      onSelect: ({ message: m }, user) => {
        if (user) report({ t: Math.round(m.at / 1000), msg: messageKey(m) })
      },
    })
    holder.replaceChildren(messagesPane.node)
  }
  rebuildMessages = build

  input.addEventListener('input', () => {
    view.filter = input.value
    const current = messagesPane === null ? undefined : messageItems[messagesPane.selected()]
    build(current === undefined ? undefined : messageKey(current.message))
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      input.blur()
    } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
      event.preventDefault()
      holder.querySelector<HTMLElement>('[role="listbox"]')?.focus()
    }
  })

  build(initial)
  wrap.append(bar, holder)
  return wrap
}

/** Select a message by its index in the analysis, showing the messages tab. */
function gotoMessage(index: number, user: boolean) {
  if (shown === null) return
  const message = shown.analysis.messages[index]
  if (message === undefined) return
  let at = messageItems.findIndex((item) => item.index === index)
  if (at < 0 && (view.filter.length > 0 || !connectionShown(message.peer))) {
    // Out of the filtered view: show everything rather than nothing.
    view.filter = ''
    if (filterInput !== null) filterInput.value = ''
    if (!connectionShown(message.peer)) {
      setConnection(null)
      return gotoMessage(index, user)
    }
    rebuildMessages?.(messageKey(message))
    at = messageItems.findIndex((item) => item.index === index)
  }
  selectTab?.('messages')
  messagesPane?.select(at, true, user)
}

// ---------------------------------------------------------------- tracks ---

const TRACK_STATUS: Record<NonNullable<TrackRow['status']>, string> = {
  pending: 'No response',
  active: 'Active',
  error: 'Error',
  done: 'Ended',
}

function trackName(track: TrackRow, summary: SessionSummary): HTMLTableCellElement {
  const name = el('td', 'mq-mono')
  const text =
    track.name.length > 0
      ? track.name
      : track.alias !== undefined
        ? `alias ${track.alias}`
        : `fetch #${track.requestId ?? ''}`
  if (track.alias !== undefined && summary.tracks.includes(track.alias)) {
    name.append(trackLabel(track.alias, summary.tracks, text))
  } else {
    name.textContent = text
  }
  return name
}

function table(
  label: string,
  heads: readonly (readonly [string, boolean])[],
  body: HTMLTableRowElement[],
): HTMLElement {
  const wrap = el('div', 'mq-table-wrap vw-tracks')
  wrap.tabIndex = 0
  wrap.setAttribute('role', 'region')
  wrap.setAttribute('aria-label', label)
  wrap.dataset.keep = `tracks-${label}`
  const t = el('table', 'mq-table')
  const headRow = el('tr')
  for (const [text, right] of heads) {
    const th = el('th', right ? 'mq-r' : undefined, text)
    th.scope = 'col'
    headRow.append(th)
  }
  const thead = el('thead')
  thead.append(headRow)
  const tbody = el('tbody')
  tbody.append(...body)
  t.append(thead, tbody)
  wrap.append(t)
  return wrap
}

const RECEIVED_HEADS = [
  ['Track', false],
  ['Alias', true],
  ['Request', false],
  ['Status', false],
  ['Subscribe→OK', true],
  ['First object', true],
  ['Objects', true],
  ['Group ID gaps', true],
  ['Skipped', true],
  ['Stalls (longest)', true],
  ['Cadence p50/p95', true],
  ['Arrival p95', true],
  ['Error', false],
] as const

const SENT_HEADS = [
  ['Track', false],
  ['Alias', true],
  ['Request', false],
  ['Status', false],
  ['Objects sent', true],
  ['Bytes', true],
  ['Waiting to send', true],
  ['Acknowledged', true],
] as const

function bucket(value: number | null): string {
  return value === null ? '' : bucketRange(value)
}

function requestCell(track: TrackRow): string {
  return track.via === undefined ? '' : `${track.via.toUpperCase()} #${track.requestId ?? ''}`
}

function receivedRow(track: TrackRow, summary: SessionSummary): HTMLTableRowElement {
  const tr = el('tr')
  const stats: DeliveryStats | undefined = track.received
  const answered =
    track.status !== 'error' && track.requestedAt !== undefined && track.answeredAt !== undefined
      ? duration(track.answeredAt - track.requestedAt)
      : ''
  const first = el('td', 'mq-r mq-mono')
  if (stats?.firstObjectAt !== undefined) {
    if (track.requestedAt !== undefined) {
      first.textContent = duration(Math.max(0, stats.firstObjectAt - track.requestedAt))
      first.title = `${offset(stats.firstObjectAt)}, from the request`
    } else {
      first.textContent = offset(stats.firstObjectAt)
      first.title = exactOffset(stats.firstObjectAt)
    }
  }
  const stalls =
    stats === undefined
      ? ''
      : stats.stalls === 0 || stats.longestStall === null
        ? '0'
        : `${count(stats.stalls)} (${bucketRange(stats.longestStall)})`
  const cadence =
    stats?.cadenceP50 === null || stats?.cadenceP50 === undefined
      ? ''
      : `${bucket(stats.cadenceP50)} / ${bucket(stats.cadenceP95)}`
  tr.append(
    trackName(track, summary),
    el('td', 'mq-r mq-mono', track.alias ?? ''),
    el('td', 'mq-mono', requestCell(track)),
    el('td', undefined, track.status === undefined ? '' : TRACK_STATUS[track.status]),
    el('td', 'mq-r mq-mono', answered),
    first,
    el('td', 'mq-r mq-mono', stats === undefined ? '' : count(stats.objects)),
    el('td', 'mq-r mq-mono', stats === undefined ? '' : count(stats.groupGaps)),
    el('td', 'mq-r mq-mono', stats === undefined ? '' : count(stats.skipped)),
    el('td', 'mq-r mq-mono', stalls),
    el('td', 'mq-r mq-mono', cadence),
    el('td', 'mq-r mq-mono', stats === undefined ? '' : bucket(stats.arrivalP95)),
    el('td', undefined, track.errorReason ?? ''),
  )
  return tr
}

function sentRow(track: TrackRow, summary: SessionSummary): HTMLTableRowElement {
  const tr = el('tr')
  const stats = track.sent!
  tr.append(
    trackName(track, summary),
    el('td', 'mq-r mq-mono', track.alias ?? ''),
    el('td', 'mq-mono', requestCell(track)),
    el('td', undefined, track.status === undefined ? '' : TRACK_STATUS[track.status]),
    el('td', 'mq-r mq-mono', count(stats.objects)),
    el('td', 'mq-r mq-mono', bytes(stats.payloadBytes)),
    el('td', 'mq-r mq-mono', stats.blockedMs === undefined ? '' : duration(stats.blockedMs * 1000)),
    el('td', 'mq-r mq-mono', stats.ackedBytes === undefined ? '' : bytes(stats.ackedBytes)),
  )
  return tr
}

function renderTracks(analysis: TraceAnalysis): HTMLElement {
  const { summary, connections } = analysis
  const tracks = analysis.tracks.filter((t) => connectionShown(t.connection))
  if (tracks.length === 0) return emptyPanel('No tracks.')
  const node = el('div', 'vw-tracks-panel')
  node.dataset.keep = 'tracks'
  node.tabIndex = 0
  const groups =
    connections.length > 1 && view.connection === null
      ? connections.map((c) => [c, tracks.filter((t) => t.connection === c.id)] as const)
      : ([[null, tracks]] as const)
  for (const [connection, rows] of groups) {
    if (rows.length === 0) continue
    if (connection !== null) node.append(el('h2', 'vw-heading', connectionName(connection)))
    const received = rows.filter((t) => t.received !== undefined || t.sent === undefined)
    const sent = rows.filter((t) => t.sent !== undefined)
    const label = connection === null ? '' : ` on ${connection.label}`
    if (received.length > 0) {
      node.append(
        table(
          `Tracks received${label}`,
          RECEIVED_HEADS,
          received.map((t) => receivedRow(t, summary)),
        ),
      )
    }
    if (sent.length > 0) {
      node.append(el('h3', 'vw-subhead vw-tracks-sub', 'Sent'))
      node.append(
        table(
          `Tracks sent${label}`,
          SENT_HEADS,
          sent.map((t) => sentRow(t, summary)),
        ),
      )
    }
  }
  return node
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
  const t = el('table', 'mq-table')
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
  t.append(thead, tbody)
  wrap.append(t)
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
        stream.trackAlias !== undefined
          ? trackLabel(stream.trackAlias, summary.tracks, stream.trackAlias)
          : stream.streamType === undefined
            ? undefined
            : muted('not recorded'),
      ],
      ['Track', stream.track],
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

function renderStreams(analysis: TraceAnalysis, initial: string | undefined): HTMLElement {
  const { summary } = analysis
  const streams = analysis.streams.filter((s) => connectionShown(s.peer))
  if (streams.length === 0) {
    return emptyPanel(
      'No streams recorded.',
      'A trace recorded at the control detail level, or a session that sent no objects, has none.',
    )
  }
  return logPane<StreamRow>({
    idPrefix: 'stream',
    label: 'Streams and objects',
    items: streams,
    toRow: (s) => ({
      time: s.at,
      dir: s.direction === undefined ? null : heading(s.direction, summary.perspective),
      type: `stream ${s.streamId}`,
      ...(streamKind(s) === null ? {} : { sub: streamKind(s)! }),
      ...(s.trackAlias === undefined
        ? {}
        : { track: { alias: s.trackAlias, tracks: summary.tracks, name: s.track } }),
      meta: `${count(s.objects)} ${s.objects === 1 ? 'object' : 'objects'}${s.bytes > 0 ? ` · ${bytes(s.bytes)}` : ''}`,
    }),
    detail: (s) => streamDetail(s, summary),
    heads: ['Stream', 'Objects'],
    keyOf: (s) => s.streamId,
    initial,
  }).node
}

function emptyPanel(what: string, detail?: string): HTMLElement {
  const node = el('div', 'mq-empty vw-panel-empty')
  node.append(el('h2', 'mq-empty__title', what))
  if (detail !== undefined) node.append(el('p', undefined, detail))
  return node
}

// -------------------------------------------------------------- timeline ---

function renderTimelineTab(analysis: TraceAnalysis): HTMLElement {
  const nothing =
    analysis.messages.length === 0 &&
    analysis.delivery.lanes.length === 0 &&
    analysis.delivery.bands.length === 0 &&
    analysis.delivery.playerEvents.length === 0
  if (nothing) {
    timeline = null
    return emptyPanel('Nothing to draw.')
  }
  timeline = renderTimeline({
    analysis,
    connection: view.connection,
    connectionLabel: (id) => {
      const connection = analysis.connections.find((c) => c.id === id)
      return connection === undefined ? id : connectionName(connection)
    },
    onMessage: (index) => {
      const message = analysis.messages[index]
      const at = messageItems.findIndex((item) => item.index === index)
      if (at >= 0) messagesPane?.select(at, true, false)
      if (message !== undefined) {
        report({ t: Math.round(message.at / 1000), msg: messageKey(message) })
      }
    },
    onTime: (us) => report({ t: Math.round(us / 1000), msg: null }),
  })
  return timeline.node
}

// ----------------------------------------------------------------- place ---

/**
 * Where the reader is in the trace on screen: the tab, the row selected in
 * each log, and how far each scrolling region is scrolled. Kept across a
 * parent's `moqtrace-replace`, a newer copy of the same trace, so a reader
 * following a session as it grows keeps their place, and across a change of
 * connection.
 */
interface Place {
  readonly tab: string | null
  readonly selected: ReadonlyMap<string, string>
  readonly scroll: ReadonlyMap<string, Scroll>
}

interface Scroll {
  readonly top: number
  readonly left: number
}

/** Scroll offsets owed to regions in a tab not shown since the last render. */
const pendingScroll = new Map<string, Scroll>()

function currentPlace(): Place {
  const tab = tabStrip.querySelector<HTMLElement>('[aria-selected="true"]')?.dataset.view ?? null
  const selected = new Map<string, string>()
  for (const list of Array.from(results.querySelectorAll<HTMLElement>('[data-pane]'))) {
    const key = list.dataset.selected
    if (key !== undefined) selected.set(list.dataset.pane!, key)
  }
  const scroll = new Map(pendingScroll)
  for (const node of Array.from(results.querySelectorAll<HTMLElement>('[data-keep]'))) {
    // A region in a hidden tab reads 0; it keeps the offset it is still owed.
    if (node.closest('[hidden]') === null) {
      scroll.set(node.dataset.keep!, { top: node.scrollTop, left: node.scrollLeft })
    }
  }
  return { tab, selected, scroll }
}

/** Apply the offsets owed to the scrolling regions of a panel just shown. */
function restoreScroll(panel: HTMLElement) {
  for (const node of Array.from(panel.querySelectorAll<HTMLElement>('[data-keep]'))) {
    const key = node.dataset.keep!
    const owed = pendingScroll.get(key)
    if (owed === undefined) continue
    node.scrollTop = owed.top
    node.scrollLeft = owed.left
    pendingScroll.delete(key)
  }
}

// ------------------------------------------------------------------ tabs ---

interface View {
  readonly id: string
  readonly label: string
  readonly count?: number
  readonly render: () => HTMLElement
}

function showViews(views: readonly View[], initial: string | null) {
  tabStrip.replaceChildren()
  results.replaceChildren()
  const panels = new Map<string, HTMLElement>()
  const tabs: HTMLButtonElement[] = []

  const select = (id: string, focus: boolean) => {
    const panel = panels.get(id)
    if (panel === undefined) return
    for (const [panelId, other] of panels) other.hidden = panelId !== id
    restoreScroll(panel)
    for (const tab of tabs) {
      const on = tab.dataset.view === id
      tab.setAttribute('aria-selected', String(on))
      tab.tabIndex = on ? 0 : -1
      if (on && focus) tab.focus()
    }
  }
  selectTab = (id) => select(id, false)

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
  select(views.find((v) => v.id === initial)?.id ?? views[0]!.id, false)
}

// ----------------------------------------------------------- connections ---

function offerConnections(analysis: TraceAnalysis) {
  const { connections } = analysis
  if (view.connection !== null && !connections.some((c) => c.id === view.connection)) {
    view.connection = null
  }
  connectionBar.hidden = connections.length < 2
  if (connections.length < 2) return
  const all = el('option', undefined, `All ${connections.length} connections`)
  all.value = ''
  connectionPicker.replaceChildren(
    all,
    ...connections.map((c) => {
      const option = el('option', undefined, connectionName(c))
      option.value = c.id
      return option
    }),
  )
  connectionPicker.value = view.connection ?? ''
}

function setConnection(id: string | null) {
  view.connection = id
  connectionPicker.value = id ?? ''
  if (shown !== null) show(shown.analysis, shown.opened, true)
}

connectionPicker.addEventListener('change', () => {
  setConnection(connectionPicker.value === '' ? null : connectionPicker.value)
})

// ------------------------------------------------------------------ keys ---

/** Where "next" counts from: the selected message, else the start. */
function referenceTime(): number {
  if (shown === null || messagesPane === null) return -1
  return messageItems[messagesPane.selected()]?.message.at ?? -1
}

document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null
  if (
    target !== null &&
    (target.closest('input, textarea, select, [contenteditable="true"]') !== null ||
      target.isContentEditable)
  ) {
    return
  }
  const action = keyAction(event)
  if (action === null || shown === null) return
  const { analysis } = shown
  event.preventDefault()
  switch (action) {
    case 'next-message':
    case 'previous-message': {
      if (messagesPane === null) return
      selectTab?.('messages')
      const step = action === 'next-message' ? 1 : -1
      messagesPane.select(Math.max(0, messagesPane.selected() + step), true, true)
      return
    }
    case 'next-problem':
    case 'previous-problem': {
      const problems = analysis.problems.filter((p) => connectionShown(p.connection))
      const step = action === 'next-problem' ? 1 : -1
      const problem = stepProblem(problems, referenceTime(), step)
      if (problem === null) {
        live.textContent = step === 1 ? 'No later problem' : 'No earlier problem'
        return
      }
      live.textContent = problem.title
      gotoMessage(problem.index!, true)
      return
    }
    case 'next-error': {
      const from = messagesPane?.selected() ?? -1
      const next = messageItems.findIndex((item, i) => i > from && isErrorRow(item.message))
      if (next < 0) {
        live.textContent = 'No later error'
        return
      }
      selectTab?.('messages')
      messagesPane?.select(next, true, true)
      return
    }
    case 'next-gap': {
      if (timeline === null) return
      const gap = nextGap(timeline.cells, timelineFrom)
      if (gap === null) {
        live.textContent = 'No later gap or stall'
        return
      }
      timelineFrom = gap.from
      selectTab?.('timeline')
      timeline.selectCell(gap)
      report({ t: Math.round(gap.from / 1000), msg: null })
      return
    }
    case 'filter':
      if (filterInput === null) return
      selectTab?.('messages')
      filterInput.focus()
      filterInput.select()
      return
  }
})

/** Where `g` continues from: the last gap it showed. */
let timelineFrom = -1

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
function setTitle(text: string, visible: boolean) {
  title.textContent = text.length > 48 ? middle(text, 22) : text
  title.title = text
  title.classList.toggle('mq-sr', !visible)
}

// Framed, the header can be left with nothing on screen: no title (the parent
// names the trace, or nothing is open) and no facts or buttons yet. An empty
// bar is chrome for its own sake, so it goes the same way as the title.
function fitHeader() {
  const bare =
    title.classList.contains('mq-sr') &&
    [factsLine, draftPill, shareButton, openButton].every((node) => node.hidden)
  header.classList.toggle('mq-sr', bare)
}

/** Show an analysis; `keepPlace` when it replaces the same trace, grown. */
function show(analysis: TraceAnalysis, opened: Opened, keepPlace: boolean) {
  const place = keepPlace ? currentPlace() : null
  pendingScroll.clear()
  for (const [key, scroll] of place?.scroll ?? []) pendingScroll.set(key, scroll)
  shown = { analysis, opened }
  offerConnections(analysis)
  const messages = analysis.messages.filter((m) => connectionShown(m.peer)).length
  showViews(
    [
      {
        id: 'overview',
        label: 'Overview',
        render: () => {
          const panel = el('div', 'vw-overview')
          // Focusable because it scrolls; see `hexView`.
          panel.tabIndex = 0
          panel.dataset.keep = 'overview'
          const findings = renderFindings(analysis.findings)
          if (findings !== null) panel.append(findings)
          panel.append(renderSummary(analysis.summary, opened))
          const connections = renderConnections(analysis.connections)
          if (connections !== null) panel.append(connections)
          return panel
        },
      },
      {
        id: 'messages',
        label: 'Control messages',
        count: messages,
        render: () => renderMessages(analysis, place?.selected.get('message')),
      },
      {
        id: 'timeline',
        label: 'Timeline',
        render: () => renderTimelineTab(analysis),
      },
      {
        id: 'tracks',
        label: 'Tracks',
        count: analysis.tracks.filter((t) => connectionShown(t.connection)).length,
        render: () => renderTracks(analysis),
      },
      {
        id: 'streams',
        label: 'Streams and objects',
        count: analysis.streams.filter((s) => connectionShown(s.peer)).length,
        render: () => renderStreams(analysis, place?.selected.get('stream')),
      },
    ],
    place?.tab ?? null,
  )

  empty.hidden = true
  results.hidden = false
  errorBox.hidden = true
  delete dropZone.dataset.rejected
  setTitle(opened.name, opened.titled)
  const total = analysis.messages.length
  factsLine.textContent = `${count(total)} ${total === 1 ? 'message' : 'messages'} · ${bytes(opened.size)}`
  factsLine.hidden = false
  const { draft } = analysis.summary
  draftPill.textContent = draft === null ? '' : draftLabel(draft)
  draftPill.hidden = draft === null
}

/** The place a parent last asked for, so a replacement that repeats it keeps the reader's own. */
let asked: { t?: number | undefined; msg?: string | undefined } = {}

/**
 * Open where the parent asked: a message, else a moment on the timeline. On
 * a replacement only a place the parent changed is applied; one it repeats
 * would take the reader back from wherever they went since.
 */
function openAt(trace: IngestedTrace, replacing: boolean) {
  const previous = asked
  asked = { t: trace.t, msg: trace.msg }
  if (trace.t === undefined && trace.msg === undefined) return
  if (replacing && previous.t === trace.t && previous.msg === trace.msg) return
  if (shown === null) return
  const { messages } = shown.analysis
  const index =
    trace.msg === undefined ? -1 : messages.findIndex((m) => messageKey(m) === trace.msg)
  if (index >= 0) {
    gotoMessage(index, false)
    return
  }
  if (trace.t === undefined) return
  const us = trace.t * 1000
  const near = messageItems.findIndex((item) => item.message.at >= us)
  if (near >= 0) messagesPane?.select(near, true, false)
  if (timeline !== null) {
    selectTab?.('timeline')
    timeline.showTime(us)
  }
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
  connectionBar.hidden = true
  shown = null
  messagesPane = null
  timeline = null
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
  // A newer copy that fails leaves the trace on screen as it was.
  onReject: (reason, replace) => {
    if (replace !== true || results.hidden) fail(reason)
  },
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
  // A newer copy of the trace on screen is read behind it, so the page does
  // not blank and lose the reader's place each time the trace grows.
  const replacing = trace.replace === true && !results.hidden
  if (!replacing) working(opened)

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
      if (!replacing) {
        view.connection = null
        view.filter = ''
        timelineFrom = -1
      }
      show(event.data.analysis, opened, replacing)
      // A newer copy carries no marks of its own; the trace keeps the ones it
      // arrived with.
      if (!replacing) offerActions(trace)
      openAt(trace, replacing)
      ingest.report(trace, 'opened')
    } else {
      if (!replacing) fail(event.data.message)
      ingest.report(trace, 'failed')
    }
  })
  worker.addEventListener('error', () => {
    done()
    if (!replacing) fail("This file can't be read.")
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
  const request: AnalyzeRequest = {
    bytes: payload,
    ...(trace.pendingMs === undefined ? {} : { pendingMs: trace.pendingMs }),
  }
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
