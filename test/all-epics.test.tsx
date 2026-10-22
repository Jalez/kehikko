import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { scopeOf } from 'kehikot-module-protocol'

import { createCanvas, editCanvas, listSubjects, open as openDb, readSubject, setSubject } from '../server/canvases.ts'
import { keep, kehikotFile, parse, syncProject } from '../server/kehikot.ts'
import { parseView, serializeView, viewFile } from '../server/view.ts'
import { addProject, type Project } from '../server/projects.ts'
import { call, type Door, type Sighting } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { Wakes } from '../server/wake.ts'
import { Epics } from '../src/canvas/Epics.tsx'
import { TooltipProvider } from '../src/components/ui/tooltip.tsx'
import { toWireContext } from '../src/host/context.ts'
import { ALL_EPICS, ONE_EPIC_AT_A_TIME, coveredForScope } from '../src/host/scope.ts'
import { NOTHING, edited, scopeAfter, subjectsSchema } from '../src/host/subject.ts'

/**
 * "All epics": the project on every epic at once (protocol 2.9.0's
 * `context.scope: 'project'`), kept where the epic is kept, sent to every
 * module, and covered by a sentence on a module that works on one epic.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-all-epics-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let made = 0
function folder(): string {
  const dir = join(root, `p${(made += 1)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
function project(store: Database, dir: string): Project {
  const out = addProject(store, dir, undefined, false)
  if (!out.ok) throw new Error(out.why)
  return out.project
}

describe('the subject: "All epics" is held where the epic is, and is not "no epic"', () => {
  test('choosing it clears the epic, the parts and the selection, and is read back', () => {
    const store = openDb(':memory:')
    const p = project(store, folder())
    setSubject(store, p.id, { epic: 'one', parts: ['a'], selection: ['gh#1'] })
    expect(setSubject(store, p.id, { scope: 'project' })).toEqual({ epic: null, scope: 'project', parts: [], selection: [] })
    expect(readSubject(store, p.id)).toEqual({ epic: null, scope: 'project', parts: [], selection: [] })
    expect(listSubjects(store).find((row) => row.project === p.id)?.scope).toBe('project')
  })

  test('picking an epic, or "no epic", leaves it; an edit of the selection alone keeps it', () => {
    const store = openDb(':memory:')
    const p = project(store, folder())
    setSubject(store, p.id, { scope: 'project' })
    setSubject(store, p.id, { selection: ['gh#2'] })
    expect(readSubject(store, p.id)).toEqual({ epic: null, scope: 'project', parts: [], selection: ['gh#2'] })
    /* Parts are of ONE epic: on all epics they are refused, whatever the edit says. */
    expect(setSubject(store, p.id, { parts: ['a'] })?.parts).toEqual([])
    expect(setSubject(store, p.id, { epic: 'two' })).toEqual({ epic: 'two', parts: [], selection: [] })
    setSubject(store, p.id, { scope: 'project' })
    expect(setSubject(store, p.id, { epic: null })).toEqual({ epic: null, parts: [], selection: [] })
  })

  test('a project nobody has put on it reads exactly as it did — no scope key', () => {
    const store = openDb(':memory:')
    const p = project(store, folder())
    setSubject(store, p.id, { epic: 'one' })
    expect(readSubject(store, p.id)).toEqual({ epic: 'one', parts: [], selection: [] })
    expect(Object.keys(readSubject(store, p.id)!)).not.toContain('scope')
  })

  test('the page applies the server’s rule, from the one shared `scopeAfter`', () => {
    expect(scopeAfter({}, {})).toBe('epic')
    expect(scopeAfter({ scope: 'project' }, { selection: [] })).toBe('project')
    expect(scopeAfter({ scope: 'project' }, { epic: 'one' })).toBe('epic')
    expect(scopeAfter({ scope: 'project' }, { epic: null })).toBe('epic')
    const all = edited({ epic: 'one', parts: ['a'], selection: ['gh#1'] }, { scope: 'project' })
    expect(all).toEqual({ epic: null, scope: 'project', parts: [], selection: [] })
    expect(edited(all, { epic: 'two' })).toEqual({ epic: 'two', parts: [], selection: [] })
    expect(edited(NOTHING, { scope: 'project', epic: 'ignored' })).toEqual({ epic: null, scope: 'project', parts: [], selection: [] })
  })

  test('the page reads the server’s list, an older server’s included', () => {
    expect(subjectsSchema.parse([{ project: 1, epic: null, scope: 'project', parts: [], selection: [] }])[1]).toEqual({
      epic: null,
      scope: 'project',
      parts: [],
      selection: [],
    })
    expect(subjectsSchema.parse([{ project: 2, epic: 'one', selection: [] }])[2]).toEqual({ epic: 'one', parts: [], selection: [] })
  })
})

