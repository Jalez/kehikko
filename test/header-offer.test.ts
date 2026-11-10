import { describe, expect, test } from 'bun:test'
import { headerItemsSchema } from 'kehikot-module-protocol'

import {
  COLUMN_WIDTH,
  CONTROLS,
  FRAME_ENTRIES,
  FRAME_TITLE,
  HELP_ENTRIES,
  ROW_PRIORITY,
  columnsFor,
  columnsOf,
  frameHint,
  sizeOf,
  stepIn,
  layoutOf,
  overflowOf,
  modeFor,
  pinsFor,
  placesOf,
  reachable,
  type Fold,
  type FrameEntry,
  type Offer,
} from '../src/host/headerOffer.ts'

/*
 * One list of everything a container's header offers, and where each entry is
 * drawn (`src/host/headerOffer.ts`): the same things reachable at every width
 * and fold state, each in exactly one place, the overflow in the separate
 * menus' order.
 */

const WIDTHS = [null, 780, 440, 380, 360, 359, 300, 299, 280, 240, 220, 219, 200, 160, 120] as const
const FOLDS: Fold[] = [0, 1, 2]

const ITEMS = headerItemsSchema.parse([
  { kind: 'switch', id: 'pane', label: 'Pane', options: [{ id: 'source', label: 'Source' }, { id: 'pdf', label: 'PDF' }], value: 'source' },
  { kind: 'toggle', id: 'wrap', label: 'Wrap', checked: false },
  { kind: 'go', id: 'section', label: 'Section', options: [{ id: 'intro', label: 'Intro' }] },
  { kind: 'run', id: 'compile', label: 'Compile', pinned: true, icon: 'play' },
  { kind: 'run', id: 'clean', label: 'Clean', disabled: 'Nothing to clean.' },
  { kind: 'run', id: 'settings', label: 'Settings', group: 'More' },
])

const OFFERS: Record<string, Offer> = {
  'menus and every host entry': { items: ITEMS, frame: [...FRAME_ENTRIES], help: [...HELP_ENTRIES], controls: [...CONTROLS] },
  'menus, no settings': { items: ITEMS, frame: ['tools', 'prompts'], help: ['feedback'] },
  'no menus, every host entry': { items: [], frame: [...FRAME_ENTRIES], help: [...HELP_ENTRIES], controls: [...CONTROLS] },
  'no menus, only clear': { items: [], frame: ['prompts', 'remove'], help: ['notes', 'feedback'], controls: ['clear'] },
  'no menus, the least': { items: [], frame: ['prompts'], help: ['feedback'] },
  'no help at all': { items: ITEMS, frame: ['prompts'] },
  'only a pinned run': { items: headerItemsSchema.parse([{ kind: 'run', id: 'go', label: 'Go', pinned: true }]), frame: ['settings', 'prompts'], help: ['intro', 'feedback'] },
}

const at = (offer: Offer, width: number | null, fold: Fold) => layoutOf(offer, modeFor(width), pinsFor(width), fold)

describe('one list, the same everywhere', () => {
  for (const [said, offer] of Object.entries(OFFERS)) {
    test(`${said}: the same actions are reachable at every width and fold state`, () => {
      const expected = [
        ...offer.items.map((item) => `item:${item.id}`),
        ...(offer.controls ?? []).map((control) => `control:${control}`),
        ...offer.frame.map((entry) => `frame:${entry}`),
        ...(offer.help ?? []).map((entry) => `help:${entry}`),
      ].sort()
      for (const width of WIDTHS) {
        for (const fold of FOLDS) expect(reachable(at(offer, width, fold)), `${width} ${fold}`).toEqual(expected)
      }
    })

    test(`${said}: every action is in exactly one place`, () => {
      for (const width of WIDTHS) {
        for (const fold of FOLDS) {
          const keys = placesOf(at(offer, width, fold)).map((one) => one.key)
          expect(keys.length, `${width} ${fold}`).toBe(new Set(keys).size)
        }
      }
    })

    test(`${said}: folding moves nothing`, () => {
      for (const width of WIDTHS) expect(at(offer, width, 1)).toEqual(at(offer, width, 0))
      for (const width of WIDTHS) expect(at(offer, width, 2)).toEqual(at(offer, width, 0))
    })
  }
})

