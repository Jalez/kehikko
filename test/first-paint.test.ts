import { describe, expect, test } from 'bun:test'

import { framedAddress } from '../src/host/theme.ts'

/**
 * The address a module's frame is given: its entry, saying which theme the
 * host is in, so the module's first paint is in it.
 */
describe('the address a frame is given', () => {
  const ENTRY = 'http://127.0.0.1:7811/app'

  test('says the theme the host is drawing in', () => {
    expect(framedAddress(ENTRY, 'light', true)).toBe(`${ENTRY}?theme=light`)
    expect(framedAddress(ENTRY, 'dark', true)).toBe(`${ENTRY}?theme=dark`)
  })

  test('keeps the query the entry already has, and replaces a theme in it', () => {
    expect(framedAddress(`${ENTRY}?mode=print`, 'light', true)).toBe(`${ENTRY}?mode=print&theme=light`)
    expect(framedAddress(`${ENTRY}?theme=dark&mode=print`, 'light', true)).toBe(`${ENTRY}?theme=light&mode=print`)
    expect(framedAddress(`${ENTRY}#top`, 'dark', true)).toBe(`${ENTRY}?theme=dark#top`)
  })

  test('a module that states no build is framed at its entry, as it always was', () => {
    expect(framedAddress(ENTRY, 'light', false)).toBe(ENTRY)
    expect(framedAddress(`${ENTRY}?mode=print`, 'dark', false)).toBe(`${ENTRY}?mode=print`)
  })

  test('an entry that is not an address is left alone', () => {
    expect(framedAddress('not an address', 'light', true)).toBe('not an address')
  })
})
