import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { settingsRoute } from '../server/agentSettings.ts'
import { readAppearance, writeAppearance } from '../server/appearance.ts'
import { PAGE_ONLY, refusal } from '../server/guard.ts'
import {
  APPEARANCE_DEFAULT,
  collapseFor,
  APPEARANCE_TARGET,
  BACKGROUND_ATTR,
  BORDER_ATTR,
  BORDERS,
  appearanceIn,
  appearancePatched,
  fromCookies,
  lookCookie,
  themeOf,
} from '../src/host/appearance.ts'
import { AppearanceStore, adoptAppearance, paint } from '../src/host/appearanceStore.ts'
import { SETTINGS_SECTIONS, SETTINGS_TARGETS, settingsLinkOf } from '../src/host/agentSettings.ts'

/*
 * Settings › Appearance (`src/host/appearance.ts`): one setting for every
 * container, kept on this machine, changed only by the page. The tab itself
 * is `appearance-dom.test.tsx`.
 */

const ROOT = join(import.meta.dir, '..')

describe('the defaults', () => {
  test('what the app looked like before the tab: headers shown, one-row folds, dark, rounded borders, the card surface', () => {
    expect(APPEARANCE_DEFAULT).toEqual({ rows: 'always', foldRows: 1, collapse: 'fold', collapseEach: {}, collapseBase: 'fold', theme: 'dark', border: 'rounded', background: true })
    expect(appearanceIn(undefined)).toEqual(APPEARANCE_DEFAULT)
    expect(appearanceIn('nonsense')).toEqual(APPEARANCE_DEFAULT)
  })

  test('a stored value keeps each field it got right and takes the default for the rest', () => {
    expect(appearanceIn({ rows: 'click', foldRows: 3, theme: 'purple', border: 'dotted', background: 'no' })).toEqual({
      ...APPEARANCE_DEFAULT,
      rows: 'click',
      border: 'dotted',
    })
  })

  test('a change is one or more known fields, each valid; anything else is refused whole', () => {
    expect(appearancePatched(APPEARANCE_DEFAULT, { theme: 'system' })).toEqual({ ...APPEARANCE_DEFAULT, theme: 'system' })
    expect(appearancePatched(APPEARANCE_DEFAULT, { border: 'none', background: false })).toEqual({ ...APPEARANCE_DEFAULT, border: 'none', background: false })
    expect(appearancePatched(APPEARANCE_DEFAULT, {})).toBeNull()
    expect(appearancePatched(APPEARANCE_DEFAULT, { border: 'wavy' })).toBeNull()
    expect(appearancePatched(APPEARANCE_DEFAULT, { theme: 'light', accent: 'red' })).toBeNull()
    expect(appearancePatched(APPEARANCE_DEFAULT, [])).toBeNull()
  })

  test('System follows the computer; Light and Dark are themselves', () => {
    expect(themeOf('system', true)).toBe('dark')
    expect(themeOf('system', false)).toBe('light')
    expect(themeOf('light', true)).toBe('light')
    expect(themeOf('dark', false)).toBe('dark')
  })
})

describe('every border and background applies its attribute', () => {
  const root = () => {
    const attrs = new Map<string, string>()
    return { attrs, element: { setAttribute: (name: string, value: string) => void attrs.set(name, value) } as unknown as Element }
  }

  for (const border of BORDERS) {
    for (const background of [true, false]) {
      test(`${border}, background ${background ? 'on' : 'off'}`, () => {
        const { attrs, element } = root()
        paint({ ...APPEARANCE_DEFAULT, border, background }, element)
        expect(attrs.get(BORDER_ATTR)).toBe(border)
        expect(attrs.get(BACKGROUND_ATTR)).toBe(background ? 'on' : 'off')
      })
    }
  }

  test('the stylesheet has a rule for each, and none of them changes the border’s width', () => {
    const css = readFileSync(join(ROOT, 'src/index.css'), 'utf8')
    for (const border of BORDERS.filter((one) => one !== 'rounded')) expect(css).toContain(`html[data-container-border='${border}']`)
    expect(css).toContain("html[data-container-background='off']")
    const rules = css.slice(css.indexOf("html[data-container-border='none']"), css.indexOf('/* The tour shows hidden headers'))
    expect(rules).not.toMatch(/border-width|border:\s*0|border:\s*none|outline/)
  })

  test('the pre-paint script draws the border and background, and the theme with System, before React', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
    expect(html).toContain('kehikko\\.look=')
    expect(html).toContain("'data-container-border'")
    expect(html).toContain("'data-container-background'")
    expect(html).toContain('dark|light|system')
    expect(html).not.toContain('kehikko\\.focus=')
  })
})

