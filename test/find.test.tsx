import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MESSAGE, PROTOCOL, findSchema } from 'kehikot-module-protocol'

import { FindBar } from '../src/canvas/FindBar.tsx'
import { Conversation, type Answer } from '../src/host/conversation.ts'
import { toWireContext } from '../src/host/context.ts'
import {
  CANNOT_SEARCH,
  CLOSED_BAR,
  canBeAsked,
  containerOf,
  findAsk,
  findBar,
  findBarMode,
  findCount,
  findCountShort,
  findKeyOf,
  inputKeyOf,
  type FindBar as Bar,
} from '../src/host/find.ts'

/**
 * Find in a container (protocol 2.69.0): the rules of the bar the host draws over a page, the
 * conversation's half of `kehikot.find`, and the bar as drawn at each width.
 */

describe('the keys', () => {
  test('⌘F opens and ⌘G steps on a Mac; Ctrl elsewhere; never with Alt or both modifiers', () => {
    expect(findKeyOf({ key: 'f', metaKey: true }, true)).toBe('open')
    expect(findKeyOf({ key: 'g', metaKey: true }, true)).toBe('next')
    expect(findKeyOf({ key: 'G', metaKey: true, shiftKey: true }, true)).toBe('prev')
    expect(findKeyOf({ key: 'f', ctrlKey: true }, true)).toBeNull()
    expect(findKeyOf({ key: 'f', ctrlKey: true }, false)).toBe('open')
    expect(findKeyOf({ key: 'f', metaKey: true }, false)).toBeNull()
    expect(findKeyOf({ key: 'f', metaKey: true, altKey: true }, true)).toBeNull()
    expect(findKeyOf({ key: 'f', metaKey: true, ctrlKey: true }, true)).toBeNull()
    expect(findKeyOf({ key: 'F', metaKey: true, shiftKey: true }, true)).toBeNull()
    expect(findKeyOf({ key: 'k', metaKey: true }, true)).toBeNull()
  })

  test('in the input, Enter goes on, ⇧Enter back, Escape closes, and ⌘G steps too', () => {
    expect(inputKeyOf({ key: 'Enter' }, true)).toBe('next')
    expect(inputKeyOf({ key: 'Enter', shiftKey: true }, true)).toBe('prev')
    expect(inputKeyOf({ key: 'Escape' }, true)).toBe('close')
    expect(inputKeyOf({ key: 'g', metaKey: true, shiftKey: true }, true)).toBe('prev')
    expect(inputKeyOf({ key: 'f', metaKey: true }, true)).toBeNull()
    expect(inputKeyOf({ key: 'a' }, true)).toBeNull()
  })
})

const opened = (query = 'word'): Bar => findBar(findBar(CLOSED_BAR, { kind: 'open' }), { kind: 'query', query })

