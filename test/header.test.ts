import { describe, expect, test } from 'bun:test'
import { headerItemsSchema, pressRefusal } from 'kehikot-module-protocol'

import { fetchCanvases } from '../src/host/canvases.ts'
import {
  agentPressable,
  agentRefusal,
  agentStanding,
  declared,
  focusAfter,
  focusIsInModule,
  INLINE_OPTIONS,
  menusOf,
  nested,
  NO_HEADER,
  NO_HEADERS,
  notStanding,
  pressing,
  staysOpen,
  withdrawn,
  type Pressing,
} from '../src/host/header.ts'

/*
 * What each module last declared for its container's menus, as the page holds
 * it until the menus are drawn. See `src/host/header.ts`.
 */

const paper = headerItemsSchema.parse([
  { kind: 'toggle', id: 'auto', label: 'Apply proposals automatically', checked: false },
  { kind: 'run', id: 'compile', label: 'Compile' },
])
const busy = headerItemsSchema.parse([
  { kind: 'toggle', id: 'auto', label: 'Apply proposals automatically', checked: false },
  { kind: 'run', id: 'compile', label: 'Compile', state: 'busy' },
])

describe('the latest header per module', () => {
  test('a declaration replaces the last one whole, and only that module’s', () => {
    const one = declared(declared(NO_HEADERS, 'kehikot.paper', paper), 'kehikot.slides', [])
    const two = declared(one, 'kehikot.paper', busy)
    expect(two['kehikot.paper']).toEqual(busy)
    expect(two['kehikot.slides']).toEqual([])
    expect(NO_HEADERS).toEqual({})
  })

  test('the same list said again is the same object, so nothing is drawn twice', () => {
    const one = declared(NO_HEADERS, 'kehikot.paper', paper)
    expect(declared(one, 'kehikot.paper', headerItemsSchema.parse(paper))).toBe(one)
  })

  test('an empty header is kept as said: the module took its menus away', () => {
    const one = declared(declared(NO_HEADERS, 'kehikot.paper', paper), 'kehikot.paper', [])
    expect(one).toEqual({ 'kehikot.paper': [] })
  })

  test('it goes with the frame that declared it, and nobody else’s does', () => {
    const one = declared(declared(NO_HEADERS, 'kehikot.paper', paper), 'kehikot.slides', busy)
    expect(withdrawn(one, 'kehikot.paper')).toEqual({ 'kehikot.slides': busy })
    expect(withdrawn(one, 'kehikot.notes')).toBe(one)
  })
})

/*
 * The other thing the page has to hold for protocol 1.1.0: the kehikko's key,
 * which the page's own reading of `/host/canvases` used to strip.
 */
describe('the page reads a kehikko’s key', () => {
  test('it is kept from what the server sends, and a server that sends none still answers', async () => {
    const real = globalThis.fetch
    const row = { id: 28, name: 'writing', project: 1, placements: [] }
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ canvases: [{ ...row, key: '4072c9e5' }, { ...row, id: 29 }], projects: [] }))) as unknown as typeof fetch
    try {
      const { canvases } = await fetchCanvases()
      expect(canvases.map((c) => c.key)).toEqual(['4072c9e5', undefined])
    } finally {
      globalThis.fetch = real
    }
  })
})

/*
 * The rules of the menus, which `canvas/HeaderMenus.tsx` draws and does not
 * decide: which menu an item is in, when its options open beside the menu,
 * whether a press is sent, and what an agent may press.
 */

const whole = headerItemsSchema.parse([
  { kind: 'run', id: 'compile', label: 'Compile', agents: true, result: '1.2 s' },
  { kind: 'switch', id: 'pane', label: 'Pane', value: 'source', options: [{ id: 'source', label: 'Source' }, { id: 'pdf', label: 'PDF' }] },
  { kind: 'go', id: 'section', label: 'Sections', tool: 'show_section', options: Array.from({ length: 12 }, (_, n) => ({ id: `s${n}`, label: `Section ${n}` })) },
  { kind: 'toggle', id: 'wrap', label: 'Wrap long lines', checked: true, group: 'Editor' },
  { kind: 'toggle', id: 'auto', label: 'Apply proposals automatically', checked: false },
  { kind: 'run', id: 'commit', label: 'Commit', confirm: true },
  { kind: 'run', id: 'export', label: 'Export PDF', disabled: 'Compile the paper first.' },
  { kind: 'toggle', id: 'spell', label: 'Check spelling', checked: false, group: 'Editor', agents: true },
])

