import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MESSAGE } from 'kehikot-module-protocol'

import { Conversation, possessive, whereThrown, type ConversationWatcher } from '@/host/conversation.ts'
import { toWireContext } from '@/host/context.ts'
import { noticeOf, showing } from '@/host/standing.ts'
import { ConditionPanel } from '@/canvas/Conditions.tsx'

/**
 * A page that said why it failed (protocol 2.59.0, `kehikot.page.error`): the
 * container shows the page's own error in place of "not answering", with its
 * stack behind "Show details", and all of it as text.
 */

const STACK = 'TypeError: x is undefined\n    at decide (http://127.0.0.1:7811/src/view/places.ts:61:9)\n    at App (http://127.0.0.1:7811/src/app.tsx:40:3)'

function conversationFor(said: { line: string; more?: string }[], faults: string[] = []) {
  const contentWindow = { postMessage() {} } as unknown as Window
  const watcher: ConversationWatcher = {
    ready: () => said.push({ line: 'ready' }),
    silent: (line, more) => said.push({ line, more }),
    fault: (line) => faults.push(line),
    height: () => {},
    filters: () => {},
    clearable: () => {},
    refreshable: () => {},
    header: () => {},
  }
  const conversation = new Conversation({ contentWindow }, 'example.notes', null, async () => ({ ok: true, data: null }), watcher, {
    name: 'Notes',
    readyTimeoutMs: 30,
  })
  const from = (data: unknown) => conversation.receive({ source: contentWindow, origin: 'null', data })
  return { conversation, from }
}

const failed = (message: string, where = 'error', stack = STACK) => ({ type: MESSAGE.PAGE_ERROR, message, where, stack })

describe('a page that says why it did not answer', () => {
  test('is shown with its own error at the deadline, instead of "not answering"', async () => {
    const said: { line: string; more?: string }[] = []
    const { conversation, from } = conversationFor(said)
    conversation.greet(toWireContext({ epic: null, project: null }, 'dark'))
    expect(from(failed('TypeError: x is undefined'))).toBe(true)
    /* Not before the deadline: a page may fail somewhere and still answer. */
    expect(said).toHaveLength(0)
    await Bun.sleep(60)
    expect(said).toEqual([
      {
        line: 'Notes’ page failed to start: TypeError: x is undefined (decide (http://127.0.0.1:7811/src/view/places.ts:61:9))',
        more: STACK,
      },
    ])
    expect(said[0]?.line).not.toContain('choosing not to answer')
    conversation.close()
  })

  test('arriving after the deadline is said at once, and the first failure stands', async () => {
    const said: { line: string; more?: string }[] = []
    const { conversation, from } = conversationFor(said)
    conversation.greet(toWireContext({ epic: null, project: null }, 'dark'))
    await Bun.sleep(60)
    /* Nothing is guessed at the deadline: a page that is only slow is not complained about. */
    expect(said).toHaveLength(0)
    from(failed('SyntaxError: no export named x', 'error', ''))
    from(failed('Error: and then this'))
    expect(said).toHaveLength(1)
    expect(said[0]).toEqual({ line: 'Notes’ page failed to start: SyntaxError: no export named x', more: undefined })
    conversation.close()
  })

  test('a page that goes on to answer is not called failed, and the next greeting forgets it', async () => {
    const said: { line: string; more?: string }[] = []
    const { conversation, from } = conversationFor(said)
    conversation.greet(toWireContext({ epic: null, project: null }, 'dark'))
    from(failed('Error: a fetch went wrong'))
    from({ type: MESSAGE.READY, id: 'example.notes', protocol: 2 })
    await Bun.sleep(60)
    expect(said.map((one) => one.line)).toEqual(['ready'])
    /* After `ready`, a rejection on a working page is not a condition. */
    from(failed('Error: another'))
    expect(said.map((one) => one.line)).toEqual(['ready'])
    conversation.close()
  })

  test('after it answered, only a greeting handler that threw is a line', () => {
    const said: { line: string; more?: string }[] = []
    const faults: string[] = []
    const { conversation, from } = conversationFor(said, faults)
    conversation.greet(toWireContext({ epic: null, project: null }, 'dark'))
    from({ type: MESSAGE.READY, id: 'example.notes', protocol: 2 })
    from(failed('Error: benign', 'rejection'))
    from(failed('TypeError: settings is undefined', 'greeting'))
    expect(faults).toEqual(['Notes’ page failed after it was greeted: TypeError: settings is undefined'])
    conversation.close()
  })
})

describe('where it was thrown', () => {
  test('the first frame, in either browser’s spelling', () => {
    expect(whereThrown(STACK, 'TypeError: x is undefined')).toBe('decide (http://127.0.0.1:7811/src/view/places.ts:61:9)')
    expect(whereThrown('decide@http://x/a.js:3:4\nApp@http://x/b.js:1:1', 'TypeError: y')).toBe('decide@http://x/a.js:3:4')
    expect(whereThrown('', 'x')).toBeNull()
  })

  test('a name is possessive as written', () => {
    expect(possessive('Mute')).toBe('Mute’s')
    expect(possessive('Notes')).toBe('Notes’')
  })
})

describe('the notice for it', () => {
  test('carries the stack to the panel, which folds it under "Show details" as text', () => {
    const shown = showing({ condition: 'ready', line: 'answers' }, { condition: 'silent', line: 'Notes’ page failed to start: <b>x</b>', more: '<script>alert(1)</script>\n    at f' })
    expect(shown).toEqual({ kind: 'notice', condition: 'silent', asleep: false, line: 'Notes’ page failed to start: <b>x</b>', page: true, more: '<script>alert(1)</script>\n    at f' })
    if (shown.kind !== 'notice') throw new Error('a notice')
    const notice = noticeOf(shown, {})
    expect(notice.more).toBe('<script>alert(1)</script>\n    at f')
    expect(notice.line).toBe('Notes’ page failed to start: <b>x</b>')

    const html = renderToStaticMarkup(createElement(ConditionPanel, { condition: 'silent', line: notice.line, more: notice.more, at: 'http://127.0.0.1:7811' }))
    expect(html).toContain('Show details')
    expect(html).toContain('data-testid="condition-more"')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('a page that said nothing has no details', () => {
    const shown = showing({ condition: 'ready', line: 'answers' }, { condition: 'silent', line: 'not answering' })
    if (shown.kind !== 'notice') throw new Error('a notice')
    expect(noticeOf(shown, {}).more).toBeUndefined()
    const html = renderToStaticMarkup(createElement(ConditionPanel, { condition: 'silent', line: 'x', at: 'y' }))
    expect(html).not.toContain('Show details')
  })
})
