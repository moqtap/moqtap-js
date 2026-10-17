/**
 * The viewer page: open a trace, hand it to the worker, render what comes back.
 *
 * Every string rendered here comes out of a file someone else wrote, so text
 * goes in through `textContent` and nothing else: no `innerHTML`, no
 * templates, no attribute built from trace content except the one link `href`,
 * which is built from the registry and not from the trace.
 */

import type { Finding, MessageRow, SessionSummary, TraceAnalysis } from './analysis'
import { bytes, direction, duration, instant, offset } from './format'
import { type IngestedTrace, ingestFile, type ShareCandidate, startIngest } from './ingest'
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

const fileInputs = [
  byId<HTMLInputElement>('file-input'),
  byId<HTMLInputElement>('empty-file-input'),
]
const fileChip = byId<HTMLSpanElement>('file-chip')
const shareButton = byId<HTMLButtonElement>('share')
const openButton = byId<HTMLLabelElement>('open-capture')
const tabStrip = byId<HTMLElement>('tabs')
const surface = byId<HTMLElement>('surface')
const empty = byId<HTMLDivElement>('empty')
const errorLine = byId<HTMLParagraphElement>('error')
const results = byId<HTMLDivElement>('results')
const overlay = byId<HTMLDivElement>('drop-overlay')

const SOURCE_LABEL: Record<IngestedTrace['source'], string> = {
  file: 'opened from this machine',
  parent: 'sent by the page around this viewer',
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

function facts(rows: [string, string][]): HTMLDListElement {
  const list = el('dl', 'facts')
  for (const [term, value] of rows) list.append(el('dt', undefined, term), el('dd', 'mono', value))
  return list
}

function heading(text: string): HTMLElement {
  return el('h2', 'section-heading', text)
}

// -------------------------------------------------------------- findings ---

const SEVERITY_ORDER = { error: 0, warning: 1, note: 2 } as const
const SEVERITY_LABEL: Record<Finding['severity'], string> = {
  error: 'Error',
  warning: 'Check',
  note: 'Note',
}

function renderFindings(findings: readonly Finding[]): HTMLElement {
  const node = el('section')
  node.append(heading('What this file says about itself'))
  if (findings.length === 0) {
    node.append(
      el(
        'p',
        'muted',
        'Nothing to flag. No errors, no dropped events, no ambiguity this page knows how to spot.',
      ),
    )
    return node
  }
  const list = el('div', 'findings')
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  )
  for (const finding of sorted) {
    const card = el('div', `finding finding-${finding.severity}`)
    const head = el('div', 'finding-head')
    head.append(
      el('span', 'finding-label', SEVERITY_LABEL[finding.severity]),
      el('span', 'finding-title', finding.title),
    )
    card.append(head, el('p', 'finding-detail', finding.detail))
    list.append(card)
  }
  node.append(list)
  return node
}

// --------------------------------------------------------------- summary ---