describe('the cookies the pre-paint script reads', () => {
  test('round trip, and an old Headers choice carried over as reveal on hover', () => {
    const look = { ...APPEARANCE_DEFAULT, rows: 'longpress' as const, foldRows: 2 as const, border: 'dashed' as const, background: false }
    expect(fromCookies(`kehikko.theme=system; kehikko.look=${lookCookie(look)}`)).toEqual({ ...look, theme: 'system' })
    expect(fromCookies('kehikko.focus=on; kehikko.theme=light')).toEqual({ ...APPEARANCE_DEFAULT, rows: 'hover', theme: 'light' })
    expect(fromCookies('kehikko.focus=off')).toEqual(APPEARANCE_DEFAULT)
    expect(fromCookies('')).toEqual(APPEARANCE_DEFAULT)
  })
})

describe('the store on the page', () => {
  test('a change tells once; the same value again tells nothing; the server’s answer is adopted', () => {
    const store = new AppearanceStore()
    let told = 0
    store.subscribe(() => void (told += 1))
    store.set({ ...APPEARANCE_DEFAULT, border: 'solid' })
    store.set({ ...APPEARANCE_DEFAULT, border: 'solid' })
    expect(told).toBe(1)
    store.adopt({ ...APPEARANCE_DEFAULT, theme: 'light', stored: true })
    expect(store.get()).toEqual({ ...APPEARANCE_DEFAULT, theme: 'light' })
  })

  test('the theme persists: a stored choice is adopted; a machine with no row yet is given what the cookies said, once', () => {
    const store = new AppearanceStore({ ...APPEARANCE_DEFAULT, rows: 'hover' })
    const migrated: unknown[] = []
    adoptAppearance({ ...APPEARANCE_DEFAULT, stored: false }, (now) => void migrated.push(now), store)
    expect(migrated).toEqual([{ ...APPEARANCE_DEFAULT, rows: 'hover' }])
    expect(store.get().rows).toBe('hover')
    adoptAppearance({ ...APPEARANCE_DEFAULT, theme: 'system', stored: true }, (now) => void migrated.push(now), store)
    expect(store.get().theme).toBe('system')
    expect(migrated).toHaveLength(1)
    adoptAppearance(undefined, (now) => void migrated.push(now), store)
    expect(store.get().theme).toBe('system')
  })
})

