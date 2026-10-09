import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ModuleList } from '../src/canvas/Modules.tsx'
import { TooltipProvider } from '../src/components/ui/tooltip.tsx'
import { arrange, attention, builtFrom, HERE, matches, OTHER, rowsOf, shelfOf, warnings } from '../src/host/moduleMenu.ts'
import type { Presence, RegistryView } from '../src/host/registry.ts'

/*
 * The module list: where a module is filed, what a search finds, and which
 * rows say something. The last is the one that matters most — a list where
 * every sleeping module explains itself is a list where the broken one is
 * invisible.
 */

const AT = 'http://127.0.0.1:7870'

function presence(over: Partial<Presence> & { id: string }): Presence {
  return { at: AT, condition: 'silent', reached: false, line: `${over.id} is registered at ${AT} and nothing is answering.`, ...over }
}

const paper = presence({ id: 'kehikot.paper', name: 'Paper', summary: 'The paper, read as prose.', tags: ['writing', 'reading'] })
const diff = presence({ id: 'kehikot.diff', name: 'Diff', summary: 'The diff of the selected change.', tags: ['code', 'review'], condition: 'ready', reached: true, line: 'The diff of the selected change.' })
const tests = presence({ id: 'kehikot.tests', name: 'Tests', summary: 'What was run.', tags: ['tests'], lifecycle: 'asleep' })
const journeys = presence({ id: 'kehikot.journeys', name: 'Journeys', summary: 'What has to become true.', tags: ['planning'] })
const sessions = presence({ id: 'kehikot.orchestrator', name: 'Orchestrator', summary: 'Start a session.', tags: ['agents'] })
const mine = presence({ id: 'me.scores', name: 'Scores', summary: 'Sheet music.', tags: ['music-theory'] })
const bare = presence({ id: 'me.thing' })

describe('where a module is filed', () => {
  test('the first tag decides, and close tags share a shelf', () => {
    expect(shelfOf(['writing', 'code'])).toBe('Reading and writing')
    expect(shelfOf(['reading'])).toBe('Reading and writing')
    expect(shelfOf(['review'])).toBe('Code')
    expect(shelfOf(['tests'])).toBe('Code')
  })

  test('a tag nobody here knows is its own shelf, and no tags is other', () => {
    expect(shelfOf(['music-theory'])).toBe('Music theory')
    expect(shelfOf([])).toBe(OTHER)
    /* A stranger's string, looked up in an object. */
    expect(shelfOf(['constructor'])).toBe('Constructor')
  })

  test('sections come in a fixed order, each module once, placed ones first', () => {
    const rows = rowsOf([mine, bare, sessions, tests, diff, paper, journeys], new Set(['kehikot.diff']))
    const sections = arrange(rows)
    expect(sections.map((s) => s.heading)).toEqual([HERE, 'Planning', 'Reading and writing', 'Code', 'Agents', 'Music theory', OTHER])
    expect(sections.flatMap((s) => s.rows.map((r) => r.id)).sort()).toEqual(rows.map((r) => r.id).sort())
    expect(sections[0]!.rows.map((r) => r.id)).toEqual(['kehikot.diff'])
    expect(sections[3]!.rows.map((r) => r.id)).toEqual(['kehikot.tests'])
  })

  test('a module that is asleep is still named, described and shelved from what the host remembers', () => {
    const [row] = rowsOf([tests], new Set())
    expect(row).toMatchObject({ name: 'Tests', summary: 'What was run.', tags: ['tests'] })
    expect(rowsOf([bare], new Set())[0]).toMatchObject({ name: 'me.thing', summary: '', tags: [] })
  })
})