describe('the person’s view.json', () => {
  test('says "scope": "project" only while it is chosen, and reads it back', () => {
    const dir = folder()
    const store = openDb(':memory:')
    const p = project(store, dir)
    createCanvas(store, 'writing', p.id, 'writing')
    setSubject(store, p.id, { epic: 'one' })
    keep(store, p.id)
    expect(readFileSync(viewFile(dir)!, 'utf8')).not.toContain('"scope"')
    setSubject(store, p.id, { scope: 'project' })
    keep(store, p.id)
    const text = readFileSync(viewFile(dir)!, 'utf8')
    expect(JSON.parse(text).scope).toBe('project')
    expect(parseView(text)?.subject).toEqual({ epic: null, scope: 'project', parts: [], selection: [] })
    /* And the shared file says nothing about it. */
    expect(readFileSync(kehikotFile(dir)!, 'utf8')).not.toContain('"scope"')
  })

  test('a file that says it is applied to the project; one that does not leaves "All epics"', () => {
    const dir = folder()
    const store = openDb(':memory:')
    const p = project(store, dir)
    createCanvas(store, 'writing', p.id, 'writing')
    setSubject(store, p.id, { scope: 'project' })
    keep(store, p.id)
    /* Another machine's database, the same file: it arrives on "All epics". */
    const there = openDb(':memory:')
    const q = project(there, dir)
    syncProject(there, q)
    expect(readSubject(there, q.id)?.scope).toBe('project')
    /* And a hand-edited file naming one epic takes it off again. */
    expect(serializeView({ subject: { epic: 'one', parts: [], selection: [] }, kehikot: new Map() })).not.toContain('scope')
  })

  test('"All epics" in a file holds no epic and no parts, whatever else it says', () => {
    const read = parse(JSON.stringify({ version: 2, epic: 'one', scope: 'project', parts: ['a'], selection: [], kehikot: [] }))
    expect(read.ok && read.legacy?.subject).toEqual({ epic: null, scope: 'project', parts: [], selection: [] })
    const view = parseView(JSON.stringify({ version: 1, epic: 'one', scope: 'project', parts: ['a'], selection: [], kehikot: {} }))
    expect(view?.subject).toEqual({ epic: null, scope: 'project', parts: [], selection: [] })
  })
})

describe('what every module is told', () => {
  const project = { id: 1, name: 'Shop', path: '/tmp/shop' } as unknown as Project

  test('scope "project", no epic and no parts — and that is not "no epic"', () => {
    const parts = [{ id: 'a', name: 'A', picked: true }] as never[]
    const all = toWireContext({ epic: 'one', scope: 'project', project }, 'light', [], null, null, [], [], undefined, [], parts)
    expect(all.scope).toBe('project')
    expect(all.epic).toBeNull()
    expect(all.parts).toEqual([])
    const none = toWireContext({ epic: null, project }, 'light')
    expect(none.epic).toBeNull()
    expect(none.scope).toBe('epic')
    expect(scopeOf(all)).not.toBe(scopeOf(none))
  })

  test('one epic says so', () => {
    expect(toWireContext({ epic: 'one', project }, 'light').scope).toBe('epic')
  })
})