describe('the bar', () => {
  test('opening takes a query when given one, and keeps the last otherwise', () => {
    const bar = findBar(CLOSED_BAR, { kind: 'open', query: 'selected' })
    expect(bar).toMatchObject({ open: true, query: 'selected', focus: 1 })
    const closed = findBar(bar, { kind: 'close' })
    expect(findBar(closed, { kind: 'open' }).query).toBe('selected')
    expect(findBar(bar, { kind: 'open' }).focus).toBe(2)
  })

  test('only the result of the latest search is drawn', () => {
    let bar = findBar(opened(), { kind: 'asked', id: 'find-1' })
    bar = findBar(bar, { kind: 'asked', id: 'find-2' })
    bar = findBar(bar, { kind: 'result', id: 'find-1', result: { total: 9, current: 1 } })
    expect(bar.result).toBeNull()
    bar = findBar(bar, { kind: 'result', id: 'find-2', result: { total: 17, current: 3 } })
    expect(findCount(bar)).toBe('3 of 17')
    expect(findCountShort(bar)).toBe('3/17')
  })

  test('no answer in time is a module that cannot be searched, unless it has answered before', () => {
    const asked = findBar(opened(), { kind: 'asked', id: 'find-1' })
    expect(findCount(findBar(asked, { kind: 'silent', id: 'find-1' }))).toBe(CANNOT_SEARCH)
    const heard = findBar(findBar(asked, { kind: 'result', id: 'find-1', result: { total: 2, current: 1 } }), { kind: 'asked', id: 'find-2' })
    expect(findBar(heard, { kind: 'silent', id: 'find-2' }).result).not.toBe('unsupported')
  })

  test('unsupported, and nothing to ask, both say so', () => {
    expect(findCount(findBar(opened(), { kind: 'asked', id: null }))).toBe(CANNOT_SEARCH)
    const bar = findBar(findBar(opened(), { kind: 'asked', id: 'find-1' }), { kind: 'result', id: 'find-1', result: 'unsupported' })
    expect(findCount(bar)).toBe(CANNOT_SEARCH)
  })

  test('no results, and nothing while the query is empty', () => {
    const bar = findBar(findBar(opened(), { kind: 'asked', id: 'f' }), { kind: 'result', id: 'f', result: { total: 0, current: 0 } })
    expect(findCount(bar)).toBe('No results')
    expect(findCountShort(bar)).toBe('0/0')
    expect(findCount({ ...bar, query: '' })).toBe('')
  })

  test('closing forgets the search, and a late result does not reopen it', () => {
    const asked = findBar(opened(), { kind: 'asked', id: 'find-1' })
    const closed = findBar(asked, { kind: 'close' })
    expect(closed).toMatchObject({ open: false, asked: null, result: null, query: 'word' })
    expect(findBar(closed, { kind: 'result', id: 'find-1', result: { total: 1, current: 1 } })).toBe(closed)
  })

  test('what is asked carries the options and the direction', () => {
    const bar = findBar(opened('Kehikko'), { kind: 'case', caseSensitive: true })
    expect(findAsk(bar, 'prev')).toEqual({ query: 'Kehikko', caseSensitive: true, wholeWord: false, direction: 'prev' })
  })

  test('the width decides how much is drawn', () => {
    expect(findBarMode(null)).toBe('wide')
    expect(findBarMode(380)).toBe('wide')
    expect(findBarMode(280)).toBe('narrow')
    expect(findBarMode(200)).toBe('tight')
  })

  test('a module built before Find is not asked; one that does not say is', () => {
    expect(canBeAsked('2.68.0')).toBe(false)
    expect(canBeAsked('2.69.0')).toBe(true)
    expect(canBeAsked('3.0.0')).toBe(true)
    expect(canBeAsked(null)).toBeNull()
    expect(canBeAsked('nonsense')).toBeNull()
  })

  test('the container a key is for is the one holding focus, or the one shown large', () => {
    const holding = (attribute: string, value: string) =>
      ({ closest: () => ({ getAttribute: (name: string) => (name === attribute ? value : null) }) }) as unknown as Element
    expect(containerOf(holding('data-module', 'kehikot.a'))).toBe('kehikot.a')
    expect(containerOf(holding('data-expanded', 'kehikot.b'))).toBe('kehikot.b')
    expect(containerOf({ closest: () => null } as unknown as Element)).toBeNull()
    expect(containerOf(null)).toBeNull()
  })
})

/* ------------------------------------------------------------------------ */

function frameAndWindow() {
  const sent: Record<string, unknown>[] = []
  const contentWindow = { postMessage: (message: unknown) => void sent.push(message as Record<string, unknown>) } as unknown as Window
  return { frame: { contentWindow }, contentWindow, sent }
}

const nothing: Answer = { ok: true, data: null }
const context = toWireContext({ epic: null, project: null }, 'dark')

function talking(watcher: Record<string, unknown> = {}) {
  const { frame, contentWindow, sent } = frameAndWindow()
  const conversation = new Conversation(frame, 'kehikot.notes', null, async () => nothing, {
    ready: () => {},
    silent: () => {},
    fault: () => {},
    height: () => {},
    filters: () => {},
    clearable: () => {},
    refreshable: () => {},
    header: () => {},
    ...watcher,
  })
  const say = (data: unknown) => conversation.receive({ source: contentWindow, origin: 'null', data })
  return { conversation, sent, say }
}

