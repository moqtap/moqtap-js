/**
 * The Timeline tab: one control lane and one lane per track for each
 * connection, on one time axis.
 *
 * Track lanes are drawn in the collector's rollup intervals (10 s by
 * default). A rollup counts stalls and group ID gaps per interval without
 * placing them, so a cell with either is shaded whole and labelled with what
 * it holds, stalls by histogram bucket ("stall 2–4 s"). Only a flight dump
 * places objects exactly, and its detail is drawn inside its own window.
 * Bands mark where the collector raised its detail, so a stretch without
 * object detail outside them reads as the baseline it was.
 *
 * SVG built from attributes: the view origin's CSP refuses inline styles,
 * and every class here is in `styles.css`.
 */

import type { MessageRow, TraceAnalysis, TrackRow } from './analysis'
import { el, svg } from './dom'
import { bucketRange, count, duration, heading, offset } from './format'
import { axisTicks, densityStep, isErrorRow } from './navigate'
import type { Cell, Flight, Lane, PlayerEvent } from './rollups'

/** Height of one row, in px; `styles.css` gives the label rows the same. */
const ROW = 22
/** At least this many px per second, so a 10 s cell stays wide enough to click. */
const PX_PER_SECOND = 2
/** The width drawn before the tab is on screen to measure. */
const MIN_WIDTH = 720
/** A marked cell at least this wide carries its label inside it. */
const LABELLED_CELL = 72

export interface TimelineOptions {
  readonly analysis: TraceAnalysis
  /** The connection shown, or `null` for all of them. */
  readonly connection: string | null
  readonly connectionLabel: (id: string) => string
  /** A control message's mark was chosen. */
  readonly onMessage: (index: number) => void
  /** The reader chose a moment: a cell, or a mark. Microseconds from the start. */
  readonly onTime: (us: number) => void
}

export interface TimelineHandle {
  readonly node: HTMLElement
  /** The cells drawn, in time order, for `g`. */
  readonly cells: readonly Cell[]
  /** Draw the cursor at a moment and bring it into view. */
  showTime(us: number): void
  /** Select a cell: cursor, outline and detail line. */
  selectCell(cell: Cell): void
}

type Row =
  | { readonly kind: 'axis' }
  | { readonly kind: 'bands' }
  | { readonly kind: 'group'; readonly connection: string }
  | { readonly kind: 'control'; readonly connection: string }
  | { readonly kind: 'lane'; readonly lane: Lane }
  | { readonly kind: 'flight'; readonly lane: Lane }

/** What a cell holds, in words: `412 objects · stall 2–4 s · 1 group ID gap`. */
export function cellLabel(cell: Cell): string {
  const parts = [`${count(cell.objects)} ${cell.objects === 1 ? 'object' : 'objects'}`]
  const marks = cellMarks(cell)
  if (marks.length > 0) parts.push(marks)
  if (cell.skipped > 0) parts.push(`${count(cell.skipped)} skipped`)
  return parts.join(' · ')
}

/** What marks a cell: `stall 2–4 s · 1 group ID gap`, or `''`. */
export function cellMarks(cell: Cell): string {
  const parts: string[] = []
  if (cell.stalls > 0 && cell.longestStall !== null) {
    const more = cell.stalls > 1 ? ` (${cell.stalls} stalls)` : ''
    parts.push(`stall ${bucketRange(cell.longestStall)}${more}`)
  }
  if (cell.groupGaps > 0) {
    parts.push(`${count(cell.groupGaps)} group ID ${cell.groupGaps === 1 ? 'gap' : 'gaps'}`)
  }
  return parts.join(' · ')
}

/** A lane's name: its track, or its alias or fetch when no request named it, and which way. */
export function laneLabel(lane: Lane, tracks: readonly TrackRow[]): string {
  const track = tracks.find((t) => t.lanes.includes(lane.key))
  const { stats } = lane
  const name =
    track !== undefined && track.name.length > 0
      ? track.name
      : stats.kind === 'alias'
        ? `alias ${stats.id}`
        : `fetch #${stats.id}`
  return stats.direction === 'tx' ? `${name} (sent)` : name
}

