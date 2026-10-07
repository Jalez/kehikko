import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ModuleList } from '../src/canvas/Modules.tsx'
import { TooltipProvider } from '../src/components/ui/tooltip.tsx'
import { arrange, attention, HERE, matches, OTHER, rowsOf, shelfOf } from '../src/host/moduleMenu.ts'
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