describe('what the official list adds', () => {
  const entry = (over: { id: string; name: string; tags: string[]; installed: boolean }) => ({ repo: `Jalez/${over.name.toLowerCase()}`, summary: `${over.name}, from the list.`, ...over })
  const official = [
    entry({ id: 'kehikot.paper', name: 'Paper', tags: ['writing'], installed: true }),
    entry({ id: 'kehikot.slides', name: 'Slides', tags: ['writing'], installed: false }),
    entry({ id: 'kehikot.atlas', name: 'Atlas', tags: ['planning'], installed: false }),
  ]

  test('modules not on this machine, on their shelves, after the ones that are', () => {
    const sections = arrange(rowsOf([paper, mine], new Set(), official))
    expect(sections.map((s) => s.heading)).toEqual(['Planning', 'Reading and writing', 'Music theory'])
    expect(sections[1]!.rows.map((r) => [r.id, r.kind])).toEqual([['kehikot.paper', 'registered'], ['kehikot.slides', 'available']])
    expect(matches(sections[0]!.rows[0]!, 'atlas planning')).toBe(true)
  })

  test('a registered module is marked official or not, and unknown when there is no list', () => {
    const [a, b] = rowsOf([paper, mine], new Set(), official)
    expect([a!.kind === 'registered' && a!.official, b!.kind === 'registered' && b!.official]).toEqual([true, false])
    const [c] = rowsOf([mine], new Set())
    expect(c!.kind === 'registered' && c!.official).toBeNull()
  })

  test('what a module says about itself wins; the list fills in for one that has never answered', () => {
    const silent = presence({ id: 'kehikot.slides' })
    const [fresh] = rowsOf([silent], new Set(), official)
    expect(fresh).toMatchObject({ name: 'Slides', summary: 'Slides, from the list.', tags: ['writing'] })
    const [told] = rowsOf([paper], new Set(), official)
    expect(told).toMatchObject({ summary: 'The paper, read as prose.', tags: ['writing', 'reading'] })
  })
})

describe('what a search finds', () => {
  const [row] = rowsOf([diff], new Set())

  test('the name, the summary, a tag, the shelf and the id', () => {
    for (const query of ['dif', 'SELECTED change', 'review', 'code', 'kehikot.diff', '  ']) expect(matches(row!, query)).toBe(true)
  })

  test('every word has to be there', () => {
    expect(matches(row!, 'diff review')).toBe(true)
    expect(matches(row!, 'diff paper')).toBe(false)
  })

  test('sections with nothing left in them are not drawn', () => {
    const sections = arrange(rowsOf([paper, diff, journeys], new Set()), 'writing')
    expect(sections.map((s) => s.heading)).toEqual(['Reading and writing'])
  })
})

describe('which rows need a person', () => {
  test('not running does not, however it came to be not running', () => {
    expect(attention(diff)).toBeNull()
    expect(attention(paper)).toBeNull()
    expect(attention(tests)).toBeNull()
    expect(attention(presence({ id: 'kehikot.notes', lifecycle: 'starting', reached: true }))).toBeNull()
  })

  test('a module this host cannot speak to does, and the sentence says which side to update', () => {
    const newer = presence({ id: 'a.b', condition: 'incompatible', reached: true, line: 'A was built against protocol 3. This host speaks protocol 2.', protocols: { host: 2, module: 3, range: '>=3' } })
    expect(attention(newer)).toBe('A was built against protocol 3. This host speaks protocol 2. Update Kehikot to use it.')
    const older = { ...newer, line: 'A speaks protocol <2. This host speaks protocol 2.', protocols: { host: 2, module: 1, range: '<2' } }
    expect(attention(older)).toEndWith('Update the module to use it.')
  })

  test('an address held by something that is not the module does', () => {
    const taken = presence({ id: 'a.b', reached: true, line: `Something is answering at ${AT}, but what it served is not JSON. No module here answers as a.b.` })
    expect(attention(taken)).toEndWith(`Check what is running at ${AT}, then start the module again.`)
  })
})