/** `headers · stall · 15.0 s`: the level, what raised it, and for how long. */
export function bandLabel(level: string, cause: string | null, us: number, open: boolean): string {
  return [level, cause, open ? `${duration(us)} so far` : duration(us)]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

export function renderTimeline(options: TimelineOptions): TimelineHandle {
  const { analysis, connection } = options
  const { delivery } = analysis
  const shown = (id: string | undefined) => connection === null || (id ?? '') === connection

  const connections =
    connection !== null
      ? [connection]
      : analysis.connections.length > 0
        ? analysis.connections.map((c) => c.id)
        : ['']
  const lanes = delivery.lanes.filter((lane) => shown(lane.connection))
  const laneKeys = new Set(lanes.map((lane) => lane.key))
  const cells = delivery.cells.filter((cell) => laneKeys.has(cell.lane))
  const flights = delivery.flights.filter((flight) => shown(flight.connection))
  const players = delivery.playerEvents.filter(
    (event) => event.connection === undefined || shown(event.connection),
  )
  // A trace that does not tell connections apart has one group for all.
  const inGroup = (peer: string | undefined, id: string) =>
    analysis.connections.length === 0 || (peer ?? '') === id

  const lastCell = cells.reduce((end, cell) => Math.max(end, cell.to), 0)
  const spanUs = Math.max(analysis.endUs, lastCell, 1_000_000)
  const fewest = Math.ceil((spanUs / 1e6) * PX_PER_SECOND)

  const rows: Row[] = [{ kind: 'axis' }]
  if (delivery.bands.length > 0) rows.push({ kind: 'bands' })
  for (const id of connections) {
    if (connections.length > 1) rows.push({ kind: 'group', connection: id })
    rows.push({ kind: 'control', connection: id })
    for (const lane of lanes.filter((l) => l.connection === id)) {
      rows.push({ kind: 'lane', lane })
      if (flights.some((f) => f.objects.some((o) => o.lane === lane.key))) {
        rows.push({ kind: 'flight', lane })
      }
    }
  }
  const height = rows.length * ROW

  const node = el('div', 'vw-timeline')
  const grid = el('div', 'vw-tl')
  const labels = el('div', 'vw-tl-labels')
  labels.setAttribute('aria-hidden', 'true')
  const scroller = el('div', 'vw-tl-scroll')
  scroller.tabIndex = 0
  scroller.setAttribute('role', 'region')
  scroller.setAttribute('aria-label', 'Timeline')
  scroller.dataset.keep = 'timeline'
  const chart = svg('svg', { height, class: 'vw-tl-svg' })
  chart.setAttribute('role', 'img')
  chart.setAttribute('aria-label', 'Session timeline')
  scroller.append(chart)
  grid.append(labels, scroller)
  const detail = el('p', 'vw-tl-detail mq-mono')
  detail.setAttribute('aria-live', 'polite')
  node.append(grid, detail)
  for (const row of rows) labels.append(rowLabel(row))

  const busiest = new Map<string, number>()
  for (const cell of cells) {
    const rate = cell.objects / Math.max(1, cell.to - cell.from)
    busiest.set(cell.lane, Math.max(busiest.get(cell.lane) ?? 0, rate))
  }

  let width = 0
  let x = (us: number) => us
  let cursorUs: number | null = null
  let selected: Cell | null = null
  const cellNodes = new Map<Cell, SVGRectElement>()
  const cursor = svg('line', { y1: 0, y2: height, class: 'vw-tl-cursor' })

  /** Draw everything at a width; again whenever the space for it changes. */
  function draw(to: number) {
    width = to
    x = (us: number) => Math.max(0, Math.min(width, (us / spanUs) * width))
    chart.setAttribute('width', String(width))
    chart.replaceChildren()
    cellNodes.clear()
    const back = svg('g')
    const front = svg('g')
    chart.append(back, front, cursor)

    // Bands first, behind every row, then the axis grid.
    for (const band of delivery.bands) {
      back.append(
        svg('rect', {
          x: x(band.from),
          y: ROW,
          width: Math.max(1, x(band.to ?? spanUs) - x(band.from)),
          height: height - ROW,
          class: 'vw-tl-band',
        }),
      )
    }
    for (const at of axisTicks(spanUs)) {
      back.append(svg('line', { x1: x(at), x2: x(at), y1: 0, y2: height, class: 'vw-tl-grid' }))
    }

    rows.forEach((row, index) => {
      const y = index * ROW
      switch (row.kind) {
        case 'axis':
          for (const at of axisTicks(spanUs)) {
            const text = svg('text', { x: x(at) + 3, y: 15, class: 'vw-tl-tick' })
            text.textContent = offset(at).replace(/\.000$/, '')
            front.append(text)
          }
          break
        case 'bands':
          for (const band of delivery.bands) {
            const end = band.to ?? spanUs
            const rect = svg('rect', {
              x: x(band.from),
              y: y + 4,
              width: Math.max(2, x(end) - x(band.from)),
              height: ROW - 8,
              class: 'vw-tl-band-mark',
            })
            const label = bandLabel(band.level, band.cause, end - band.from, band.to === null)
            rect.append(title(label))
            front.append(rect)
            if (x(end) - x(band.from) >= LABELLED_CELL) {
              const text = svg('text', {
                x: x(band.from) + 4,
                y: y + 15,
                class: 'vw-tl-cell-label',
              })
              text.textContent = label
              front.append(text)
            }
          }
          break
        case 'group':
          break
        case 'control':
          drawControl(front, row.connection, y)
          break
        case 'lane':
          drawLane(front, row.lane, y)
          break
        case 'flight':
          drawFlights(front, row.lane, y)
          break
      }
    })

    if (selected !== null) cellNodes.get(selected)?.classList.add('vw-tl-cell--selected')
    placeCursor()
  }

  function rowLabel(row: Row): HTMLElement {
    switch (row.kind) {
      case 'axis':
        return el('div', 'vw-tl-label')
      case 'bands':
        return el('div', 'vw-tl-label mq-muted', 'Detail raised')
      case 'group': {
        const text = options.connectionLabel(row.connection)
        const div = el('div', 'vw-tl-label vw-tl-label--group', text)
        div.title = text
        return div
      }
      case 'control':
        return el('div', 'vw-tl-label', 'Control')
      case 'lane': {
        const label = laneLabel(row.lane, analysis.tracks)
        const div = el('div', 'vw-tl-label mq-mono', label)
        div.title = label
        return div
      }
      case 'flight':
        return el('div', 'vw-tl-label mq-muted', 'Objects')
    }
  }

  function drawControl(into: SVGGElement, id: string, y: number) {
    analysis.messages.forEach((message, index) => {
      if (inGroup(message.peer, id)) into.append(controlMark(message, index, y))
    })
    for (const problem of analysis.problems) {
      if (problem.kind !== 'pending' || problem.at === null) continue
      if (!inGroup(problem.connection, id)) continue
      const mark = svg('circle', {
        cx: x(problem.at),
        cy: y + ROW / 2,
        r: 3,
        class: 'vw-tl-pending',
      })
      mark.append(title(problem.title))
      into.append(mark)
    }
    for (const event of players) {
      if (event.connection !== undefined && event.connection !== id) continue
      into.append(playerMark(event, y))
    }
  }

  function controlMark(message: MessageRow, index: number, y: number): SVGGElement {
    const at = x(message.at)
    const error = isErrorRow(message)
    const side =
      message.direction === null
        ? 'none'
        : heading(message.direction, analysis.summary.perspective).side
    const g = svg('g', { class: 'vw-tl-msg' })
    g.append(
      svg('line', {
        x1: at,
        x2: at,
        y1: y + (error ? 2 : 6),
        y2: y + ROW - (error ? 2 : 6),
        class: error ? 'vw-tl-msg-error' : `vw-tl-msg-${side}`,
      }),
      // A wider, invisible target, so a one-pixel mark can be clicked.
      svg('rect', { x: at - 3, y, width: 6, height: ROW, class: 'vw-tl-hit' }),
    )
    const name = message.name ?? (message.undecodable !== undefined ? 'Undecodable bytes' : '?')
    const track = message.track === undefined ? '' : ` ${message.track}`
    g.append(title(`${offset(message.at)} ${name}${track}`))
    g.addEventListener('click', () => {
      selectNone()
      cursorAt(message.at)
      detail.textContent = `${offset(message.at)} · ${name}${track}`
      options.onMessage(index)
    })
    return g
  }

  function playerMark(event: PlayerEvent, y: number): SVGGElement {
    const at = x(event.at)
    const mid = y + ROW / 2
    const g = svg('g', { class: 'vw-tl-player' })
    g.append(
      svg('polygon', {
        points: `${at},${mid - 5} ${at + 5},${mid} ${at},${mid + 5} ${at - 5},${mid}`,
      }),
    )
    const label = svg('text', { x: at + 7, y: mid + 4, class: 'vw-tl-player-label' })
    label.textContent = event.label
    g.append(label)
    const data = event.data === undefined ? '' : ` · ${event.data}`
    g.append(title(`${offset(event.at)} ${event.label}${data}`))
    g.addEventListener('click', () => {
      selectNone()
      cursorAt(event.at)
      detail.textContent = `${offset(event.at)} · ${event.label}${data}`
      options.onTime(event.at)
    })
    return g
  }

  function drawLane(into: SVGGElement, lane: Lane, y: number) {
    for (const cell of cells) {
      if (cell.lane !== lane.key) continue
      const rate = cell.objects / Math.max(1, cell.to - cell.from)
      const step = densityStep(rate, busiest.get(cell.lane) ?? 0)
      const marks = cellMarks(cell)
      const left = x(cell.from)
      const wide = Math.max(1, x(cell.to) - left - 1)
      const rect = svg('rect', {
        x: left,
        y: y + 3,
        width: wide,
        height: ROW - 6,
        class: `vw-tl-cell vw-tl-d${step}${marks.length > 0 ? ' vw-tl-cell--marked' : ''}`,
      })
      rect.append(title(`${offset(cell.from)}–${offset(cell.to)} · ${cellLabel(cell)}`))
      rect.addEventListener('click', () => {
        select(cell)
        options.onTime(cell.from)
      })
      cellNodes.set(cell, rect)
      into.append(rect)
      if (marks.length > 0 && wide >= LABELLED_CELL) {
        const text = svg('text', { x: left + 4, y: y + 15, class: 'vw-tl-cell-label' })
        text.textContent = marks
        const clip = svg('clipPath', { id: `vw-clip-${cellNodes.size}-${Math.round(left)}` })
        clip.append(svg('rect', { x: left, y, width: wide, height: ROW }))
        text.setAttribute('clip-path', `url(#${clip.id})`)
        into.append(clip, text)
      }
    }
  }

  function drawFlights(into: SVGGElement, lane: Lane, y: number) {
    for (const flight of flights) {
      const objects = flight.objects.filter((o) => o.lane === lane.key)
      if (objects.length === 0) continue
      const frame = svg('rect', {
        x: x(flight.from),
        y: y + 2,
        width: Math.max(1, x(flight.to) - x(flight.from)),
        height: ROW - 4,
        class: 'vw-tl-flight',
      })
      frame.append(title(flightLabel(flight, objects.length)))
      into.append(frame)
      for (const stall of flight.stalls) {
        if (stall.lane !== lane.key) continue
        const rect = svg('rect', {
          x: x(stall.from),
          y: y + 4,
          width: Math.max(1, x(stall.to) - x(stall.from)),
          height: ROW - 8,
          class: 'vw-tl-flight-stall',
        })
        rect.append(title(`stall ${duration(stall.to - stall.from)} at ${offset(stall.from)}`))
        into.append(rect)
      }
      for (const object of objects) {
        const at = x(object.at)
        into.append(
          svg('line', { x1: at, x2: at, y1: y + 6, y2: y + ROW - 6, class: 'vw-tl-object' }),
        )
      }
    }
  }

  function placeCursor() {
    if (cursorUs === null) {
      cursor.setAttribute('visibility', 'hidden')
      return
    }
    const at = String(x(cursorUs))
    cursor.setAttribute('x1', at)
    cursor.setAttribute('x2', at)
    cursor.setAttribute('visibility', 'visible')
  }

  function cursorAt(us: number) {
    cursorUs = us
    placeCursor()
  }

  function bringIntoView(us: number) {
    const at = x(us)
    const view = scroller.clientWidth
    if (at < scroller.scrollLeft || at > scroller.scrollLeft + view - 40) {
      scroller.scrollLeft = Math.max(0, at - view / 3)
    }
  }

  function selectNone() {
    if (selected !== null) cellNodes.get(selected)?.classList.remove('vw-tl-cell--selected')
    selected = null
  }

  function select(cell: Cell) {
    selectNone()
    selected = cell
    cellNodes.get(cell)?.classList.add('vw-tl-cell--selected')
    cursorAt(cell.from)
    const lane = lanes.find((l) => l.key === cell.lane)
    const name = lane === undefined ? '' : `${laneLabel(lane, analysis.tracks)} · `
    detail.textContent = `${name}${offset(cell.from)}–${offset(cell.to)} · ${cellLabel(cell)}`
  }

  draw(Math.max(MIN_WIDTH, fewest))
  // Drawn to fill the space it is given, which is known only once the tab is
  // on screen, and redrawn when that space changes.
  new ResizeObserver(() => {
    const room = scroller.clientWidth
    if (room === 0) return
    const to = Math.max(room, fewest)
    if (to !== width) draw(to)
  }).observe(scroller)

  return {
    node,
    cells: [...cells].sort((a, b) => a.from - b.from),
    showTime(us) {
      cursorAt(us)
      bringIntoView(us)
    },
    selectCell(cell) {
      select(cell)
      bringIntoView(cell.from)
    },
  }
}

function title(text: string): SVGTitleElement {
  const node = svg('title')
  node.textContent = text
  return node
}

function flightLabel(flight: Flight, objects: number): string {
  const trigger = flight.trigger.length > 0 ? `${flight.trigger} · ` : ''
  const cut = flight.truncated ? ' · cut short' : ''
  return `${trigger}${offset(flight.from)}–${offset(flight.to)} · ${count(objects)} objects${cut}`
}
