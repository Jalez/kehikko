import { describe, expect, test } from 'bun:test'
import { HOLD_COVER_MS, MESSAGE } from 'kehikot-module-protocol'

import { Conversation, type ConversationWatcher } from '@/host/conversation.ts'
import { toWireContext } from '@/host/context.ts'
import { showing } from '@/host/standing.ts'

/**
 * Protocol 2.70.0: a page that answers `ready { hold: true }` keeps the host's
 * loading cover up until it says `kehikot.drawn`, or until the host stops
 * waiting. A `ready` without `hold` lifts it at once, as before.
 */

const ID = 'kehikot.example'
const context = toWireContext({ epic: null, project: null }, 'dark')

function aConversation(holdCoverMs = 30) {
  const window = { postMessage() {} } as unknown as Window
  const seen: string[] = []
  const watcher: ConversationWatcher = {
    ready: (_protocol, _build, hold) => seen.push(hold ? 'ready held' : 'ready'),
    drawn: () => seen.push('drawn'),
    silent: () => seen.push('silent'),
    fault: () => {},
    height: () => {},
    filters: () => {},
    clearable: () => {},
    refreshable: () => {},
    header: () => {},
  }
  const conversation = new Conversation({ contentWindow: window }, ID, null, async () => ({ ok: true, data: null }), watcher, {
    readyTimeoutMs: 1000,
    holdCoverMs,
  })
  const say = (data: unknown) => conversation.receive({ source: window, origin: 'null', data })
  conversation.greet(context)
  return { conversation, seen, say }
}

describe('the cover held until the page is drawn', () => {
  test('the host waits as long as the protocol asks by default', () => {
    expect(HOLD_COVER_MS).toBe(3000)
  })

  test('hold, then drawn: the cover comes off on drawn, once', async () => {
    const at = aConversation(1000)
    try {
      at.say({ type: MESSAGE.READY, id: ID, protocol: 2, hold: true })
      expect(at.seen).toEqual(['ready held'])
      at.say({ type: MESSAGE.DRAWN })
      expect(at.seen).toEqual(['ready held', 'drawn'])
      /* A second drawn is dropped. */
      at.say({ type: MESSAGE.DRAWN })
      expect(at.seen).toEqual(['ready held', 'drawn'])
    } finally {
      at.conversation.close()
    }
  })

  test('hold, then nothing: the cover comes off when the host stops waiting', async () => {
    const at = aConversation(30)
    try {
      at.say({ type: MESSAGE.READY, id: ID, protocol: 2, hold: true })
      expect(at.seen).toEqual(['ready held'])
      await Bun.sleep(60)
      expect(at.seen).toEqual(['ready held', 'drawn'])
      /* A drawn after the host stopped waiting changes nothing. */
      at.say({ type: MESSAGE.DRAWN })
      expect(at.seen).toEqual(['ready held', 'drawn'])
    } finally {
      at.conversation.close()
    }
  })

  test('no hold: ready lifts the cover at once, and a stray drawn is dropped', async () => {
    const at = aConversation(30)
    try {
      at.say({ type: MESSAGE.READY, id: ID, protocol: 2 })
      expect(at.seen).toEqual(['ready'])
      at.say({ type: MESSAGE.DRAWN })
      await Bun.sleep(60)
      expect(at.seen).toEqual(['ready'])
    } finally {
      at.conversation.close()
    }
  })

  test('a new greeting forgets the held cover without lifting it', async () => {
    const at = aConversation(30)
    try {
      at.say({ type: MESSAGE.READY, id: ID, protocol: 2, hold: true })
      at.conversation.greet(context)
      await Bun.sleep(60)
      expect(at.seen).toEqual(['ready held'])
    } finally {
      at.conversation.close()
    }
  })

  test('a held page is covered as loading; drawn, it is the page', () => {
    const said = { condition: 'ready' as const, line: 'answers' }
    expect(showing(said, { condition: 'ready', line: null, held: true })).toEqual({ kind: 'cover', state: 'loading' })
    expect(showing(said, { condition: 'ready', line: null, held: false })).toEqual({ kind: 'page' })
    expect(showing(said, { condition: 'ready', line: null })).toEqual({ kind: 'page' })
  })
})