describe('the list, drawn', () => {
  const registry: RegistryView = {
    presences: [paper, diff, tests, presence({ id: 'a.b', name: 'Broken', reached: true, line: 'Something is answering, and it is not this.' })],
    sweep: { dir: '/registry', rejected: [] },
    protocol: 2,
  }
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <ModuleList registry={registry} onCanvas={new Set(['kehikot.diff'])} canvases={[]} open={null} onPlace={() => {}} onUnplace={() => {}} />
    </TooltipProvider>,
  )

  test('is called Kehikko modules, has a search box, and is grouped', () => {
    expect(html).toContain('Kehikko modules')
    expect(html).toContain('type="search"')
    for (const heading of [HERE, 'Reading and writing', 'Code', OTHER]) expect(html).toContain(`aria-label="${heading}"`)
  })

  test('a sleeping module shows its summary and no sentence about not answering', () => {
    expect(html).toContain('The paper, read as prose.')
    expect(html).toContain('What was run.')
    /* The host's reasoning is still there, folded into the details. */
    const alerts = html.match(/role="alert"[^>]*>[^<]*/g) ?? []
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('Something is answering, and it is not this. Check what is running')
  })

  test('the address is under details, not on the row', () => {
    expect(html).toMatch(/<details[^>]*>.*address.*127\.0\.0\.1:7870/s)
  })
})

describe('what a module is built from, and what it says wrongly about itself', () => {
  const module = (over: Partial<NonNullable<Presence['module']>> = {}): NonNullable<Presence['module']> => ({
    id: 'kehikot.diff',
    name: 'Diff',
    version: '1.4.0',
    summary: 'The diff of the selected change.',
    entry: `${AT}/app`,
    icon: null,
    health: null,
    mcp: null,
    modes: [],
    extensions: { emits: [], consumes: [] },
    declares: { protocol: '>=2', uses: [], storage: false },
    ...over,
  })
  const build = { version: '1.4.0', commit: 'abc1234def5678', started: '2026-10-09T10:00:00.000Z', protocol: '0.36.0' }
  const WARNING =
    'kehikot.diff does not say how it relates to the parts of an epic. Add \'parts\' to reacts and narrow with the protocol’s focus helpers, or set partless to one sentence saying why nothing in it belongs to a part.'

  test('the version, the commit its server started on, and the protocol package', () => {
    expect(builtFrom({ ...diff, module: module({ build }) })).toEqual({ version: '1.4.0 (abc1234)', protocol: '0.36.0' })
    /* A module from before build identities says only its version. */
    expect(builtFrom({ ...diff, module: module() })).toEqual({ version: '1.4.0', protocol: null })
    expect(builtFrom({ ...diff, module: module({ build: null }) })).toEqual({ version: '1.4.0', protocol: null })
    /* Not answering: nothing is known. */
    expect(builtFrom(paper)).toBeNull()
  })

  test('warnings are a ready module’s, and never trouble', () => {
    const warned = { ...diff, module: module({ build }), warnings: [WARNING] }
    expect(warnings(warned)).toEqual([WARNING])
    expect(attention(warned)).toBeNull()
    expect(warnings(diff)).toEqual([])
    /* A module that is not answering is not described by what it once said. */
    expect(warnings({ ...paper, warnings: [WARNING] })).toEqual([])
  })

  const draw = (presences: Presence[]) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <ModuleList
          registry={{ presences, sweep: { dir: '/registry', rejected: [] }, protocol: 2 }}
          onCanvas={new Set()}
          canvases={[]}
          open={null}
          onPlace={() => {}}
          onUnplace={() => {}}
        />
      </TooltipProvider>,
    )

  test('the protocol version is in the row’s details, beside the address', () => {
    const html = draw([{ ...diff, module: module({ build }) }])
    expect(html).toMatch(/<dt>version<\/dt><dd[^>]*>1\.4\.0 \(abc1234\)<\/dd>/)
    expect(html).toMatch(/<dt>protocol<\/dt><dd[^>]*>0\.36\.0<\/dd>/)
    /* And is simply absent for a module that does not say. */
    expect(draw([{ ...diff, module: module() }])).not.toContain('<dt>protocol</dt>')
  })

  test('a module that declares nothing about parts gets one quiet line, and one that does gets none', () => {
    const html = draw([{ ...diff, module: module({ build }), warnings: [WARNING] }])
    expect(html).toContain('data-warning=""')
    expect(html).toContain('does not say how it relates to the parts of an epic')
    /* Quiet: not an alert. */
    expect(html).not.toContain('role="alert"')
    expect(draw([{ ...diff, module: module({ build }) }])).not.toContain('data-warning')
  })
})