describe('a module that works on one epic at a time is covered', () => {
  const oneEpic = { declares: {} }
  const both = { declares: { scopes: ['epic', 'project'] as ('epic' | 'project')[] } }

  test('only on "All epics", only when it does not declare project, and never when pinned', () => {
    expect(coveredForScope('project', oneEpic)).toBe(true)
    expect(coveredForScope('project', { declares: { scopes: ['epic'] as ('epic' | 'project')[] } })).toBe(true)
    expect(coveredForScope('project', both)).toBe(false)
    expect(coveredForScope('epic', oneEpic)).toBe(false)
    expect(coveredForScope(undefined, oneEpic)).toBe(false)
    expect(coveredForScope('project', oneEpic, true)).toBe(false)
    /* Not read yet: it has a cover of its own. */
    expect(coveredForScope('project', null)).toBe(false)
  })

  test('the sentence', () => {
    expect(ONE_EPIC_AT_A_TIME).toBe('This module works on one epic at a time. Pick an epic to use it.')
  })
})

describe('the epic picker, closed', () => {
  const held = {
    holds: true,
    epics: [{ slug: 'one', title: 'One' }],
  } as never

  test('says "All epics" while it is chosen, and the epic otherwise', () => {
    const draw = (allEpics: boolean, epic: string | null) =>
      renderToStaticMarkup(
        <TooltipProvider>
          <Epics
            epic={epic}
            allEpics={allEpics}
            onPickAll={() => {}}
            held={held}
            hasProject
            onPick={() => {}}
            onRetitle={async () => true}
            onCreate={async () => true}
            onDelete={() => {}}
          />
        </TooltipProvider>,
      )
    expect(draw(true, null)).toContain(ALL_EPICS)
    expect(draw(false, 'one')).not.toContain(ALL_EPICS)
    expect(draw(false, 'one')).toContain('One')
    /* A menu a keyboard can open, as before. */
    expect(draw(true, null)).toContain('aria-haspopup="menu"')
  })
})

describe('the door reports the scope', () => {
  function door(store: Database, openness: Openness, seen: Sighting[]): Door {
    const wakes = new Wakes()
    return {
      db: store,
      which: () => openness.open(),
      wake: (kehikko) => wakes.woke(kehikko),
      epicsChanged: (p) => wakes.epicsChanged(p),
      dispositionsChanged: (p) => wakes.dispositionsChanged(p),
      seen: async () => seen,
    }
  }

  test('read_canvas says all epics, and which containers are covered', async () => {
    const store = openDb(':memory:')
    const p = project(store, folder())
    const canvas = createCanvas(store, 'writing', p.id, 'writing')
    editCanvas(store, canvas.id, {
      placements: [
        { i: 'a.one', x: 0, y: 0, w: 6, h: 10 },
        { i: 'a.all', x: 6, y: 0, w: 6, h: 10 },
      ],
    })
    setSubject(store, p.id, { scope: 'project' })
    const openness = new Openness()
    openness.reported('page-a', canvas.id)
    const seen: Sighting[] = [
      { id: 'a.one', name: 'One', condition: 'ready' },
      { id: 'a.all', name: 'All', condition: 'ready', scopes: ['epic', 'project'] },
    ]
    const done = await call('read_canvas', {}, door(store, openness, seen))
    expect(done.failed).toBe(false)
    expect(done.text).toContain('epic: all epics')
    expect(done.text).toContain('scope: project')
    expect(done.text).toMatch(/a\.one \(One\) — works on one epic at a time/)
    expect(done.text).not.toMatch(/a\.all \(All\) — works on one epic at a time/)

    setSubject(store, p.id, { epic: 'one' })
    const again = await call('read_canvas', {}, door(store, openness, seen))
    expect(again.text).toContain('scope: epic')
    expect(again.text).not.toContain('works on one epic at a time')
  })

  test('my_place says the person is looking at all epics', async () => {
    const store = openDb(':memory:')
    const p = project(store, folder())
    const canvas = createCanvas(store, 'writing', p.id, 'writing')
    setSubject(store, p.id, { scope: 'project' })
    const openness = new Openness()
    openness.reported('page-a', canvas.id)
    const done = await call('my_place', {}, door(store, openness, []))
    expect(done.text).toContain('all epics (scope: project)')
  })
})
