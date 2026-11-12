import { describe, expect, test } from 'bun:test'
import { MESSAGE } from 'kehikot-module-protocol'

import { Conversation, refusedLine, type ConversationWatcher } from '@/host/conversation.ts'
import { toWireContext } from '@/host/context.ts'
import { noticeOf, showing } from '@/host/standing.ts'

/**
 * A page that will not answer this window says so (protocol 2.93.0, `kehikot.refused`), and the
 * container says why in words and offers the restart that fixes it — instead of a page that loaded
 * every script and was then called broken for saying nothing.
 */

const ID = 'kehikot.example'

function aFrame() {
  const said: string[] = []
  const contentWindow = { postMessage() {} } as unknown as Window
  const watcher: ConversationWatcher = {
    ready: () => said.push('ready'),
    silent: (line) => said.push(line),
    fault: () => {},
    height: () => {},
    filters: () => {},
    clearable: () => {},
    refreshable: () => {},
    header: () => {},
  }
  const conversation = new Conversation({ contentWindow }, ID, null, async () => ({ ok: true, data: null }), watcher, {
    name: 'Example',
    readyTimeoutMs: 10_000,
  })
  const from = (data: unknown) => conversation.receive({ source: contentWindow, origin: 'null', data })
  return { conversation, said, from }
}

describe('a page that refuses this window', () => {
  test('is said at once, naming both origins, with the restart that fixes it', () => {
    const at = aFrame()
    at.conversation.greet(toWireContext({ epic: null, project: null }, 'dark'))
    expect(at.from({ type: MESSAGE.REFUSED, origin: 'http://127.0.0.1:4170', allowed: ['tauri://localhost', 'http://127.0.0.1:4181'] })).toBe(true)
    expect(at.said).toEqual([refusedLine('Example', 'http://127.0.0.1:4170', ['tauri://localhost', 'http://127.0.0.1:4181'])])
    expect(at.said[0]).toContain('refused this window')
    expect(at.said[0]).toContain('http://127.0.0.1:4170')
    expect(at.said[0]).toContain('tauri://localhost, http://127.0.0.1:4181')
    expect(at.said[0]).toContain('Restarting it')
    at.conversation.close()
  })

  test('the container offers Restart and Reload for it', () => {
    const shown = showing(
      { condition: 'ready', line: '' } as never,
      { condition: 'silent', line: refusedLine('Example', 'http://a', ['http://b']) },
    )
    expect(shown.kind).toBe('notice')
    if (shown.kind !== 'notice') return
    const notice = noticeOf(shown, {})
    expect(notice.offer).toBe('restart')
  })

  test('after the page answered, a refusal is somebody else’s window and changes nothing', () => {
    const at = aFrame()
    at.conversation.greet(toWireContext({ epic: null, project: null }, 'dark'))
    at.from({ type: MESSAGE.READY, id: ID, protocol: 2 })
    at.from({ type: MESSAGE.REFUSED, origin: 'http://elsewhere', allowed: [] })
    expect(at.said).toEqual(['ready'])
    at.conversation.close()
  })

  test('an empty list and no origin still read as a sentence', () => {
    expect(refusedLine('Example', '', [])).toBe('Example refused this window: it was started for other windows, and this window is one with no origin. Restarting it gives it this window’s address.')
  })
})
