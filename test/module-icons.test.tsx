import { afterEach, describe, expect, test } from 'bun:test'
import { BRAND_MODULE_ICONS, LUCIDE_MODULE_ICONS, MODULE_ICONS, isModuleIcon } from 'kehikot-module-protocol'
import { renderToStaticMarkup } from 'react-dom/server'

import listed from '../modules.json'
import { namedByLists } from '../server/known.ts'
import { readOfficial } from '../server/official.ts'
import { BRAND_MARKS } from '../src/canvas/brandMarks.ts'
import { KEHIKOT_ITSELF, LUCIDE_DRAWN, ModuleIcon, iconOfModule, setListedIcons, setRegisteredIcons } from '../src/canvas/ModuleIcon.tsx'
import { ModuleList } from '../src/canvas/Modules.tsx'
import { TooltipProvider } from '../src/components/ui/tooltip.tsx'
import { initialOf, moduleIconFor } from '../src/host/moduleIcon.ts'
import { rowsOf } from '../src/host/moduleMenu.ts'
import type { Presence, RegistryView } from '../src/host/registry.ts'

/*
 * Every module its own icon (protocol 2.14.0), and Kehikot its own mark: the
 * official list's icons, which key wins, what a module with none gets, that
 * every key the protocol names can be drawn, and the modules menu drawn with
 * them. What's new is drawn in `whats-new-dom.test.tsx`.
 */

afterEach(() => {
  setRegisteredIcons([])
  setListedIcons([])
})

/* Flows is on My modules, not the official list; its manifest declares this. */
const FLOWS = 'lucide:workflow'

describe('the official list', () => {
  const entries = readOfficial(listed)

  test('gives every module an icon the protocol knows', () => {
    for (const entry of entries) expect({ id: entry.id, known: isModuleIcon(entry.icon) }).toEqual({ id: entry.id, known: true })
  })

  test('gives no two modules the same icon, Flows included', () => {
    const icons = [...entries.map((entry) => entry.icon), FLOWS]
    expect(new Set(icons).size).toBe(icons.length)
  })

  test('never uses Kehikot’s sparkles for a module', () => {
    expect(entries.some((entry) => entry.icon?.includes('sparkles'))).toBe(false)
  })

  test('an icon this host cannot use is dropped, not a reason to refuse the list', () => {
    const one = { id: 'kehikot.x', name: 'X', repo: 'Jalez/x', port: 9999, summary: '', tags: [] }
    const read = readOfficial({ modules: [{ ...one, icon: 'x'.repeat(500) }, { ...one, id: 'kehikot.y', icon: 'https://example.com/i.svg' }] })
    expect(read[0]!.icon).toBeUndefined()
    expect(isModuleIcon(read[1]!.icon)).toBe(false)
  })
})

describe('every key the protocol names can be drawn', () => {
  test('each Lucide name has its component, and nothing else does', () => {
    expect(Object.keys(LUCIDE_DRAWN).sort()).toEqual([...LUCIDE_MODULE_ICONS].sort())
    for (const name of LUCIDE_MODULE_ICONS) expect(typeof LUCIDE_DRAWN[name]).toBe('object')
  })

  test('each brand has its path data, and nothing else does', () => {
    expect(Object.keys(BRAND_MARKS).sort()).toEqual([...BRAND_MODULE_ICONS].sort())
    for (const slug of BRAND_MODULE_ICONS) expect(BRAND_MARKS[slug].path).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/)
  })

  test('every key draws as itself, never the fallback', () => {
    for (const key of MODULE_ICONS) {
      expect(renderToStaticMarkup(<ModuleIcon icon={key} name="M" />)).toContain(`data-module-icon="${key}"`)
    }
  })
})

describe('which icon wins', () => {
  test('the module’s own, then the list’s, then none', () => {
    expect(moduleIconFor('brand:latex', 'lucide:file-text')).toBe('brand:latex')
    expect(moduleIconFor(undefined, 'lucide:file-text')).toBe('lucide:file-text')
    expect(moduleIconFor(null, null)).toBeNull()
  })

  test('a path, a URL or an unknown name is skipped, never used', () => {
    expect(moduleIconFor('/icon.svg', 'lucide:route')).toBe('lucide:route')
    expect(moduleIconFor('https://example.com/a.svg', undefined)).toBeNull()
    expect(moduleIconFor('lucide:not-an-icon', 'brand:nope')).toBeNull()
  })

  test('the page asks the registry first, then the list', () => {
    setListedIcons([{ id: 'kehikot.paper', icon: 'lucide:file-text' }, { id: 'kehikot.diff', icon: 'lucide:git-compare' }])
    setRegisteredIcons([{ id: 'kehikot.paper', icon: 'brand:latex' }, { id: 'kehikot.diff', icon: null }])
    expect(iconOfModule('kehikot.paper')).toBe('brand:latex')
    expect(iconOfModule('kehikot.diff')).toBe('lucide:git-compare')
    expect(iconOfModule('kehikot.unknown')).toBeNull()
  })

  test('a declared key beats the one a row passes in', () => {
    setRegisteredIcons([{ id: 'kehikot.paper', icon: 'brand:latex' }])
    expect(renderToStaticMarkup(<ModuleIcon id="kehikot.paper" icon="lucide:file-text" name="Paper" />)).toContain('data-module-icon="brand:latex"')
  })
})

describe('a module with no icon', () => {
  test('gets the neutral frame and its initial, never sparkles', () => {
    const html = renderToStaticMarkup(<ModuleIcon id="me.scores" name="scores" />)
    expect(html).toContain('data-module-icon="fallback"')
    expect(html).toContain('>S</text>')
    expect(html).not.toContain('sparkles')
  })

  test('the initial is the first letter or digit, and ? when there is none', () => {
    expect(initialOf('  journeys')).toBe('J')
    expect(initialOf('3D')).toBe('3')
    expect(initialOf('ääni')).toBe('Ä')
    expect(initialOf('—')).toBe('?')
  })
})

