import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { Absent } from '../src/canvas/Arriving.tsx'
import { placementShows, rememberedModules, rememberModules } from '../src/host/arriving.ts'

const NOT_INSTALLED = 'is not installed on this computer'

describe('placementShows: "not installed" only from a reading of the whole registry', () => {
  test('a module with a presence is its container', () => {
    expect(placementShows(true, null)).toBe('container')
    expect(placementShows(true, { scanned: true })).toBe('container')
  })
  test('before the first reading, nothing is concluded', () => {
    expect(placementShows(false, null)).toBe('arriving')
  })
  test('a reading of a registry that could not be read concludes nothing either', () => {
    expect(placementShows(false, { scanned: false })).toBe('arriving')
  })
  test('after the scan, a module that is genuinely not registered is missing', () => {
    expect(placementShows(false, { scanned: true })).toBe('missing')
  })
  test('a reading from an older host, which does not say, is taken as whole', () => {
    expect(placementShows(false, {})).toBe('missing')
  })
})

describe('what a container without a presence draws', () => {
  test('before the first scan: the loading cover with the module’s name, and no "not installed"', () => {
    const html = renderToStaticMarkup(<Absent id="kehikot.paper" reading={null} name="Paper" onRemove={() => {}} />)
    expect(html).not.toContain(NOT_INSTALLED)
    expect(html).not.toContain('missing')
    expect(html).toContain('data-testid="module-cover"')
    expect(html).toContain('Loading Paper…')
  })

  test('with no name remembered, the id', () => {
    const html = renderToStaticMarkup(<Absent id="kehikot.paper" reading={null} name={null} onRemove={() => {}} />)
    expect(html).toContain('Loading kehikot.paper…')
  })

  test('after the scan: a module that is not installed still says so', () => {
    const html = renderToStaticMarkup(<Absent id="kehikot.paper" reading={{ scanned: true }} name="Paper" onRemove={() => {}} />)
    expect(html).toContain(NOT_INSTALLED)
    expect(html).not.toContain('data-testid="module-cover"')
  })
})

describe('the names and icons remembered for those covers', () => {
  const store = () => {
    const kept = new Map<string, string>()
    return { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) }
  }

  test('what the last reading said comes back', () => {
    const storage = store()
    rememberModules([{ id: 'kehikot.paper', name: 'Paper', icon: 'file-text' }, { id: 'kehikot.queue' }], storage)
    expect([...rememberedModules(storage)]).toEqual([
      ['kehikot.paper', { name: 'Paper', icon: 'file-text' }],
      ['kehikot.queue', { name: null, icon: null }],
    ])
  })

  test('nothing, or something unreadable, is nothing remembered', () => {
    expect(rememberedModules(null).size).toBe(0)
    expect(rememberedModules({ getItem: () => '{not json' }).size).toBe(0)
    expect(rememberedModules({ getItem: () => '[1,2]' }).size).toBe(0)
    expect(rememberedModules({ getItem: () => { throw new Error('blocked') } }).size).toBe(0)
  })

  test('a storage that refuses is not a failure', () => {
    expect(() => rememberModules([{ id: 'a' }], { setItem: () => { throw new Error('full') } })).not.toThrow()
  })
})
