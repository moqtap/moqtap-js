/**
 * Problems and error codes in words, so every tool that shows a session's
 * problems says the same thing about them.
 */

import { type InspectEvent, type Problem, requestIdOf } from './requests.js'

const THIN = '\u2009'

/** `draft-07`, `draft-14`: a draft as moqtap writes one. */
function draftLabel(draft: number): string {
  return `draft-${String(draft).padStart(2, '0')}`
}

/** `340 ms`, `7.2 s`, `2 min 5 s`. */
export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}${THIN}ms`
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}${THIN}s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}${THIN}min ${s % 60}${THIN}s`
}

/**
 * An error code as shown: `TRACK_DOES_NOT_EXIST (0x4)` when the draft names
 * it, `0x4, unknown for draft-14` when it does not, and `0x4` when the draft
 * is not known. Empty when there is no code.
 */
export function codeLabel(
  code: string | number | bigint | null,
  name: string | null,
  draft: number | null,
): string {
  if (code === null) return ''
  const hex = `0x${BigInt(code).toString(16)}`
  if (name !== null) return `${name} (${hex})`
  return draft === null ? hex : `${hex}, unknown for ${draftLabel(draft)}`
}

/**
 * How much a problem matters: `error` when something failed (an error
 * response, bytes that did not decode), `warning` when it may have.
 */
export function problemSeverity(kind: Problem<unknown>['kind']): 'error' | 'warning' {
  return kind === 'error' || kind === 'undecodable' ? 'error' : 'warning'
}

export interface WordingOptions<T> {
  /** The threshold `problems` was given. */
  readonly pendingMs: number
  readonly draft?: number | null | undefined
  /** Which end recorded the session: `client`, `server`, or unknown. */
  readonly perspective?: string | null | undefined
  /** The track a request names, as `namespace / name`, when the caller knows it. */
  readonly trackOf?: ((event: T) => string | undefined) | undefined
}

function upper(event: InspectEvent): string | null {
  return event.kind === 'undecodable' || event.name === null ? null : event.name.toUpperCase()
}

/** `SUBSCRIBE #14`. */
function requestLabel(event: InspectEvent): string {
  const name = upper(event) ?? 'Request'
  const id = event.kind === 'undecodable' ? null : requestIdOf(name, event.fields)
  return id === null ? name : `${name} #${id}`
}

/** Who sent a message, as a reader of the session says it. */
function sender(event: InspectEvent, perspective: string | null | undefined): string | null {
  const dir = event.direction
  if (dir === undefined) return null
  const sent = dir === 'tx' || dir === 0
  if (perspective === 'client') return sent ? 'from client' : 'from relay'
  if (perspective === 'server') return sent ? 'from relay' : 'from client'
  return sent ? 'sent' : 'received'
}

/**
 * A problem in one line: `SUBSCRIBE_ERROR TRACK_DOES_NOT_EXIST (0x4) "no
 * such track"`, `SUBSCRIBE #14: no response after 5 s`, `GOAWAY from relay →
 * moqt://b.example`.
 */
export function problemTitle<T extends InspectEvent>(
  problem: Problem<T>,
  options: WordingOptions<T>,
): string {
  switch (problem.kind) {
    case 'error': {
      const code = codeLabel(problem.code, problem.codeName, options.draft ?? null)
      const reason = problem.reason.length > 0 ? ` "${problem.reason}"` : ''
      return `${problem.message}${code === '' ? '' : ` ${code}`}${reason}`
    }
    case 'pending': {
      const label = requestLabel(problem.event)
      return problem.response === null
        ? `${label}: no response after ${durationText(options.pendingMs)}`
        : `${label}: response after ${durationText(problem.waitedMs)}`
    }
    case 'requests-blocked': {
      const name = upper(problem.event) ?? 'REQUESTS_BLOCKED'
      const at =
        problem.maximumRequestId === null ? '' : ` at request ID ${problem.maximumRequestId}`
      const times = problem.count > 1 ? ` (${problem.count} times)` : ''
      return `${name}${at}${times}`
    }
    case 'request-limit-reached':
      return `Request ID limit ${problem.limit} reached by ${requestLabel(problem.event)}`
    case 'goaway': {
      const from = sender(problem.event, options.perspective)
      const goaway = from === null ? 'GOAWAY' : `GOAWAY ${from}`
      return problem.newSessionUri === null ? goaway : `${goaway} → ${problem.newSessionUri}`
    }
    case 'undecodable':
      return `Undecodable bytes${problem.reason === null ? '' : `: ${problem.reason}`}`
  }
}

/**
 * What the title leaves out: for an error, the request it answers and how
 * long that took; for a pending request, its track. `null` when there is
 * nothing more to say.
 */
export function problemDetail<T extends InspectEvent>(
  problem: Problem<T>,
  options: WordingOptions<T>,
): string | null {
  const track = (event: T): string => {
    const shown = options.trackOf?.(event)
    return shown === undefined || shown === '' ? '' : ` ${shown}`
  }
  if (problem.kind === 'error') {
    const request = problem.request
    if (request === null) return null
    const sent = request.atMs
    const answered = problem.event.atMs
    const after =
      sent === undefined || answered === undefined ? '' : ` after ${durationText(answered - sent)}`
    return `Answers ${requestLabel(request)}${track(request)}${after}`
  }
  if (problem.kind === 'pending') {
    const shown = track(problem.event).trim()
    return shown === '' ? null : shown
  }
  return null
}
