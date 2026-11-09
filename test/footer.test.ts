import { describe, expect, test } from 'bun:test'
import { footerItemsSchema, type FooterItem } from 'kehikot-module-protocol'

import {
  READOUTS_POSTED_EVERY_MS,
  footedIds,
  footerShape,
  readoutsWait,
  FOOTER_STEPS,
  NO_FOOTER,
  footerCrowded,
  NO_FOOTERS,
  agentFooterPressable,
  agentFooterRefusal,
  drawsFooter,
  footerDeclared,
  footerPressing,
  footerRow,
  footerWithdrawn,
  fieldKey,
  fieldShows,
} from '../src/host/footer.ts'
import type { Pressing } from '../src/host/header.ts'
import { Headers } from '../server/headers.ts'

/*
 * A module's declared footer (protocol 2.38.0), as the host holds and judges
 * it: replaced whole, drawn only when declared, one row at 380/280/200, pressed
 * with `place: 'footer'`, and an agent held to the header's three cases.
 */

const agent = (over: Partial<{ context: number; level: 'normal' | 'warn' | 'critical' }> = {}): FooterItem[] =>
  footerItemsSchema.parse([
    { kind: 'text', id: 'model', text: 'Opus · high' },
    { kind: 'meter', id: 'context', label: 'Context', value: over.context ?? 0.62, level: over.level ?? 'normal', text: '124k / 200k' },
    { kind: 'meter', id: 'usage', label: 'Usage', value: 0.3, align: 'center', optional: true },
    { kind: 'run', id: 'compact', label: 'Compact', icon: 'refresh', align: 'end', agents: true },
    { kind: 'run', id: 'clear', label: 'Clear', icon: 'x', align: 'end', confirm: true },
    { kind: 'toggle', id: 'follow', label: 'Follow', checked: true, align: 'end', tool: 'set_follow', optional: true },
  ])

describe('what is held', () => {
  test('a declaration replaces the last whole, and the same list is the same object', () => {
    const one = footerDeclared(NO_FOOTERS, 'kehikot.claude', agent())
    expect(one['kehikot.claude']).toHaveLength(6)
    expect(footerDeclared(one, 'kehikot.claude', agent())).toBe(one)
    const two = footerDeclared(one, 'kehikot.claude', agent({ context: 0.9, level: 'critical' }))
    expect(two).not.toBe(one)
    expect(footerWithdrawn(two, 'kehikot.claude')).toEqual({})
    expect(footerWithdrawn(NO_FOOTERS, 'kehikot.claude')).toBe(NO_FOOTERS)
  })

  test('no row for a module that declared nothing or [], for a page not showing, or a folded container', () => {
    expect(drawsFooter(agent(), true, false)).toBe(true)
    expect(drawsFooter(NO_FOOTER, true, false)).toBe(false)
    expect(drawsFooter([], true, false)).toBe(false)
    expect(drawsFooter(agent(), false, false)).toBe(false)
    /* Folded, a container is its header only: no footer. */
    expect(drawsFooter(agent(), true, true)).toBe(false)
  })
})

describe('one row at 380, 280 and 200 pixels', () => {
  test('380: every item in its group, in words', () => {
    const row = footerRow(agent(), 380)
    expect(row.mode).toBe('words')
    expect(row.start.map((one) => one.id)).toEqual(['model', 'context'])
    expect(row.center.map((one) => one.id)).toEqual(['usage'])
    expect(row.end.map((one) => one.id)).toEqual(['compact', 'clear', 'follow'])
    expect(row.overflow).toEqual([])
  })

  test('280: optional items go (a pressable one into ⋯), runs are icons, meters without labels', () => {
    const row = footerRow(agent(), 280)
    expect(row.mode).toBe('icons')
    expect(row.center).toEqual([])
    expect(row.end.map((one) => one.id)).toEqual(['compact', 'clear'])
    expect(row.overflow.map((one) => one.id)).toEqual(['follow'])
    expect(row.iconsOnly).toBe(true)
    expect(row.meterLabels).toBe(false)
  })

  test('200: every pressable item is in ⋯ and nothing pressable is lost', () => {
    const row = footerRow(agent(), 200)
    expect(row.mode).toBe('merged')
    expect(row.end).toEqual([])
    expect(row.overflow.map((one) => one.id)).toEqual(['compact', 'clear', 'follow'])
    expect(row.start.map((one) => one.id)).toEqual(['model', 'context'])
  })
})