function renderSummary(summary: SessionSummary): HTMLElement {
  const node = el('section')
  node.append(heading('Session'))

  const counts = Object.entries(summary.eventCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${type} ${n}`)
    .join(' · ')

  const rows: [string, string][] = [
    [
      'Protocol',
      summary.draft === null ? summary.protocol : `${summary.protocol} (draft ${summary.draft})`,
    ],
    ['Perspective', summary.perspective],
    ['Detail level', summary.detail],
    [
      'Format',
      `version ${summary.formatVersion}${summary.segments > 1 ? `, ${summary.segments} segments` : ''}`,
    ],
    ['Started', instant(summary.startTime)],
    // "Event span", not "duration": this measures first event to last, which
    // is not the session's length. A recorder that opened its file seconds
    // before the first message makes the two differ, and the offsets in the
    // message log are from the header's start time.
    [
      'Event span',
      summary.durationUs === undefined ? 'not recorded' : duration(summary.durationUs),
    ],
  ]
  if (summary.source !== undefined) rows.push(['Recorder', summary.source])
  if (summary.endpoint !== undefined) rows.push(['Endpoint', summary.endpoint])
  if (summary.transport !== undefined) rows.push(['Transport', summary.transport])
  if (summary.sessionId !== undefined) rows.push(['Session ID', summary.sessionId])
  rows.push(['Streams', String(summary.streams)])
  rows.push([
    'Objects',
    `${summary.objects}${summary.payloadBytes > 0 ? ` · ${bytes(summary.payloadBytes)}` : ''}`,
  ])
  if (summary.tracks.length > 0) rows.push(['Track aliases', summary.tracks.join(', ')])
  if (summary.peers.length > 0) rows.push(['Peers', summary.peers.join(', ')])

  node.append(facts(rows), el('p', 'muted', counts))
  return node
}

// -------------------------------------------------------------- messages ---

function renderMessages(messages: readonly MessageRow[], draft: number | null): HTMLElement {
  const node = el('section')
  if (messages.length === 0) {
    node.append(
      heading('Control messages'),
      el(
        'p',
        'muted',
        'None recorded. A trace taken below the session layer, or one filtered to data events, legitimately has none.',
      ),
    )
    return node
  }
  const list = el('div', 'messages')
  for (const message of messages) list.append(renderMessage(message, draft))
  node.append(list)
  return node
}

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

function renderMessage(message: MessageRow, draft: number | null): HTMLElement {
  const wrapper = el('details', 'message')
  const head = el('summary', 'message-head')

  head.append(el('span', 'mono small muted', offset(message.timestamp)))
  head.append(
    el(
      'span',
      `mono small ${message.direction === 0 ? 'dir-sent' : 'dir-received'}`,
      direction(message.direction),
    ),
  )

  const hex = `0x${message.messageType.toString(16)}`
  const href =
    message.name !== null && message.specPath !== null ? specHref(message.specPath) : null
  if (message.name !== null && href !== null) {
    const link = el('a', 'message-name spec-link', message.name)
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
    link.title = `Draft ${draft}: ${message.name} (opens in a new tab)`
    head.append(link)
  } else {
    head.append(el('span', 'message-name', message.name ?? hex))
  }
  if (message.name !== null) head.append(el('span', 'mono small muted', hex))
  if (message.reserved) {
    head.append(
      el(
        'span',
        'small warn',
        message.note === null ? 'reserved code point' : `reserved: ${message.note}`,
      ),
    )
  }
  if (message.streamId !== undefined) {
    head.append(el('span', 'mono small muted', `stream ${message.streamId}`))
  }
  if (message.peer !== undefined) head.append(el('span', 'mono small muted', message.peer))

  wrapper.append(head)

  const body = el('div', 'message-body')
  if (href !== null) {
    // The address as text as well, so it can be copied, and so the spec is
    // still reachable under a parent whose sandbox refuses popups.
    body.append(el('p', 'mono small muted spec-address', href))
  }
  if (message.fields !== undefined) {
    body.append(el('pre', 'mono small', JSON.stringify(message.fields, null, 2)))
  } else if (message.opaque !== undefined) {
    // No explanation beside it: that belongs to the recorder, not to this
    // message, and the `opaque-messages` finding states it once.
    body.append(el('pre', 'mono small wrap', message.opaque))
  } else {
    body.append(el('p', 'small muted', 'The recorder decoded no fields for this message.'))
  }
  wrapper.append(body)
  return wrapper
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
  const panels = new Map<string, HTMLElement>()

  const select = (id: string) => {
    for (const [panelId, panel] of panels) panel.hidden = panelId !== id
    for (const tab of Array.from(tabStrip.children)) {
      const on = (tab as HTMLElement).dataset.view === id
      tab.classList.toggle('tab-on', on)
      tab.setAttribute('aria-selected', String(on))
    }
    // Switching view puts you at the top of it, not at the scroll position
    // the previous one happened to be left at.
    surface.scrollTop = 0
  }

  results.replaceChildren()
  for (const view of views) {
    const panel = view.render()
    panel.hidden = true
    panels.set(view.id, panel)
    results.append(panel)

    const tab = el('button', 'tab')
    tab.type = 'button'
    tab.dataset.view = view.id
    tab.setAttribute('role', 'tab')
    tab.append(el('span', undefined, view.label))
    if (view.count !== undefined) tab.append(el('span', 'mono small muted', String(view.count)))
    tab.addEventListener('click', () => select(view.id))
    tabStrip.append(tab)
  }

  tabStrip.hidden = false
  select(views[0]!.id)
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
}

function show(analysis: TraceAnalysis, opened: Opened) {
  showViews([
    {
      id: 'overview',
      label: 'Overview',
      render: () => {
        const panel = el('div', 'overview')
        panel.append(renderFindings(analysis.findings), renderSummary(analysis.summary))
        return panel
      },
    },
    {
      id: 'messages',
      label: 'Control messages',
      count: analysis.messages.length,
      render: () => renderMessages(analysis.messages, analysis.summary.draft),
    },
  ])

  empty.hidden = true
  results.hidden = false
  errorLine.hidden = true
  fileChip.textContent = `${opened.name} · ${bytes(opened.size)} · ${SOURCE_LABEL[opened.source]}`
  fileChip.hidden = false
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
}

function fail(message: string) {
  // Back to the empty state, which is where the error belongs: the previous
  // file's analysis left on screen under a new file's error reads as though
  // the error were about what is shown.
  results.hidden = true
  tabStrip.hidden = true
  fileChip.hidden = true
  offerActions(null)
  empty.hidden = false
  errorLine.textContent = message
  errorLine.hidden = false
}

function working(name: string) {
  offerActions(null)
  errorLine.hidden = true
  fileChip.textContent = `Reading ${name}…`
  fileChip.hidden = false
}

// One worker per file rather than one for the page: a capture large enough to
// be worth a worker is also large enough that abandoning it mid-decode is the
// only way to open a second file promptly.
let current: Worker | null = null

const ingest = startIngest({ onTrace: analyze, onReject: fail })
offerActions(null)

function analyze(trace: IngestedTrace) {
  current?.terminate()
  const opened: Opened = {
    name: trace.name ?? 'Capture',
    size: trace.bytes.byteLength,
    source: trace.source,
  }
  working(opened.name)

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
    fail('The decoder stopped unexpectedly. The file may be a .moqtrace this page cannot read.')
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
    fail(e instanceof Error ? e.message : 'That file could not be read.')
  }
}

for (const input of fileInputs) {
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
