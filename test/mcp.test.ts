import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { createCanvas, editCanvas, listCanvases, open } from '../server/canvases.ts'
import { addProject } from '../server/projects.ts'
import { call, mcp, type Door, type Sighting } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { Wakes } from '../server/wake.ts'

/**
 * The host's own door.
 *
 * Two things it has to get right, and both are here: WHICH kehikko a call is
 * about — because the open one is a fact about a browser tab and this server
 * does not have one — and a refusal for everything it cannot do, in a sentence
 * saying what to do instead. A tool that silently acts on the wrong canvas is
 * worse than one that asks.
 */

let db: Database
let openness: Openness
let wakes: Wakes
let woken: number[]
let seen: Sighting[]
let folder: string

const door = (): Door => ({
  db,
  which: () => openness.open(),
  wake: (kehikko) => {
    woken.push(kehikko)
    wakes.woke(kehikko)
  },
  epicsChanged: (project) => wakes.epicsChanged(project),
  seen: async () => seen,
})

const at = (i: string, x = 0) => ({ i, x, y: 0, w: 6, h: 10 })

beforeEach(() => {
  db = open(':memory:')
  openness = new Openness()
  wakes = new Wakes()
  woken = []
  seen = [
    { id: 'a.one', name: 'One', condition: 'ready' },
    { id: 'a.two', name: 'Two', condition: 'ready' },
  ]
  folder = mkdtempSync(join(tmpdir(), 'frame-mcp-'))
})
afterEach(() => {
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

/** A kehikko in a project, with two containers on it. */
function aCanvas(name = 'the wire') {
  /* A name is still accepted at the door and is no longer what a project is
     called: that is the folder's own name, read on every list. See `named`. */
  const added = addProject(db, folder, 'a project')
  const project = added.ok ? added.project.id : null
  const made = createCanvas(db, name, project)
  editCanvas(db, made.id, { epic: 'modes-are-modules', placements: [at('a.one'), at('a.two', 6)] })
  return made.id
}

describe('the door says what it is and what it offers', () => {
  test('initialize names the host and offers tools', async () => {
    const reply = await mcp({ id: 1, method: 'initialize' }, door(), { name: 'kehikko', version: '0.1.0' })
    const result = (reply.body as { result: { serverInfo: { name: string }; capabilities: unknown } }).result
    expect(result.serverInfo.name).toBe('kehikko')
    expect(result.capabilities).toEqual({ tools: {} })
  })

  test('four tools and no more', async () => {
    const reply = await mcp({ id: 2, method: 'tools/list' }, door(), { name: 'kehikko', version: '0.1.0' })
    const tools = (reply.body as { result: { tools: { name: string }[] } }).result.tools
    /* The surface is still narrow on purpose, and the line has moved once:
       reading, selecting, and two ADDITIVE acts — putting a module on, making
       an epic. Removing, moving, resizing, switching or renaming anything
       would be an agent rearranging a workspace somebody is looking at, and
       none of those is here. See the essay in `mcp.ts` for which half of the
       original argument survived. */
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'create_epic',
      'place_modules',
      'read_canvas',
      'select_modules',
    ])
  })

  test('a notification is answered with nothing', async () => {
    const reply = await mcp({ method: 'notifications/initialized' }, door(), { name: 'k', version: '0' })
    expect(reply.status).toBe(202)
    expect(reply.body).toBeNull()
  })

  test('a method this door does not have is an unknown method', async () => {
    const reply = await mcp({ id: 3, method: 'resources/list' }, door(), { name: 'k', version: '0' })
    expect(reply.status).toBe(404)
  })

  test('a tool this door does not have is refused by name', async () => {
    const reply = await mcp(
      { id: 4, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } },
      door(),
      { name: 'k', version: '0' },
    )
    const result = (reply.body as { result: { content: { text: string }[]; isError?: boolean } }).result
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('read_canvas, select_modules, place_modules, create_epic')
  })
})

