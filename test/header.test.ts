import { describe, expect, test } from 'bun:test'
import { headerItemsSchema } from 'kehikot-module-protocol'

import { fetchCanvases } from '../src/host/canvases.ts'
import { declared, NO_HEADERS, withdrawn } from '../src/host/header.ts'

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
