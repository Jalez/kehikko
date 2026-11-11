import { describe, expect, test } from 'bun:test'
import { LOADING_COVER_AFTER_MS, MESSAGE } from 'kehikot-module-protocol'

import { Conversation, type ConversationWatcher } from '@/host/conversation.ts'
import { toWireContext } from '@/host/context.ts'
import { coverSentence, showing } from '@/host/standing.ts'
import { standingOf } from '@/host/coverFit.ts'

/**
 * Protocol 2.84.0: after a context change, a page that says `kehikot.loading`
 * is covered only if it has not said `kehikot.drawn` within the debounce, in
 * its own words, until it does or the host stops waiting. A quick redraw is
 * never covered; a page that says nothing never is.
 */

const ID = 'kehikot.example'
const context = toWireContext({ epic: null, project: null }, 'dark')

function aConversation({ after = 20, hold = 120 }: { after?: number; hold?: number } = {}) {
  const window = { postMessage() {} } as unknown as Window
  const seen: string[] = []
  const watcher: ConversationWatcher = {
    ready: (_protocol, _build, held) => seen.push(held ? 'ready held' : 'ready'),
    drawn: () => seen.push('drawn'),
    loading: (label) => seen.push(`loading ${label ?? '(host words)'}`),
    silent: () => seen.push('silent'),
    fault: (line) => seen.push(`fault ${line}`),
    height: () => {},
    filters: () => {},
    clearable: () => {},
    refreshable: () => {},
    header: () => {},
  }
  const conversation = new Conversation({ contentWindow: window }, ID, null, async () => ({ ok: true, data: null }), watcher, {
    readyTimeoutMs: 1000,
    holdCoverMs: hold,
    loadingAfterMs: after,
  })
  const say = (data: unknown) => conversation.receive({ source: window, origin: 'null', data })
  conversation.greet(context)
  return { conversation, seen, say }
}

describe('the cover after a context change', () => {
  test('the host waits as long as the protocol says before it covers', () => {
    expect(LOADING_COVER_AFTER_MS).toBe(150)
  })

  test('loading, and not drawn within the debounce: covered in the page\'s words until drawn', async () => {
    const at = aConversation()
    try {
      at.say({ type: MESSAGE.READY, id: ID, protocol: 2 })
      at.say({ type: MESSAGE.LOADING, label: 'Loading the plan…' })
      expect(at.seen).toEqual(['ready'])
      await Bun.sleep(40)
      expect(at.seen).toEqual(['ready', 'loading Loading the plan…'])
      at.say({ type: MESSAGE.DRAWN })
      expect(at.seen).toEqual(['ready', 'loading Loading the plan…', 'drawn'])
      at.say({ type: MESSAGE.DRAWN })
      expect(at.seen).toHaveLength(3)
    } finally {
      at.conversation.close()
    }
  })

  test('a quick redraw is never covered', async () => {
    const at = aConversation()
    try {
      at.say({ type: MESSAGE.READY, id: ID, protocol: 2 })
      at.say({ type: MESSAGE.LOADING, label: 'Loading the plan…' })
      at.say({ type: MESSAGE.DRAWN })
      await Bun.sleep(160)
      expect(at.seen).toEqual(['ready'])
    } finally {
      at.conversation.close()
    }
  })

  test('drawn never comes: the host stops waiting and the cover comes off', async () => {
    const at = aConversation({ after: 10, hold: 50 })
    try {
      at.say({ type: MESSAGE.READY, id: ID, protocol: 2 })
      at.say({ type: MESSAGE.LOADING })
      await Bun.sleep(25)
      expect(at.seen).toEqual(['ready', 'loading (host words)'])
      await Bun.sleep(60)
      expect(at.seen).toEqual(['ready', 'loading (host words)', 'drawn'])
    } finally {
      at.conversation.close()
    }
  })

  test('new words while covered change only the words', async () => {
    const at = aConversation()
    try {
      at.say({ type: MESSAGE.READY, id: ID, protocol: 2 })
      at.say({ type: MESSAGE.LOADING, label: 'Loading…' })
      await Bun.sleep(40)
      at.say({ type: MESSAGE.LOADING, label: 'Loading the plan…' })
      expect(at.seen).toEqual(['ready', 'loading Loading…', 'loading Loading the plan…'])
    } finally {
      at.conversation.close()
    }
  })

  test('inside a held greeting it gives the held cover its words, at once', () => {
    const at = aConversation()
    try {
      at.say({ type: MESSAGE.READY, id: ID, protocol: 2, hold: true, label: 'Loading the plan…' })
      expect(at.seen).toEqual(['ready held', 'loading Loading the plan…'])
      at.say({ type: MESSAGE.LOADING, label: 'Loading part 2…' })
      expect(at.seen).toEqual(['ready held', 'loading Loading the plan…', 'loading Loading part 2…'])
      at.say({ type: MESSAGE.DRAWN })
      expect(at.seen.at(-1)).toBe('drawn')
    } finally {
      at.conversation.close()
    }
  })

  test('before the page answered there is nothing to cover; a new greeting forgets a pending one', async () => {
    const at = aConversation()
    try {
      at.say({ type: MESSAGE.LOADING })
      await Bun.sleep(40)
      expect(at.seen).toEqual([])
      at.say({ type: MESSAGE.READY, id: ID, protocol: 2 })
      at.say({ type: MESSAGE.LOADING })
      at.conversation.greet(context)
      await Bun.sleep(40)
      expect(at.seen).toEqual(['ready'])
    } finally {
      at.conversation.close()
    }
  })

  test('a held page shows its words; without them the module is named', () => {
    const said = { condition: 'ready' as const, line: 'answers' }
    expect(showing(said, { condition: 'ready', line: null, held: true, label: 'Loading the plan…' })).toEqual({ kind: 'cover', state: 'loading', label: 'Loading the plan…' })
    expect(showing(said, { condition: 'ready', line: null, held: true, label: null })).toEqual({ kind: 'cover', state: 'loading' })
    expect(coverSentence('loading', 'Example')).toBe('Loading Example…')
    expect(coverSentence('loading', 'Example', '  ')).toBe('Loading Example…')
    expect(coverSentence('loading', 'Example', 'Loading the plan…')).toBe('Loading the plan…')
    expect(coverSentence('updating', 'Example', 'ignored')).toBe('Updating — restarting on the new code…')
    expect(standingOf({ kind: 'cover', state: 'loading', label: 'Loading the plan…' }, null, 'http://x', undefined, 'Example').sentence).toBe('Loading the plan…')
    expect(standingOf({ kind: 'cover', state: 'loading' }, null, 'http://x', undefined, 'Example').word).toBe('Loading')
  })
})