describe('which kehikko an agent means', () => {
  test('the one a page says it has open, said out loud in the answer', async () => {
    const id = aCanvas()
    openness.reported('page-a', id)
    const done = await call('read_canvas', {}, door())
    expect(done.failed).toBe(false)
    expect(done.text).toContain(`kehikko ${id}: the wire`)
    expect(done.text).toContain('a page of this host has open')
  })

  test('with no page open it refuses, and lists the kehikot to name one of', async () => {
    const id = aCanvas()
    const done = await call('read_canvas', {}, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('kehikko: <id>')
    expect(done.text).toContain(`  ${id}: the wire`)
  })

  test('two pages on two kehikot refuses rather than picking one', async () => {
    const here = aCanvas('here')
    const there = createCanvas(db, 'there').id
    openness.reported('page-a', here)
    openness.reported('page-b', there)
    const done = await call('select_modules', { modules: ['a.one'] }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('different kehikot open')
    /* Nothing was written, which is the half that matters. */
    expect(listCanvases(db).find((c) => c.id === here)?.placements.some((p) => p.selected)).toBe(false)
  })

  test('a named kehikko wins over what a page has open', async () => {
    const here = aCanvas('here')
    const there = createCanvas(db, 'there').id
    openness.reported('page-a', here)
    const done = await call('read_canvas', { kehikko: there }, door())
    expect(done.text).toContain(`kehikko ${there}: there`)
    expect(done.text).toContain('the kehikko you named')
  })

  test('a kehikko id that names nothing is refused with the list', async () => {
    const id = aCanvas()
    const done = await call('read_canvas', { kehikko: 9999 }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('there is no kehikko with id 9999')
    expect(done.text).toContain(`  ${id}: the wire`)
  })

  test('a kehikko that is not a whole number is refused rather than read generously', async () => {
    aCanvas()
    /* `Number('3')` is 3, and a door that took that would act on a canvas the
       agent did not name if the string were ever something else. */
    const done = await call('read_canvas', { kehikko: '3' }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('whole number')
  })
})

describe('reading what is on a kehikko', () => {
  test('the containers, the project, the epic and what is picked out', async () => {
    const id = aCanvas()
    editCanvas(db, id, { placements: [{ ...at('a.one'), selected: true }, at('a.two', 6)] })
    const done = await call('read_canvas', { kehikko: id }, door())

    expect(done.text).toContain(basename(folder))
    expect(done.text).not.toContain('a project')
    expect(done.text).toContain(folder)
    expect(done.text).toContain('epic: modes-are-modules')
    expect(done.text).toContain('selected containers (1 of 2): a.one')
    expect(done.text).toContain('a.one (One) — SELECTED')
    expect(done.text).toContain('a.two (Two)')
  })

  test('nothing selected says so rather than leaving it out', async () => {
    const id = aCanvas()
    const done = await call('read_canvas', { kehikko: id }, door())
    expect(done.text).toContain('selected containers: none of the 2 here')
  })

  test('a container whose module is not answering is marked as such', async () => {
    const id = aCanvas()
    seen = [
      { id: 'a.one', name: 'One', condition: 'silent' },
      { id: 'a.two', name: 'Two', condition: 'ready' },
    ]
    const done = await call('read_canvas', { kehikko: id }, door())
    /* Selecting a container whose program is not running is a perfectly
       ordinary thing to do, and an agent asked to work on one should know. */
    expect(done.text).toContain('not answering (silent)')
  })

  test('an empty kehikko is a state, not a failure', async () => {
    const id = createCanvas(db, 'bare').id
    const done = await call('read_canvas', { kehikko: id }, door())
    expect(done.failed).toBe(false)
    expect(done.text).toContain('There are no containers on this kehikko.')
  })
})

describe('setting the module selection', () => {
  test('naming containers makes them the selected ones', async () => {
    const id = aCanvas()
    openness.reported('page-a', id)
    const done = await call('select_modules', { modules: ['a.two'] }, door())
    expect(done.failed).toBe(false)

    const placements = listCanvases(db).find((c) => c.id === id)?.placements ?? []
    expect(placements.find((p) => p.i === 'a.two')?.selected).toBe(true)
    expect(placements.find((p) => p.i === 'a.one')?.selected).toBe(false)
  })

  test('it replaces rather than adds, and an empty list unpicks everything', async () => {
    const id = aCanvas()
    await call('select_modules', { kehikko: id, modules: ['a.one', 'a.two'] }, door())
    await call('select_modules', { kehikko: id, modules: ['a.one'] }, door())
    expect(
      listCanvases(db)
        .find((c) => c.id === id)
        ?.placements.filter((p) => p.selected)
        .map((p) => p.i),
    ).toEqual(['a.one'])

    const done = await call('select_modules', { kehikko: id, modules: [] }, door())
    expect(done.failed).toBe(false)
    expect(done.text).toContain('Nothing is selected')
    expect(listCanvases(db).find((c) => c.id === id)?.placements.some((p) => p.selected)).toBe(false)
  })

  test('a container that is not on the kehikko is refused whole', async () => {
    const id = aCanvas()
    const done = await call('select_modules', { kehikko: id, modules: ['a.one', 'a.nowhere'] }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('a.nowhere is not a container')
    expect(done.text).toContain('a.one, a.two')
    /* Whole, not partly: an agent believing it selected two containers when it
       selected one would go on to act against the one it did not get. */
    expect(listCanvases(db).find((c) => c.id === id)?.placements.some((p) => p.selected)).toBe(false)
  })

  test('modules has to be a list of ids, and the refusal says what one looks like', async () => {
    const id = aCanvas()
    for (const bad of [undefined, 'a.one', 42, [''], [{}], [1]]) {
      const done = await call('select_modules', { kehikko: id, modules: bad }, door())
      expect(done.failed).toBe(true)
    }
    const said = await call('select_modules', { kehikko: id, modules: undefined }, door())
    expect(said.text).toContain('modules: ["roadmap.journeys"]')
  })

  test('the same id twice is one selection', async () => {
    const id = aCanvas()
    const done = await call('select_modules', { kehikko: id, modules: ['a.one', 'a.one'] }, door())
    expect(done.text).toContain('Selected on kehikko')
    expect(done.text).toContain('selected containers (1 of 2)')
  })

  test('the page is woken, after the write and not before', async () => {
    const id = aCanvas()
    const heard: number[] = []
    wakes.listen((news) => {
      /* The stream carries two shapes now — see `News` in `server/wake.ts` —
         and only one of them is a kehikko. */
      if (!('kehikko' in news)) return
      const kehikko = news.kehikko
      /* Read from the database at the moment the wake arrives: a page that
         re-read on a wake sent before the write would show the old
         arrangement, and nothing would wake it a second time. */
      const selected = listCanvases(db)
        .find((c) => c.id === kehikko)
        ?.placements.filter((p) => p.selected)
        .map((p) => p.i)
      expect(selected).toEqual(['a.one'])
      heard.push(kehikko)
    })
    await call('select_modules', { kehikko: id, modules: ['a.one'] }, door())
    expect(heard).toEqual([id])
  })

  test('a refusal wakes nobody', async () => {
    const id = aCanvas()
    await call('select_modules', { kehikko: id, modules: ['a.nowhere'] }, door())
    await call('select_modules', { kehikko: 9999, modules: ['a.one'] }, door())
    expect(woken).toEqual([])
  })

  test('picking a container out changes nothing else about it', async () => {
    const id = aCanvas()
    editCanvas(db, id, {
      placements: [{ ...at('a.one'), pinned: true, collapsed: true, wish: 12, prompt: 'read this' }],
    })
    const was = listCanvases(db).find((c) => c.id === id)?.placements[0]
    await call('select_modules', { kehikko: id, modules: ['a.one'] }, door())
    const now = listCanvases(db).find((c) => c.id === id)?.placements[0]
    expect(now).toEqual({ ...was!, selected: true })
  })

  test('the refs picked out of a tracker are a different axis and are left alone', async () => {
    const id = aCanvas()
    editCanvas(db, id, { selection: ['gh#105'] })
    await call('select_modules', { kehikko: id, modules: ['a.one'] }, door())
    expect(listCanvases(db).find((c) => c.id === id)?.selection).toEqual(['gh#105'])
  })
})