describe('where an entry goes', () => {
  const offer = OFFERS['menus and every host entry']!
  const where = (width: number | null) => Object.fromEntries(placesOf(at(offer, width, 0)).map((one) => [one.key, one.place]))

  test('wide: module menus, then Help, then Container; the pinned run and the gear in the row', () => {
    const layout = at(offer, 380, 0)
    expect(layout.triggers.map((one) => one.which)).toEqual(['view', 'go', 'run', 'help', 'frame'])
    expect(where(380)['item:compile']).toBe('row')
    expect(where(380)['frame:settings']).toBe('row')
    const frame = layout.triggers.at(-1)!.sections[0]!
    expect(frame.kind === 'frame' && frame.entries).toEqual(FRAME_ENTRIES.filter((one) => one !== 'settings' && one !== 'remove'))
    expect(where(380)['frame:remove']).toBe('row')
  })

  test('under 360: the pinned run is a row of the Run menu', () => {
    expect(where(359)['item:compile']).toBe('run')
    expect(where(280)['item:compile']).toBe('run')
  })

  test('under 220: one "⋯" with View, Go, Run, the module’s controls, Help, then Container, and Settings among the Container rows', () => {
    const layout = at(offer, 200, 0)
    expect(layout.gear).toBe(false)
    expect(layout.triggers.map((one) => one.which)).toEqual(['more'])
    expect(layout.triggers[0]!.sections.map((one) => (one.kind === 'module' ? one.menu.menu : one.kind))).toEqual(['view', 'go', 'run', 'controls', 'help', 'frame'])
    const frame = layout.triggers[0]!.sections.at(-1)!
    expect(frame.kind === 'frame' && frame.entries).toEqual([...FRAME_ENTRIES])
  })

  test('the overflow keeps the separate menus’ order, labels and disabled reasons', () => {
    const wide = at(offer, 300, 0)
    const narrow = at(offer, 200, 0)
    const modules = (layout: typeof wide) =>
      layout.triggers.flatMap((one) => one.sections).flatMap((one) => (one.kind === 'module' ? [one.menu] : []))
    expect(modules(narrow)).toEqual(modules(wide))
    const clean = modules(narrow).flatMap((menu) => menu.groups.flatMap((group) => group.items)).find((item) => item.id === 'clean')!
    expect(clean.label).toBe('Clean')
    expect(clean.kind === 'run' && clean.disabled).toBe('Nothing to clean.')
  })

  test('no module menus: under 220 the "⋯" holds the controls and Container, Settings in it once — never a trigger of its own', () => {
    const layout = at(OFFERS['no menus, every host entry']!, 200, 0)
    expect(layout.triggers.map((one) => one.which)).toEqual(['more'])
    expect(layout.triggers[0]!.sections.map((one) => one.kind)).toEqual(['controls', 'help', 'frame'])
    expect(placesOf(layout).filter((one) => one.key === 'frame:settings')).toEqual([{ key: 'frame:settings', place: 'more' }])
  })

  test('a module item called "Settings" is the module’s, and the host’s Settings is still one entry', () => {
    for (const width of WIDTHS) {
      const keys = placesOf(at(offer, width, 0)).map((one) => one.key)
      expect(keys.filter((one) => one === 'frame:settings').length).toBe(1)
      expect(keys.filter((one) => one === 'item:settings').length).toBe(1)
    }
  })

  test('every host entry has a place in the order', () => {
    const entries: FrameEntry[] = ['prompts', 'scope', 'inbox']
    const frame = at({ items: [], frame: entries }, 380, 0).triggers[0]!.sections[0]!
    expect(frame.kind === 'frame' && frame.entries).toEqual(['scope', 'inbox', 'prompts'])
  })
})