describe('a person’s press', () => {
  test('is sent with place footer, judged against the footer as declared now', async () => {
    const sent: Pressing[] = []
    const came = await footerPressing(agent(), { item: 'compact' }, 'Claude', (press) => {
      sent.push(press)
      return Promise.resolve({ ok: true, why: '' })
    })
    expect(came.ok).toBe(true)
    expect(sent).toEqual([{ item: 'compact', place: 'footer' }])
  })

  test('a text or a meter cannot be pressed, a gone item names what exists, and an absent page is said', async () => {
    const never = () => {
      throw new Error('should not send')
    }
    expect((await footerPressing(agent(), { item: 'model' }, 'Claude', never)).why).toBe('"model" only says something; it cannot be pressed.')
    expect((await footerPressing(agent(), { item: 'gone' }, 'Claude', never)).why).toContain('What can be pressed: compact, clear, follow.')
    expect((await footerPressing(agent(), { item: 'compact' }, 'Claude', () => null)).why).toBe("Claude's page is not open here, so nothing was pressed.")
    expect((await footerPressing(agent(), { item: 'compact' }, 'Claude', () => Promise.resolve({ ok: false, why: '' }))).why).toBe(
      'Claude did not take that, and did not say why.',
    )
  })
})

describe('an agent’s press', () => {
  test('only an item marked for agents; a confirm run, a tool item and a text are refused in words that name what exists', () => {
    expect(agentFooterPressable(agent())).toEqual(['compact'])
    expect(agentFooterRefusal(agent(), { item: 'compact' }, 'kehikot.claude')).toBeNull()
    expect(agentFooterRefusal(agent(), { item: 'clear' }, 'kehikot.claude')).toContain('takes a person’s second press'.replace('’', "'"))
    expect(agentFooterRefusal(agent(), { item: 'follow', value: false }, 'kehikot.claude')).toContain('Call set_follow there.')
    expect(agentFooterRefusal(agent(), { item: 'model' }, 'kehikot.claude')).toContain('only says something')
    expect(agentFooterRefusal(agent(), { item: 'nope' }, 'kehikot.claude')).toBe(
      "kehikot.claude has no \"nope\" in its footer now. What an agent may press in kehikot.claude's footer: compact.",
    )
  })
})

describe('the server holds what the page posted', () => {
  test('footers beside headers; a list that does not parse is dropped; an older page that posts none has none', () => {
    const held = new Headers()
    expect(held.posted('p1', 2, 1, {}, null, null, { 'kehikot.claude': agent(), 'kehikot.bad': [{ kind: 'meter', id: 'm', label: 'M', value: 7 }] })).toBeNull()
    const on = held.on(2, () => true)!
    expect(on.footers.get('kehikot.claude')?.map((one) => one.id)).toEqual(['model', 'context', 'usage', 'compact', 'clear', 'follow'])
    expect(on.footers.has('kehikot.bad')).toBe(false)
    expect(held.posted('p2', 3, 2, {})).toBeNull()
    expect(held.on(3, (page) => page === 'p2')!.footers.size).toBe(0)
  })
})

describe('a crowded row steps down, as the header does', () => {
  test('words → icons → merged, measured; never further', () => {
    expect(footerRow(agent(), 400, 0).mode).toBe('words')
    expect(footerRow(agent(), 400, 1).mode).toBe('icons')
    expect(footerRow(agent(), 400, 2).mode).toBe('merged')
    expect(footerRow(agent(), 400, 9).mode).toBe('merged')
    expect(footerRow(agent(), 280, 1).mode).toBe('merged')
    expect(FOOTER_STEPS).toBe(2)
  })

  test('crowded is the row or any group wider inside than its room', () => {
    expect(footerCrowded([{ scrollWidth: 300, clientWidth: 300 }, { scrollWidth: 80, clientWidth: 80 }])).toBe(false)
    expect(footerCrowded([{ scrollWidth: 300, clientWidth: 300 }, { scrollWidth: 170, clientWidth: 32 }])).toBe(true)
    expect(footerCrowded([{ scrollWidth: 262, clientWidth: 218 }])).toBe(true)
  })
})