describe('kept on this machine, changed only by the page', () => {
  const route = (db: Database) =>
    settingsRoute({ db, status: () => ({ at: null, problems: [] }) as never, changed: () => {}, skillsAt: () => '/tmp/skills', hook: () => ({ file: '/x', on: false }) })
  const call = async (handler: ReturnType<typeof route>, method: string, body?: unknown) => {
    const url = new URL('http://127.0.0.1/host/settings')
    const response = await handler(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url)
    return { status: response!.status, body: (await response!.json()) as Record<string, unknown> }
  }

  test('one row of settings: none at first, the defaults; a change is kept whole and read back', async () => {
    const db = new Database(':memory:')
    db.exec('create table settings (key text primary key, value text not null)')
    const handler = route(db)
    expect((await call(handler, 'GET')).body.appearance).toEqual({ ...APPEARANCE_DEFAULT, stored: false })
    const changed = await call(handler, 'POST', { appearance: { theme: 'light', border: 'dotted' } })
    expect(changed.status).toBe(200)
    expect(changed.body.appearance).toEqual({ ...APPEARANCE_DEFAULT, theme: 'light', border: 'dotted', stored: true })
    await call(handler, 'POST', { appearance: { background: false } })
    expect(readAppearance(db)).toEqual({ ...APPEARANCE_DEFAULT, theme: 'light', border: 'dotted', background: false, stored: true })
  })

  test('a change it does not take is refused with a sentence, and nothing is written', async () => {
    const db = new Database(':memory:')
    db.exec('create table settings (key text primary key, value text not null)')
    writeAppearance(db, { ...APPEARANCE_DEFAULT, theme: 'light' })
    const refused = await call(route(db), 'POST', { appearance: { border: 'wavy' } })
    expect(refused.status).toBe(400)
    expect(refused.body.why).toBe('That is not a change Appearance takes.')
    expect(readAppearance(db).theme).toBe('light')
  })

  test('the route is page-only: a program is refused, the page’s own press is not', () => {
    expect(PAGE_ONLY).toContain('/host/settings')
    const self = { hosts: new Set(['127.0.0.1:4180']), origins: ['http://127.0.0.1:4180'] }
    const ask = (headers: Record<string, string>) =>
      refusal({ method: 'POST', pathname: '/host/settings', headers: new Headers({ host: '127.0.0.1:4180', ...headers }) }, self)
    expect(ask({ 'content-type': 'application/json' })).not.toBeNull()
    expect(ask({ 'content-type': 'application/json', origin: 'https://evil.example' })).not.toBeNull()
    expect(ask({ 'content-type': 'application/json', origin: 'http://127.0.0.1:4180' })).toBeNull()
  })

  test('no MCP tool reads or changes it', () => {
    const mcp = readFileSync(join(ROOT, 'server/mcp.ts'), 'utf8')
    expect(mcp).not.toMatch(/appearance/i)
  })
})

describe('a link into Settings › Appearance', () => {
  test('is a section, and a target a button can open it at', () => {
    expect(SETTINGS_SECTIONS).toContain('appearance')
    expect(SETTINGS_TARGETS.appearance).toEqual({ section: 'appearance', target: APPEARANCE_TARGET })
    expect(settingsLinkOf({ section: 'appearance', target: APPEARANCE_TARGET })).toEqual({ section: 'appearance', target: APPEARANCE_TARGET })
  })
})

describe('the ^ button per module', () => {
  test('one answer is the same for every module', () => {
    expect(collapseFor({ ...APPEARANCE_DEFAULT, collapse: 'tile' }, 'kehikot.a')).toBe('tile')
    expect(collapseFor({ ...APPEARANCE_DEFAULT, collapse: 'fold', collapseEach: { 'kehikot.a': 'tile' } }, 'kehikot.a')).toBe('fold')
  })

  test('each: the map applies, and a module not in it takes the default', () => {
    const each = { ...APPEARANCE_DEFAULT, collapse: 'each' as const, collapseBase: 'tile' as const, collapseEach: { 'kehikot.a': 'fold' as const } }
    expect(collapseFor(each, 'kehikot.a')).toBe('fold')
    expect(collapseFor(each, 'kehikot.b')).toBe('tile')
    expect(collapseFor({ ...each, collapseBase: 'fold' }, 'kehikot.b')).toBe('fold')
    expect(collapseFor(each, 'toString')).toBe('tile')
    expect(collapseFor(each, undefined)).toBe('tile')
  })

  test('the map is stored whole, and a bad one is the default', () => {
    expect(appearanceIn({ collapse: 'each', collapseEach: { a: 'tile' } })).toMatchObject({ collapse: 'each', collapseEach: { a: 'tile' } })
    expect(appearanceIn({ collapseEach: { a: 'huge' } }).collapseEach).toEqual({})
    expect(appearancePatched(APPEARANCE_DEFAULT, { collapseEach: { a: 'huge' } })).toBeNull()
    expect(appearancePatched(APPEARANCE_DEFAULT, { collapseEach: { a: 'fold' } })?.collapseEach).toEqual({ a: 'fold' })
  })
})