describe('what the row keeps when there is no room', () => {
  const NARROW = [380, 280, 220, 200, 160] as const

  test('the order: checkbox, icon, "⋯", fold, name', () => {
    expect([...ROW_PRIORITY]).toEqual(['select', 'icon', 'overflow', 'fold', 'name'])
  })

  for (const [said, offer] of Object.entries(OFFERS)) {
    test(`${said}: at 380, 280, 220, 200 and 160, open and folded, the row starts with the priority list`, () => {
      for (const width of NARROW) {
        for (const fold of FOLDS) expect(at(offer, width, fold).row.slice(0, ROW_PRIORITY.length), `${width} ${fold}`).toEqual([...ROW_PRIORITY])
      }
    })

    test(`${said}: under 220 the row is the priority list and nothing else, and Container is a section of the one "⋯"`, () => {
      for (const width of [200, 160]) {
        for (const fold of FOLDS) {
          const layout = at(offer, width, fold)
          expect(layout.row, `${width} ${fold}`).toEqual([...ROW_PRIORITY])
          expect(layout.triggers.map((one) => one.which)).toEqual(['more'])
          expect(layout.pinned).toEqual([])
          expect(layout.gear).toBe(false)
          expect(overflowOf(layout).sections.at(-1)!.kind).toBe('frame')
        }
      }
    })

    test(`${said}: the overflow is always the last trigger and holds the Container rows`, () => {
      for (const width of NARROW) {
        const layout = at(offer, width, 0)
        expect(overflowOf(layout).which).toBe(width < 220 ? 'more' : 'frame')
        expect(overflowOf(layout).sections.some((one) => one.kind === 'frame')).toBe(true)
      }
    })
  }

  test('at 220 and wider what gives way first is still in the row: menus, gear, pinned runs, after the five', () => {
    const offer = OFFERS['menus and every host entry']!
    expect(at(offer, 380, 0).row).toEqual([...ROW_PRIORITY, 'menus', 'controls', 'help', 'gear', 'remove', 'pinned'])
    expect(at(offer, 280, 0).row).toEqual([...ROW_PRIORITY, 'menus', 'controls', 'help', 'gear', 'remove'])
    expect(at(offer, 220, 0).row).toEqual([...ROW_PRIORITY, 'menus', 'controls', 'help', 'gear', 'remove'])
  })
})

describe('the Help menu: the app’s "?", scoped to the module', () => {
  const offer = OFFERS['menus and every host entry']!

  test('with room, a "?" trigger of its own, between the module’s menus and Container; its rows in the app menu’s order', () => {
    for (const width of [null, 780, 380, 300, 280, 220]) {
      const layout = at(offer, width, 0)
      const help = layout.triggers.find((one) => one.which === 'help')!
      expect(help.sections).toEqual([{ kind: 'help', entries: ['intro', 'help', 'notes', 'feedback'] }])
      expect(layout.triggers.map((one) => one.which).slice(-2)).toEqual(['help', 'frame'])
      for (const entry of HELP_ENTRIES) expect(placesOf(layout).find((one) => one.key === `help:${entry}`)?.place).toBe('help')
    }
  })

  test('under 220, a "Help" section of the one "⋯", just before Container; never a trigger of its own', () => {
    for (const width of [219, 200, 160, 120]) {
      const layout = at(offer, width, 0)
      expect(layout.triggers.map((one) => one.which)).toEqual(['more'])
      expect(overflowOf(layout).sections.map((one) => one.kind).slice(-2)).toEqual(['help', 'frame'])
      for (const entry of HELP_ENTRIES) expect(placesOf(layout).find((one) => one.key === `help:${entry}`)?.place).toBe('more')
      expect(layout.row).not.toContain('help')
    }
  })

  test('only the rows the module has, in order whatever order they are offered in; none, no trigger', () => {
    const help = at({ items: [], frame: ['prompts'], help: ['feedback', 'notes', 'intro'] }, 380, 0).triggers.find((one) => one.which === 'help')!
    expect(help.sections).toEqual([{ kind: 'help', entries: ['intro', 'notes', 'feedback'] }])
    expect(at(OFFERS['no help at all']!, 380, 0).triggers.some((one) => one.which === 'help')).toBe(false)
    expect(overflowOf(at(OFFERS['no help at all']!, 200, 0)).sections.some((one) => one.kind === 'help')).toBe(false)
  })

  test('nothing of Help is a Container row', () => {
    for (const entry of HELP_ENTRIES) expect((FRAME_ENTRIES as readonly string[]).includes(entry)).toBe(false)
  })
})

describe('what the host’s menu is called', () => {
  test('Container, with a tooltip that lists what it holds, in its order', () => {
    expect(FRAME_TITLE).toBe('Container')
    expect(frameHint(['prompts', 'rows', 'settings', 'scope'])).toBe('This container: scope, settings, header and footer, prompts')
  })
})

