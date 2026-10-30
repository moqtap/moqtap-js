import { describe, expect, it } from 'vitest'
import { problems } from '../requests.js'
import { messageSpec, specUrl } from '../specs.js'

describe('messageSpec', () => {
  it('pins the section defining a message to the draft revision', () => {
    expect(messageSpec(22, 'request_error')).toEqual({
      draft: 'moqt',
      revision: '22',
      section: '9.4',
      keyword: null,
      quote:
        'The REQUEST_ERROR message is sent in response to any request (SUBSCRIBE, FETCH, PUBLISH, SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS, PUBLISH_NAMESPACE, TRACK_STATUS, REQUEST_UPDATE).',
    })
    expect(messageSpec(7, 'GOAWAY')).toMatchObject({ revision: '07', section: '6.3' })
    expect(messageSpec(14, 'MAX_REQUEST_ID')).toMatchObject({ section: '9.5' })
    expect(messageSpec(10, 'subscribes_blocked')).toMatchObject({ section: '8.5' })
  })

  it('gives nothing for an unknown draft or a message the draft does not define', () => {
    expect(messageSpec(null, 'GOAWAY')).toBeNull()
    expect(messageSpec(99, 'GOAWAY')).toBeNull()
    expect(messageSpec(22, 'MAX_REQUEST_ID')).toBeNull()
    expect(messageSpec(22, 'SUBSCRIBE_ERROR')).toBeNull()
  })

  it('links the pinned revision on datatracker', () => {
    const ref = messageSpec(22, 'GOAWAY')!
    expect(specUrl(ref)).toBe(
      'https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-22#section-9.2',
    )
  })
})

describe('problem ids and refs', () => {
  it('cites MAX_SUBSCRIBE_ID for a draft-07 limit and leaves pending requests without a ref', () => {
    const limit = {
      name: 'max_subscribe_id',
      fields: { subscribe_id: 1n },
      direction: 'rx' as const,
    }
    const sub = {
      name: 'subscribe',
      fields: { subscribe_id: 0n },
      direction: 'tx' as const,
      atMs: 0,
    }
    const found = problems([limit, sub], { pendingMs: 10, draft: 7, endMs: 100 })
    expect(found.map((p) => [p.id, p.spec?.section])).toEqual([
      ['session.request-limit-reached', '6.20'],
      ['session.pending', undefined],
    ])
  })

  it('has no ref when the draft is not known', () => {
    const goaway = { name: 'goaway', fields: {} }
    expect(problems([goaway], { pendingMs: 10 })[0]).not.toHaveProperty('spec')
  })
})
