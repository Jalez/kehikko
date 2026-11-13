import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'

import { ADOPT_ROUTES } from '../server/adoptRoutes.ts'
import { Inbox } from '../server/inbox.ts'
import { INBOX_POSTS, inboxDesk } from '../server/inboxRoutes.ts'

/**
 * The inbox desk and the adopt desk share `/host/inbox/…`, and the inbox desk is asked first. It read
 * every POST's body under that prefix before looking at the path, so the adopt desk that owned the
 * path read an already used body and threw — every Adopt, Untrack, Undo and agent start answered a
 * bare 500 that nothing logged. A desk leaves a body it does not answer unread.
 */

const desk = () => inboxDesk({ inbox: new Inbox(new Database(':memory:')), pathOf: () => '/tmp/p', changed: () => {} })

const post = (path: string) =>
  new Request(`http://127.0.0.1:4180${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 1, module: 'm', id: 'i' }) })

describe('a POST under /host/inbox that another desk owns', () => {
  for (const path of ADOPT_ROUTES) {
    test(`${path}: not answered by the inbox desk, and its body is left for its own`, async () => {
      const request = post(path)
      expect(await desk().route(request, new URL(request.url))).toBeNull()
      expect(request.bodyUsed).toBe(false)
      expect(await request.json()).toEqual({ project: 1, module: 'm', id: 'i' })
    })
  }

  test('the inbox desk’s own POSTs and the adopt desk’s do not overlap', () => {
    expect(INBOX_POSTS.filter((one) => (ADOPT_ROUTES as readonly string[]).includes(one))).toEqual([])
  })

  for (const path of INBOX_POSTS) {
    test(`${path}: the inbox desk answers its own`, async () => {
      const request = post(path)
      expect(await desk().route(request, new URL(request.url))).not.toBeNull()
    })
  }
})