describe('the module’s row controls and remove', () => {
  const offer = OFFERS['menus and every host entry']!
  const where = (width: number) => Object.fromEntries(placesOf(at(offer, width, 0)).map((one) => [one.key, one.place]))

  test('at 220 and wider: filter, clear, refresh and remove are buttons in the row', () => {
    for (const width of [380, 280, 220]) {
      for (const key of ['control:filter', 'control:clear', 'control:refresh', 'frame:remove']) expect(where(width)[key], `${key} ${width}`).toBe('row')
      expect(at(offer, width, 0).controls).toEqual([...CONTROLS])
      expect(at(offer, width, 0).remove).toBe(true)
    }
  })

  test('under 220: the controls are a section of the "⋯" between the module’s menus and Container, and remove is Container’s last row', () => {
    for (const width of [200, 160]) {
      for (const fold of FOLDS) {
        const layout = at(offer, width, fold)
        expect(layout.controls).toEqual([])
        expect(layout.remove).toBe(false)
        const sections = layout.triggers[0]!.sections
        expect(sections.map((one) => (one.kind === 'module' ? one.menu.menu : one.kind))).toEqual(['view', 'go', 'run', 'controls', 'help', 'frame'])
        const controls = sections[3]!
        expect(controls.kind === 'controls' && controls.controls).toEqual(['filter', 'clear', 'refresh'])
        const frame = sections.at(-1)!
        expect(frame.kind === 'frame' && frame.entries.at(-1)).toBe('remove')
        for (const key of ['control:filter', 'control:clear', 'control:refresh', 'frame:remove']) expect(where(width)[key]).toBe('more')
      }
    }
  })

  test('a module with no menus: under 220 the "⋯" holds the controls, Help, then Container', () => {
    const layout = at(OFFERS['no menus, only clear']!, 160, 0)
    expect(layout.triggers.map((one) => one.which)).toEqual(['more'])
    expect(layout.triggers[0]!.sections.map((one) => one.kind)).toEqual(['controls', 'help', 'frame'])
    expect(layout.row).toEqual([...ROW_PRIORITY])
  })

  test('the controls keep their order whatever order they are offered in', () => {
    const layout = layoutOf({ items: [], frame: [], controls: ['refresh', 'filter'] }, 'words', true)
    expect(layout.controls).toEqual(['filter', 'refresh'])
  })
})