describe('Kehikot itself', () => {
  test('is drawn with its own mark, the bar’s, not a module icon and not sparkles', () => {
    const html = renderToStaticMarkup(<ModuleIcon id={KEHIKOT_ITSELF} name="Kehikot" />)
    expect(html).toContain('kehikko-mark')
    expect(html).toContain('data-module-icon="kehikot"')
    expect(html).not.toContain('sparkles')
  })
})

describe('who hears the name', () => {
  test('beside its name the icon is hidden; alone it is labelled with the name, and says it as a tooltip', () => {
    const beside = renderToStaticMarkup(<ModuleIcon icon="brand:claude" name="Claude" />)
    expect(beside).toContain('aria-hidden="true"')
    expect(beside).not.toContain('aria-label')
    const alone = renderToStaticMarkup(<ModuleIcon icon="brand:claude" name="Claude" alone />)
    expect(alone).toContain('role="img"')
    expect(alone).toContain('aria-label="Claude"')
    expect(alone).toContain('<title>Claude</title>')
  })

  test('brand marks are drawn in the text’s colour, like the rest', () => {
    expect(renderToStaticMarkup(<ModuleIcon icon="brand:latex" name="Paper" />)).toContain('fill="currentColor"')
  })
})

describe('the modules menu, drawn', () => {
  const AT = 'http://127.0.0.1:7870'
  const presence = (over: Partial<Presence> & { id: string }): Presence => ({ at: AT, condition: 'silent', reached: false, line: 'not running', ...over })
  const presences = [
    presence({ id: 'kehikot.paper', name: 'Paper', tags: ['writing'], icon: 'brand:latex' }),
    presence({ id: 'kehikot.claude', name: 'Claude', tags: ['agents'], icon: 'brand:claude' }),
    presence({ id: 'kehikot.journeys', name: 'Journeys', tags: ['planning'], icon: 'lucide:route' }),
    presence({ id: 'me.scores', name: 'Scores', tags: ['music'] }),
  ]
  const registry: RegistryView = { presences, sweep: { dir: '/tmp/modules', rejected: [] }, protocol: 2 }

  test('every row has its module’s icon beside its name, and one with none its initial', () => {
    setRegisteredIcons(presences)
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ModuleList registry={registry} onCanvas={new Set()} canvases={[]} open={null} onPlace={() => {}} onUnplace={() => {}} />
      </TooltipProvider>,
    )
    const drawn = [...html.matchAll(/data-module-icon="([^"]+)"/g)].map((match) => match[1])
    expect(drawn).toEqual(expect.arrayContaining(['brand:latex', 'brand:claude', 'lucide:route', 'fallback']))
    expect(drawn.length).toBe(4)
    expect(html).not.toContain('sparkles')
  })
})

describe('the agent brand marks', () => {
  test('each new key draws its own mark, with the title it names', () => {
    for (const slug of ['openai', 'googlegemini', 'opencode', 'mistralai'] as const) {
      expect(BRAND_MODULE_ICONS).toContain(slug)
      const html = renderToStaticMarkup(<ModuleIcon icon={`brand:${slug}`} name="Agent" />)
      expect(html).toContain(`data-module-icon="brand:${slug}"`)
      expect(html).toContain(BRAND_MARKS[slug].path.slice(0, 20))
    }
  })

  test('a brand key this host does not know is drawn as the module’s initial, never blank', () => {
    const html = renderToStaticMarkup(<ModuleIcon icon="brand:from-a-newer-protocol" name="Zed" />)
    expect(html).toContain('data-module-icon="fallback"')
    expect(html).toContain('>Z</text>')
    setRegisteredIcons([{ id: 'kehikot.zed', icon: 'brand:from-a-newer-protocol' }])
    expect(iconOfModule('kehikot.zed')).toBeNull()
    expect(renderToStaticMarkup(<ModuleIcon id="kehikot.zed" name="Zed" />)).toContain('>Z</text>')
  })

  test('the official list gives the agent modules their marks', () => {
    const byId = new Map(readOfficial(listed).map((entry) => [entry.id, entry.icon]))
    expect(byId.get('kehikot.codex')).toBe('brand:openai')
    expect(byId.get('kehikot.antigravity')).toBe('brand:googlegemini')
    expect(byId.get('kehikot.opencode')).toBe('brand:opencode')
    expect(byId.get('kehikot.vibe')).toBe('brand:mistralai')
  })
})


describe('a module installed from a repository, not on the official list', () => {
  const never: Presence = { id: 'kehikot.antigravity', at: 'http://127.0.0.1:9040', condition: 'silent', reached: false, line: 'not running' }
  const mineEntry = {
    id: 'kehikot.antigravity',
    name: 'Antigravity',
    summary: 'A terminal.',
    tags: ['agents'],
    repo: 'Jalez/kehikko-antigravity',
    host: 'github.com',
    port: 9040,
    installed: true,
    mine: true,
  } as never

  test('its row says its name while it has never answered, from the person’s own list, and the server fills it for every other surface', () => {
    const [row] = rowsOf([never], new Set(), [], [mineEntry])
    expect(row!.name).toBe('Antigravity')
    const named = { ...never, ...namedByLists(never.id, [[], [mineEntry]]) }
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ModuleList registry={{ presences: [named], sweep: { dir: '/tmp/modules', rejected: [] }, protocol: 2 }} onCanvas={new Set()} canvases={[]} open={null} onPlace={() => {}} onUnplace={() => {}} />
      </TooltipProvider>,
    )
    expect(html).toContain('>Antigravity<')
  })
})
