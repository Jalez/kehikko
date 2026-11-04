import { describe, expect, test } from 'bun:test'
import { headerItemsSchema } from 'kehikot-module-protocol'

import {
  FRAME_ENTRIES,
  layoutOf,
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

const WIDTHS = [null, 780, 440, 380, 360, 359, 300, 299, 280, 240, 220, 219, 200, 120] as const
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
  'menus and every host entry': { items: ITEMS, frame: [...FRAME_ENTRIES] },
  'menus, no settings': { items: ITEMS, frame: ['tools', 'feedback', 'prompts'] },
  'no menus, every host entry': { items: [], frame: [...FRAME_ENTRIES] },
  'no menus, the least': { items: [], frame: ['feedback', 'prompts'] },
  'only a pinned run': { items: headerItemsSchema.parse([{ kind: 'run', id: 'go', label: 'Go', pinned: true }]), frame: ['settings', 'feedback', 'prompts'] },
}

const at = (offer: Offer, width: number | null, fold: Fold) => layoutOf(offer, modeFor(width), pinsFor(width), fold)

describe('one list, the same everywhere', () => {
  for (const [said, offer] of Object.entries(OFFERS)) {
    test(`${said}: the same actions are reachable at every width and fold state`, () => {
      const expected = [...offer.items.map((item) => `item:${item.id}`), ...offer.frame.map((entry) => `frame:${entry}`)].sort()
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

  test('wide: module menus, then Frame; the pinned run and the gear in the row', () => {
    const layout = at(offer, 380, 0)
    expect(layout.triggers.map((one) => one.which)).toEqual(['view', 'go', 'run', 'frame'])
    expect(where(380)['item:compile']).toBe('row')
    expect(where(380)['frame:settings']).toBe('row')
    const frame = layout.triggers.at(-1)!.sections[0]!
    expect(frame.kind === 'frame' && frame.entries).toEqual(FRAME_ENTRIES.filter((one) => one !== 'settings'))
  })

  test('under 360: the pinned run is a row of the Run menu', () => {
    expect(where(359)['item:compile']).toBe('run')
    expect(where(280)['item:compile']).toBe('run')
  })

  test('under 220: one "⋯" with View, Go, Run, then Frame, and Settings among the Frame rows', () => {
    const layout = at(offer, 200, 0)
    expect(layout.gear).toBe(false)
    expect(layout.triggers.map((one) => one.which)).toEqual(['more'])
    expect(layout.triggers[0]!.sections.map((one) => (one.kind === 'module' ? one.menu.menu : 'frame'))).toEqual(['view', 'go', 'run', 'frame'])
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

  test('no module menus: under 220 the Frame menu is the overflow, Settings in it once', () => {
    const layout = at(OFFERS['no menus, every host entry']!, 200, 0)
    expect(layout.triggers.map((one) => one.which)).toEqual(['frame'])
    expect(placesOf(layout).filter((one) => one.key === 'frame:settings')).toEqual([{ key: 'frame:settings', place: 'frame' }])
  })

  test('a module item called "Settings" is the module’s, and the host’s Settings is still one entry', () => {
    for (const width of WIDTHS) {
      const keys = placesOf(at(offer, width, 0)).map((one) => one.key)
      expect(keys.filter((one) => one === 'frame:settings').length).toBe(1)
      expect(keys.filter((one) => one === 'item:settings').length).toBe(1)
    }
  })

  test('every host entry has a place in the order', () => {
    const entries: FrameEntry[] = ['prompts', 'scope', 'feedback']
    const frame = at({ items: [], frame: entries }, 380, 0).triggers[0]!.sections[0]!
    expect(frame.kind === 'frame' && frame.entries).toEqual(['scope', 'feedback', 'prompts'])
  })
})