describe('the "⋯" in columns where the window has room', () => {
  test('the number of columns follows the width the window leaves it: a list when narrow, at most four', () => {
    expect(columnsFor(null, 5)).toBe(1)
    expect(columnsFor(COLUMN_WIDTH * 2 - 1, 5)).toBe(1)
    expect(columnsFor(320, 5)).toBe(1)
    expect(columnsFor(COLUMN_WIDTH * 2, 5)).toBe(2)
    expect(columnsFor(COLUMN_WIDTH * 3 - 1, 5)).toBe(2)
    expect(columnsFor(COLUMN_WIDTH * 3, 5)).toBe(3)
    expect(columnsFor(COLUMN_WIDTH * 4, 5)).toBe(4)
    expect(columnsFor(1920, 6)).toBe(4)
    /* Never more columns than sections, and one section is a list. */
    expect(columnsFor(1920, 2)).toBe(2)
    expect(columnsFor(1920, 1)).toBe(1)
  })

  test('Container stands in a column of its own, last; the sections before it are cut in order, tallest as short as can be', () => {
    const M = (size: number) => ({ size, kind: 'module' as const })
    const SHOWN = (size: number) => ({ size, kind: 'controls' as const })
    const C = (size: number) => ({ size, kind: 'frame' as const })
    /* View, Go and Run; Shown; Container. */
    expect(columnsOf([M(4), M(3), M(3), SHOWN(4), C(10)], 3)).toEqual([[0, 1, 2], [3], [4]])
    expect(columnsOf([M(4), M(3), M(3), SHOWN(4), C(10)], 2)).toEqual([[0, 1, 2, 3], [4]])
    expect(columnsOf([M(4), M(3), M(3), SHOWN(4), C(10)], 1)).toEqual([[0, 1, 2, 3, 4]])
    /* No Shown: the module's menus take two columns, cut where the taller is shortest; a menu is never split. */
    expect(columnsOf([M(12), M(2), M(2), C(10)], 3)).toEqual([[0], [1, 2], [3]])
    expect(columnsOf([M(2), M(2), M(12), C(10)], 3)).toEqual([[0, 1], [2], [3]])
    /* Shown with nothing before it, as in a module with no menus: two columns. */
    expect(columnsOf([SHOWN(4), C(10)], 3)).toEqual([[0], [1]])
    expect(columnsOf([C(10)], 3)).toEqual([[0]])
    /* Every section once, in order, whatever the count. */
    for (const count of [1, 2, 3]) expect(columnsOf([M(5), M(1), M(7), SHOWN(2), C(9)], count).flat()).toEqual([0, 1, 2, 3, 4])
  })

  test('Help stands in a column of its own before Container, then Shown, as there are columns for them', () => {
    const M = (size: number) => ({ size, kind: 'module' as const })
    const SHOWN = (size: number) => ({ size, kind: 'controls' as const })
    const HELP = (size: number) => ({ size, kind: 'help' as const })
    const C = (size: number) => ({ size, kind: 'frame' as const })
    expect(columnsOf([M(4), M(3), M(3), SHOWN(4), HELP(5), C(10)], 4)).toEqual([[0, 1, 2], [3], [4], [5]])
    expect(columnsOf([M(4), M(3), M(3), SHOWN(4), HELP(5), C(10)], 3)).toEqual([[0, 1, 2, 3], [4], [5]])
    expect(columnsOf([M(4), M(3), M(3), SHOWN(4), HELP(5), C(10)], 2)).toEqual([[0, 1, 2, 3, 4], [5]])
    /* A module with no menus and no controls: Help and Container side by side. */
    expect(columnsOf([HELP(3), C(8)], 4)).toEqual([[0], [1]])
    expect(columnsOf([SHOWN(2), HELP(3), C(8)], 4)).toEqual([[0], [1], [2]])
    for (const count of [1, 2, 3, 4]) expect(columnsOf([M(5), M(1), SHOWN(2), HELP(3), C(9)], count).flat()).toEqual([0, 1, 2, 3, 4])
  })

  test('the sizes the columns are balanced by count each section\'s rows and heading', () => {
    const layout = layoutOf({ items: ITEMS, frame: ['scope', 'settings', 'prompts'], help: ['help', 'feedback'], controls: ['filter', 'refresh'] }, 'merged', false)
    const sizes = overflowOf(layout).sections.map(sizeOf)
    expect(sizes.at(-1)).toBe(4)
    expect(sizes.at(-2)).toBe(3)
    expect(sizes.at(-3)).toBe(3)
    /* Run: its heading, Compile (no pinned buttons here) and Clean, then the "More" group's heading and its row. */
    expect(sizes.at(-4)).toBe(5)
  })

  test('the keys: Up and Down within a column, Left and Right between, Home and End in the column; the rest is the menu\'s', () => {
    const columns = [6, 3, 9]
    expect(stepIn(columns, { column: 0, row: 2 }, 'ArrowDown')).toEqual({ column: 0, row: 3 })
    expect(stepIn(columns, { column: 0, row: 5 }, 'ArrowDown')).toEqual({ column: 0, row: 5 })
    expect(stepIn(columns, { column: 1, row: 0 }, 'ArrowUp')).toEqual({ column: 1, row: 0 })
    expect(stepIn(columns, { column: 0, row: 4 }, 'ArrowRight')).toEqual({ column: 1, row: 2 })
    expect(stepIn(columns, { column: 1, row: 2 }, 'ArrowRight')).toEqual({ column: 2, row: 2 })
    expect(stepIn(columns, { column: 2, row: 8 }, 'ArrowLeft')).toEqual({ column: 1, row: 2 })
    expect(stepIn(columns, { column: 2, row: 1 }, 'Home')).toEqual({ column: 2, row: 0 })
    expect(stepIn(columns, { column: 2, row: 1 }, 'End')).toEqual({ column: 2, row: 8 })
    /* Right from the last column opens a submenu as it always did; Left from the first does nothing here. */
    expect(stepIn(columns, { column: 2, row: 4 }, 'ArrowRight')).toBeNull()
    expect(stepIn(columns, { column: 0, row: 4 }, 'ArrowLeft')).toBeNull()
    /* Typing is the menu's: it finds a row by its letters. */
    expect(stepIn(columns, { column: 0, row: 0 }, 's')).toBeNull()
    expect(stepIn(columns, { column: 0, row: 0 }, 'Enter')).toBeNull()
    /* A column with nothing to focus is stepped over. */
    expect(stepIn([2, 0, 4], { column: 0, row: 1 }, 'ArrowRight')).toEqual({ column: 2, row: 1 })
  })
})

describe('the two Help menus, side by side', () => {
  test('the app’s rows and a container’s stand in the same order, the tour where a module has How to use', async () => {
    const { APP_HELP_ROWS, HELP_SAID, HELP_TITLE, helpHint } = await import('../src/host/helpMenu.ts')
    expect(APP_HELP_ROWS.map((row) => (row === 'tour' ? 'help' : row))).toEqual([...HELP_ENTRIES])
    expect(HELP_TITLE).toBe('Help')
    expect(Object.keys(HELP_SAID)).toEqual([...HELP_ENTRIES])
    expect(helpHint('Paper', ['intro', 'notes', 'feedback'])).toBe("Help with Paper: introduction, what's new, feedback")
  })
})
