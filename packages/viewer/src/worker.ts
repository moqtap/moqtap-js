/**
 * Decoding, off the main thread.
 *
 * A capture is routinely tens of megabytes and CBOR decoding is not
 * interruptible, so doing this inline freezes the frame for as long as it
 * takes, including the drop animation and the message that says work is
 * happening. The worker keeps the page answering while the file is read.
 *
 * Built to its own file, `worker.js`, and started from the view origin's own
 * URL, so the view CSP needs `worker-src 'self'` and never `blob:`.
 */

import { analyze, type TraceAnalysis } from './analysis'
import tables from './data/message-tables.json'
import type { MessageTables } from './drafts'
import { readTrace } from './read'

export interface AnalyzeRequest {
  readonly bytes: ArrayBuffer
}

export type AnalyzeResponse =
  | { readonly ok: true; readonly analysis: TraceAnalysis }
  | { readonly ok: false; readonly message: string }

/**
 * Decode and analyse, turning any failure into a message.
 *
 * The registries are imported here rather than on the page: only the worker
 * reads them, and keeping them out of `main.js` means a frame that is never
 * sent a trace never loads them.
 */
export function handle(request: AnalyzeRequest): AnalyzeResponse {
  try {
    const { segments, formatVersion, truncatedAt } = readTrace(new Uint8Array(request.bytes))
    return {
      ok: true,
      analysis: analyze({
        segments,
        formatVersion,
        tables: tables as unknown as MessageTables,
        ...(truncatedAt === undefined ? {} : { truncatedAt }),
      }),
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'The file could not be decoded.',
    }
  }
}

// Guarded so the module can be imported by a test, where `self` is not a
// worker scope.
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.addEventListener('message', (event: MessageEvent<AnalyzeRequest>) => {
    self.postMessage(handle(event.data))
  })
}

declare const WorkerGlobalScope: { new (): unknown; prototype: unknown } | undefined