describe('the kind of an item decides its menu', () => {
  test('switches and toggles are View, jumps are Go, runs are Run — in that order, whatever order they were declared in', () => {
    const menus = menusOf(whole)
    expect(menus.map((menu) => [menu.menu, menu.title])).toEqual([['view', 'View'], ['go', 'Go'], ['run', 'Run']])
    const ids = (at: number) => menus[at]!.groups.flatMap((group) => group.items.map((item) => item.id))
    expect(ids(0)).toEqual(['pane', 'auto', 'wrap', 'spell'])
    expect(ids(1)).toEqual(['section'])
    expect(ids(2)).toEqual(['compile', 'commit', 'export'])
  })

  test('items naming the same group are drawn together, in the order the first of each came', () => {
    const view = menusOf(whole)[0]!
    expect(view.groups.map((group) => [group.name, group.items.map((item) => item.id)])).toEqual([
      [null, ['pane', 'auto']],
      ['Editor', ['wrap', 'spell']],
    ])
    expect(view.count).toBe(4)
  })

  test('an empty menu is not drawn, and a module that declares nothing has none', () => {
    expect(menusOf([])).toEqual([])
    expect(menusOf(NO_HEADER)).toEqual([])
    expect(menusOf(paper).map((menu) => menu.menu)).toEqual(['view', 'run'])
  })

  test('a run in flight, or one that failed, is said by its menu and by no other', () => {
    expect(menusOf(busy).map((menu) => [menu.menu, menu.busy, menu.failed])).toEqual([
      ['view', false, false],
      ['run', true, false],
    ])
    const failed = headerItemsSchema.parse([
      { kind: 'run', id: 'compile', label: 'Compile', state: 'failed' },
      { kind: 'run', id: 'export', label: 'Export' },
    ])
    expect(menusOf(failed)[0]).toMatchObject({ busy: false, failed: true })
    /* Busy wins: something is happening now, and the failure is the last one's. */
    const both = headerItemsSchema.parse([
      { kind: 'run', id: 'compile', label: 'Compile', state: 'failed' },
      { kind: 'run', id: 'export', label: 'Export', state: 'busy' },
    ])
    expect(menusOf(both)[0]).toMatchObject({ busy: true, failed: false })
  })

  test('a long list of options opens beside the menu — unless the item is alone in it', () => {
    const [pane, section] = [whole[1]!, whole[2]!]
    expect(pane.kind === 'switch' && pane.options.length).toBeLessThanOrEqual(INLINE_OPTIONS)
    expect(nested(pane, false)).toBe(false)
    expect(nested(section, false)).toBe(true)
    expect(nested(section, true)).toBe(false)
    /* A toggle and a run have no options to put anywhere. */
    expect(nested(whole[0]!, false)).toBe(false)
    expect(nested(whole[3]!, false)).toBe(false)
  })

  test('a toggle and a switch leave the menu open; a jump and a run close it', () => {
    expect((['toggle', 'switch', 'go', 'run'] as const).map(staysOpen)).toEqual([true, true, false, false])
  })

  test('after a menu closes: the module has the keyboard after a press that was sent, the trigger otherwise', () => {
    /* Escape; a press sent; a press not taken; focus already gone to a module's page. */
    expect((['dismissed', 'pressed', 'refused', 'away'] as const).map((closing) => focusAfter(closing))).toEqual([
      'trigger', 'module', 'trigger', 'nowhere',
    ])
  })

  test('focus found in a module’s page is never pulled back, however the menu came to close', () => {
    /* Chromium blurs the menu's content before the window: the menu closes as a plain dismissal. */
    expect((['dismissed', 'pressed', 'refused', 'away'] as const).map((closing) => focusAfter(closing, true))).toEqual([
      'nowhere', 'nowhere', 'nowhere', 'nowhere',
    ])
    expect(focusIsInModule({ tagName: 'IFRAME' } as Element)).toBe(true)
    expect(focusIsInModule({ tagName: 'BUTTON' } as Element)).toBe(false)
    expect(focusIsInModule(null)).toBe(false)
  })
})

describe('a press is judged against the header as it stands, then sent', () => {
  const sent: Pressing[] = []
  const taking = (press: Pressing) => {
    sent.push(press)
    return Promise.resolve({ ok: true, why: '' })
  }

  test('one the header can take is sent as it was made, and what the module said comes back', async () => {
    sent.length = 0
    expect(await pressing(whole, { item: 'pane', value: 'pdf' }, 'Paper', taking)).toEqual({ ok: true, why: '' })
    expect(await pressing(whole, { item: 'wrap', value: false }, 'Paper', taking)).toEqual({ ok: true, why: '' })
    expect(await pressing(whole, { item: 'compile' }, 'Paper', taking)).toEqual({ ok: true, why: '' })
    expect(sent).toEqual([{ item: 'pane', value: 'pdf' }, { item: 'wrap', value: false }, { item: 'compile' }])
  })

  test('one it cannot take is never sent, and the sentence is the protocol’s own', async () => {
    sent.length = 0
    for (const press of [
      { item: 'gone' },
      { item: 'pane', value: 'slides' },
      { item: 'wrap' },
      { item: 'export' },
      { item: 'compile' },
    ] satisfies Pressing[]) {
      const items = press.item === 'compile' ? headerItemsSchema.parse([{ kind: 'run', id: 'compile', label: 'Compile', state: 'busy' }]) : whole
      const came = await pressing(items, press, 'Paper', taking)
      expect(came.ok).toBe(false)
      expect(came.why).toBe(pressRefusal(items, press)!)
    }
    expect(sent).toEqual([])
    expect((await pressing(whole, { item: 'export' }, 'Paper', taking)).why).toBe('Compile the paper first.')
  })

  test('a module whose page is not on this screen says so, and one that refuses without a reason is given one', async () => {
    expect(await pressing(whole, { item: 'compile' }, 'Paper', () => null)).toEqual({ ok: false, why: notStanding('Paper') })
    expect(notStanding('Paper')).toBe("Paper's page is not open here, so nothing was pressed.")
    const silent = await pressing(whole, { item: 'compile' }, 'Paper', () => Promise.resolve({ ok: false, why: '' }))
    expect(silent).toEqual({ ok: false, why: 'Paper did not take that, and did not say why.' })
    const said = await pressing(whole, { item: 'compile' }, 'Paper', () => Promise.resolve({ ok: false, why: 'No main file.' }))
    expect(said).toEqual({ ok: false, why: 'No main file.' })
  })
})

