import { describe, expect, test } from 'bun:test'
import { footerItemsSchema, type FooterItem } from 'kehikot-module-protocol'

import {
  NO_FOOTER,
  NO_FOOTERS,
  agentFooterPressable,
  agentFooterRefusal,
  drawsFooter,
  footerDeclared,
  footerPressing,
  footerRow,
  footerWithdrawn,
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