describe('the conversation', () => {
  test('the greeting says this host draws a find bar', () => {
    const { conversation, sent } = talking()
    conversation.greet(context)
    expect(sent[0]).toMatchObject({ type: MESSAGE.HELLO, find: true })
    conversation.close()
  })

  test('a search is sent only to a page that answered, with an id of its own', () => {
    const { conversation, sent, say } = talking()
    const ask = { query: 'word', caseSensitive: false, wholeWord: false, direction: 'first' as const }
    expect(conversation.sendFind(ask)).toBeNull()
    conversation.greet(context)
    expect(conversation.sendFind(ask)).toBeNull()
    say({ type: MESSAGE.READY, id: 'kehikot.notes', protocol: PROTOCOL })
    const id = conversation.sendFind(ask)
    const second = conversation.sendFind({ ...ask, direction: 'next' })
    expect(id).not.toBeNull()
    expect(second).not.toBe(id)
    const finds = sent.filter((m) => m.type === MESSAGE.FIND)
    expect(finds).toHaveLength(2)
    expect(findSchema.parse(finds[0])).toMatchObject({ id, query: 'word', direction: 'first' })
    conversation.close()
  })

  test('a result and a ⌘F inside the page are handed to the canvas', () => {
    const results: unknown[] = []
    const opens: unknown[] = []
    const { conversation, say } = talking({ findResult: (r: unknown) => results.push(r), findOpen: (o: unknown) => opens.push(o) })
    conversation.greet(context)
    say({ type: MESSAGE.READY, id: 'kehikot.notes', protocol: PROTOCOL })
    say({ type: MESSAGE.FIND_RESULT, id: 'find-1', total: 17, current: 3 })
    say({ type: MESSAGE.FIND_RESULT, id: 'find-2', total: 0, current: 0, unsupported: true })
    say({ type: MESSAGE.FIND_OPEN, query: 'selected' })
    say({ type: MESSAGE.FIND_OPEN, step: 'prev' })
    expect(results).toEqual([
      { id: 'find-1', total: 17, current: 3, unsupported: false },
      { id: 'find-2', total: 0, current: 0, unsupported: true },
    ])
    expect(opens).toEqual([{ query: 'selected' }, { step: 'prev' }])
    conversation.close()
  })
})

/* ------------------------------------------------------------------------ */

const drawn = (bar: Bar, width: number | null) =>
  renderToStaticMarkup(
    <FindBar bar={bar} name="Notes" width={width} mac onQuery={() => {}} onCase={() => {}} onStep={() => {}} onClose={() => {}} />,
  )

describe('the bar as drawn', () => {
  const counted = findBar(findBar(opened(), { kind: 'asked', id: 'f' }), { kind: 'result', id: 'f', result: { total: 17, current: 3 } })

  test('closed, nothing', () => {
    expect(drawn(CLOSED_BAR, 380)).toBe('')
  })

  test('wide: input, the count in words, previous, next, case and close', () => {
    const html = drawn(counted, 380)
    expect(html).toContain('role="search"')
    expect(html).toContain('3 of 17')
    for (const label of ['Previous match', 'Next match', 'Match case', 'Close find']) expect(html).toContain(`aria-label="${label}"`)
  })

  test('narrow: the count short; tight: the case button goes', () => {
    expect(drawn(counted, 280)).toContain('3/17')
    expect(drawn(counted, 280)).toContain('aria-label="Match case"')
    const tight = drawn(counted, 200)
    expect(tight).toContain('3/17')
    expect(tight).not.toContain('aria-label="Match case"')
    expect(tight).toContain('aria-label="Next match"')
    expect(tight).toContain('aria-label="Close find"')
  })

  test('a module that cannot be searched says so, with only the close button', () => {
    const html = drawn(findBar(opened(), { kind: 'asked', id: null }), 200)
    expect(html).toContain(CANNOT_SEARCH.replace("'", '&#x27;'))
    expect(html).not.toContain('<input')
    expect(html).toContain('aria-label="Close find"')
  })
})
