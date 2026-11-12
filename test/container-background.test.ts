import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { frameScheme, pageAppearance } from '@/host/appearance.ts'
import { toWireContext, whileAway, whileFrozen } from '@/host/context.ts'

/**
 * Modules follow the container's background (protocol 2.82.0): with Settings › Appearance ›
 * "Container background" off, every module is told `appearance: { background: 'none' }` and the
 * protocol's client makes its page transparent; the frame around it is transparent too.
 */

const webapp = { id: 1, name: 'webapp', path: '/w/webapp', epics: true, git: true, shared: false }
const base = toWireContext({ epic: 'held-epic', project: webapp }, 'dark', [], null, null)
const card = { ...base, appearance: pageAppearance(true) }
const none = { ...base, appearance: pageAppearance(false) }

describe('what a module is told', () => {
  test('on is the card, off is none', () => {
    expect(pageAppearance(true)).toEqual({ background: 'card' })
    expect(pageAppearance(false)).toEqual({ background: 'none' })
  })

  test('a pinned container is told a change of background, and keeps what it is about', () => {
    const told = { ...toWireContext({ epic: 'another', project: webapp }, 'dark', [], null, null), appearance: pageAppearance(false) }
    const sent = whileFrozen(card, told)
    expect(sent?.appearance).toEqual({ background: 'none' })
    expect(sent?.epic).toBe('held-epic')
    expect(whileFrozen(none, told)).toBeNull()
  })

  test('so is a page kept on another kehikko', () => {
    const told = { ...toWireContext({ epic: 'another', project: null }, 'dark', [], null, null), appearance: pageAppearance(false) }
    const sent = whileAway(card, told)!
    expect(sent.appearance).toEqual({ background: 'none' })
    expect(sent.epic).toBe('held-epic')
    expect(whileAway(none, told)).toBeNull()
  })
})

describe('the frame', () => {
  test('says light over the card, and the theme with no background', () => {
    expect(frameScheme(true, 'dark')).toBe('light')
    expect(frameScheme(false, 'dark')).toBe('dark')
    expect(frameScheme(false, 'light')).toBe('light')
  })

  test('is transparent, and its background is cleared when the container has none', () => {
    const frame = readFileSync(join(import.meta.dir, '..', 'src', 'canvas', 'ModuleFrame.tsx'), 'utf8')
    expect(frame).toContain('allowTransparency')
    expect(frame).toContain('appearance: pageAppearance(background)')
    const css = readFileSync(join(import.meta.dir, '..', 'src', 'index.css'), 'utf8')
    expect(css).toMatch(/html\[data-container-background='off'\] \[data-frame\] > iframe/)
  })
})

describe('the rows keep their surface', () => {
  const css = readFileSync(join(import.meta.dir, '..', 'src', 'index.css'), 'utf8')
  const read = (file: string) => readFileSync(join(import.meta.dir, '..', 'src', 'canvas', file), 'utf8')

  test('no rule under background off clears a header or footer row', () => {
    const rules = css.split('}').filter((rule) => rule.includes("data-container-background='off'"))
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(rule).not.toContain('.container-grip')
      expect(rule).not.toContain('.container-footer')
      expect(rule).not.toContain('.container-reveal')
    }
    expect(css).toMatch(/html\[data-container-background='off'\] \[data-frame\] > iframe \{\s*background-color: transparent;/)
  })

  test('the header and footer rows paint an opaque card surface', () => {
    expect(read('FooterBar.tsx')).toMatch(/container-footer bg-card /)
    expect(read('Container.tsx')).toMatch(/container-grip[^'`]*bg-card|bg-card[^'`]*container-grip/)
    expect(read('AppearancePreview.tsx')).toMatch(/container-grip bg-card/)
  })

  test('the preview body is transparent when off and its rows are still solid', () => {
    const preview = read('AppearancePreview.tsx')
    expect(preview).toContain("now.background ? 'bg-card' : ''")
    expect(preview).toMatch(/container-grip bg-card/)
  })
})