describe('a field (protocol 2.46.0)', () => {
  const field = (over: Record<string, unknown> = {}): FooterItem[] =>
    footerItemsSchema.parse([{ kind: 'input', id: 'address', label: 'Address', value: 'https://example.com/', grow: true, ...over }])

  test('shows the module’s value until the person types, then what they typed, whatever the module says meanwhile', () => {
    expect(fieldShows('https://example.com/', null)).toBe('https://example.com/')
    expect(fieldShows('https://example.org/', 'https://exa')).toBe('https://exa')
    expect(fieldShows('https://example.org/', '')).toBe('')
  })

  test('Enter submits, Escape reverts, every other key types; Enter mid-composition is the composition’s', () => {
    expect(fieldKey('Enter')).toBe('submit')
    expect(fieldKey('Escape')).toBe('revert')
    expect(fieldKey('a')).toBe('type')
    expect(fieldKey('N')).toBe('type')
    expect(fieldKey('Enter', true)).toBe('type')
  })

  test('stays in the row at 380, 280 and 200 px, never in ⋯', () => {
    const items = [...field(), ...agent()]
    for (const width of [380, 280, 200]) {
      const row = footerRow(items, width)
      expect([...row.start, ...row.center, ...row.end].map((one) => one.id)).toContain('address')
      expect(row.overflow.map((one) => one.id)).not.toContain('address')
    }
  })

  test('a submit is sent with its text and place footer; one without text is refused before it is sent', async () => {
    const sent: Pressing[] = []
    const send = (press: Pressing) => (sent.push(press), Promise.resolve({ ok: true, why: '' }))
    expect(await footerPressing(field(), { item: 'address', text: 'https://example.org/' }, 'Viewer', send)).toEqual({ ok: true, why: '' })
    expect(sent).toEqual([{ item: 'address', text: 'https://example.org/', place: 'footer' }])
    expect((await footerPressing(field(), { item: 'address' }, 'Viewer', send)).ok).toBe(false)
    expect(sent).toHaveLength(1)
  })

  test('an agent submits only into a field marked for agents, and only with text', () => {
    expect(agentFooterPressable(field())).toEqual([])
    expect(agentFooterPressable(field({ agents: true }))).toEqual(['address'])
    expect(agentFooterRefusal(field(), { item: 'address', text: 'x' }, 'Viewer')).toContain("the person's")
    expect(agentFooterRefusal(field({ agents: true }), { item: 'address' }, 'Viewer')).toContain('give the text')
    expect(agentFooterRefusal(field({ agents: true }), { item: 'address', text: 'https://example.org/' }, 'Viewer')).toBeNull()
  })
})

describe('a ticking readout is not posted every tick', () => {
  const footer = (rate: string, value: number, run: 'idle' | 'busy' = 'idle') =>
    footerItemsSchema.parse([
      { kind: 'text', id: 'rate', text: rate },
      { kind: 'meter', id: 'cpu', label: 'CPU', value, text: `${Math.round(value * 100)}%` },
      { kind: 'run', id: 'clear', label: 'Clear', state: run },
    ])
  const posting = (items: FooterItem[]) => JSON.stringify([['kehikot.monitor', items]])

  test('a readout changing alone keeps the shape; an offer changing does not', () => {
    const a = footerShape(posting(footer('208/min', 0.5)))
    expect(footerShape(posting(footer('212/min', 0.56)))).toBe(a)
    expect(footerShape(posting(footer('212/min', 0.56, 'busy')))).not.toBe(a)
    expect(footerShape(JSON.stringify([['kehikot.monitor', footer('1/min', 0.1).slice(0, 2)]]))).not.toBe(a)
  })

  test('the same shape waits out the interval; another goes at once', () => {
    expect(readoutsWait(false, 0)).toBe(0)
    expect(readoutsWait(true, 1_000)).toBe(READOUTS_POSTED_EVERY_MS - 1_000)
    expect(readoutsWait(true, READOUTS_POSTED_EVERY_MS + 1)).toBe(0)
  })

  test('which containers have a footer, not what they say', () => {
    const one = { a: footer('1/min', 0.1), b: [] as FooterItem[] }
    const two = { a: footer('2/min', 0.2), b: [] as FooterItem[] }
    expect(footedIds(one)).toBe('a')
    expect(footedIds(two)).toBe(footedIds(one))
    expect(footedIds({ ...one, c: footer('x', 0) })).toBe('a\nc')
  })
})