describe('what an agent may press', () => {
  test('only what the module marked: a tool is a tool, a confirmed run is the person’s, and silence is the person’s', () => {
    expect(Object.fromEntries(whole.map((item) => [item.id, agentStanding(item)]))).toEqual({
      compile: 'agents',
      pane: 'person',
      section: 'tool',
      wrap: 'person',
      auto: 'person',
      commit: 'person',
      export: 'person',
      spell: 'agents',
    })
    expect(agentPressable(whole)).toEqual(['compile', 'spell'])
  })

  test('a confirmed run is the person’s even in a list no schema checked', () => {
    const forged = [{ ...whole[5]!, agents: true }] as typeof whole
    expect(agentStanding(forged[0]!)).toBe('person')
    expect(agentRefusal(forged, { item: 'commit' }, 'kehikot.paper')).toContain("takes a person's second press")
  })

  test('every refusal names what an agent may press instead', () => {
    const named = 'What an agent may press in kehikot.paper: compile, spell.'
    expect(agentRefusal(whole, { item: 'nope' }, 'kehikot.paper')).toBe(`kehikot.paper has no "nope" in its header now. ${named}`)
    expect(agentRefusal(whole, { item: 'auto', value: true }, 'kehikot.paper')).toBe(
      `"auto" is the person's: kehikot.paper has not marked it for agents. ${named}`,
    )
    expect(agentRefusal(whole, { item: 'commit' }, 'kehikot.paper')).toBe(
      `"commit" takes a person's second press to confirm it, so an agent does not press it. Ask the person. ${named}`,
    )
    expect(agentRefusal(whole, { item: 'section', value: 's1' }, 'kehikot.paper')).toBe(
      `"section" is not pressed through this door: kehikot.paper's own MCP door has the tool show_section, which does the same thing. Call show_section there. ${named}`,
    )
    expect(agentRefusal(paper, { item: 'auto', value: true }, 'kehikot.paper')).toContain(
      "Nothing in kehikot.paper's header is for an agent to press.",
    )
  })

  test('an item an agent may press is then judged as anybody’s press is', () => {
    expect(agentRefusal(whole, { item: 'compile' }, 'kehikot.paper')).toBeNull()
    expect(agentRefusal(whole, { item: 'spell', value: true }, 'kehikot.paper')).toBeNull()
    expect(agentRefusal(whole, { item: 'spell' }, 'kehikot.paper')).toBe(pressRefusal(whole, { item: 'spell' })!)
    const running = headerItemsSchema.parse([{ kind: 'run', id: 'compile', label: 'Compile', agents: true, state: 'busy' }])
    expect(agentRefusal(running, { item: 'compile' }, 'kehikot.paper')).toBe('"compile" is already running.')
  })
})

describe('pinned runs (protocol 1.6.0)', () => {
  const items = headerItemsSchema.parse([
    { kind: 'run', id: 'a', label: 'A', pinned: true },
    { kind: 'run', id: 'b', label: 'B' },
    { kind: 'toggle', id: 't', label: 'T', checked: false, pinned: true },
    ...['c', 'd', 'e', 'f'].map((id) => ({ kind: 'run', id, label: id, pinned: true })),
  ])

  test('the first four pinned runs, in declaration order; a pin on another kind is nothing', async () => {
    const { pinnedOf } = await import('../src/host/header.ts')
    expect(pinnedOf(items).map((item) => item.id)).toEqual(['a', 'c', 'd', 'e'])
  })

  test('a pinned run is still in the Run menu', async () => {
    const { menusOf } = await import('../src/host/header.ts')
    const run = menusOf(items).find((menu) => menu.menu === 'run')!
    expect(run.groups.flatMap((group) => group.items.map((item) => item.id))).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })
})
