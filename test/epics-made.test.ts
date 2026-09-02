import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EPIC_SLUG } from 'roadmap-module-protocol'

import { createCanvas, editCanvas, listCanvases, open } from '../server/canvases.ts'
import { createEpic, listEpics } from '../server/holdings.ts'
import { call, mcp, type Door, type Sighting } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { addProject } from '../server/projects.ts'
import { Wakes, type News } from '../server/wake.ts'
import { offerOfCreate, slugFrom } from '../src/host/epics.ts'

/*
 * Making an epic — from the page, from the door, and the rule that both are
 * one write.
 *
 * Against real directories, as `retitle.test.ts` is, because what this does is
 * put a file in somebody's repository and the property that matters — that
 * the file is the same whichever way it was asked for — is a property of the
 * bytes on disk.
 */

const root = mkdtempSync(join(tmpdir(), 'kehikko-epics-made-'))
let made = 0

/** A project folder. `holds` says whether it has a `data/epics` to begin with. */
function project(holds: boolean, files: Record<string, string> = {}): string {
  const dir = join(root, `p${(made += 1)}`)
  mkdirSync(dir, { recursive: true })
  if (holds) mkdirSync(join(dir, 'data', 'epics'), { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'data', 'epics', name), text)
  return dir
}

function epicFile(dir: string, slug: string): string {
  return readFileSync(join(dir, 'data', 'epics', `${slug}.json`), 'utf8')
}

afterEach(() => {
  /* Each test makes its own folders; the root goes at the end. */
})
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

describe('what a made epic is', () => {
  test('the minimum every reader accepts: slug, title, and the day — nothing invented', () => {
    const dir = project(true)
    const said = createEpic(dir, { title: 'The page is components' }, '2026-09-02')
    expect(said.ok).toBe(true)
    /* Two-space JSON with a trailing newline, the roadmap's own shape, so its
       first edit is a one-field diff. No lede, no steps, no callout: those are
       what a person or the roadmap fills in, and an empty list here would be
       this host asserting "no steps" on somebody's behalf. */
    expect(epicFile(dir, 'the-page-is-components')).toBe(
      '{\n  "slug": "the-page-is-components",\n  "title": "The page is components",\n  "written": "2026-09-02"\n}\n',
    )
    /* And the picker reads it back with no size, because `countOf` answers
       null rather than zero when there is nothing to count. */
    expect(listEpics(dir)).toEqual([{ slug: 'the-page-is-components', title: 'The page is components' }])
  })

  test('a slug this host makes is one the protocol takes', () => {
    const dir = project(true)
    const said = createEpic(dir, { title: 'Ünïcode & punctuation!! in a "title"' })
    if (!said.ok) throw new Error(said.why)
    expect(said.epic.slug).toBe('unicode-punctuation-in-a-title')
    expect(EPIC_SLUG.test(said.epic.slug)).toBe(true)
  })

  test('a slug that was given wins over the one the title would make', () => {
    const dir = project(true)
    const said = createEpic(dir, { slug: 'components', title: 'The page is components' })
    if (!said.ok) throw new Error(said.why)
    expect(said.epic.slug).toBe('components')
    expect(existsSync(join(dir, 'data', 'epics', 'components.json'))).toBe(true)
    expect(existsSync(join(dir, 'data', 'epics', 'the-page-is-components.json'))).toBe(false)
  })

  test('the answer is the epic as the picker reads it', () => {
    const dir = project(true)
    const said = createEpic(dir, { title: 'Made' })
    if (!said.ok) throw new Error(said.why)
    expect(said.epic).toEqual({ slug: 'made', title: 'Made' })
    expect(said.madeDirectory).toBe(false)
    expect(said.file).toBe(join(dir, 'data', 'epics', 'made.json'))
  })
})

describe('the three empty states, on the server', () => {
  test('a project with no data/epics gets one made, and says so', () => {
    const dir = project(false)
    writeFileSync(join(dir, 'main.tex'), '\\begin{document}\\end{document}')
    expect(existsSync(join(dir, 'data'))).toBe(false)
    const said = createEpic(dir, { title: 'Chapter one' })
    if (!said.ok) throw new Error(said.why)
    expect(said.madeDirectory).toBe(true)
    expect(existsSync(join(dir, 'data', 'epics', 'chapter-one.json'))).toBe(true)
    /* And the retitle beside it, which refuses such a project, now has
       something to retitle — the directory is real. */
    expect(listEpics(dir).map((e) => e.slug)).toEqual(['chapter-one'])
  })

  test('a project whose data/epics is empty gets a file in it, and no directory is made', () => {
    const dir = project(true)
    const said = createEpic(dir, { title: 'First' })
    if (!said.ok) throw new Error(said.why)
    expect(said.madeDirectory).toBe(false)
  })
})

describe('the three empty states, on the page', () => {
  /* `offerOfCreate` is what the `+` is drawn from, and it is data so that each
     state can be asserted here — this host has no DOM harness, and a button
     that is or is not rendered is otherwise a thing only a browser can see. */
  test('no project: the + is not offered at all', () => {
    expect(offerOfCreate(false, null)).toEqual({ offered: false })
    expect(offerOfCreate(false, { holds: true, epics: [] })).toEqual({ offered: false })
  })

  test('no data/epics: offered, and the note says the directory will be made', () => {
    const offer = offerOfCreate(true, { holds: false, epics: [] })
    expect(offer.offered).toBe(true)
    if (!offer.offered) return
    expect(offer.makesDirectory).toBe(true)
    expect(offer.note).toContain('makes that directory')
  })

  test('an empty data/epics: offered, a file goes in it', () => {
    const offer = offerOfCreate(true, { holds: true, epics: [] })
    expect(offer).toMatchObject({ offered: true, makesDirectory: false })
  })

  test('still reading, or the read failed: offered anyway, because the server decides', () => {
    expect(offerOfCreate(true, null)).toMatchObject({ offered: true, makesDirectory: false })
  })
})

describe('what a create refuses', () => {
  test('a slug that is not one, with the server’s sentence', () => {
    const dir = project(true)
    const said = createEpic(dir, { slug: 'Not A Slug', title: 'Fine' })
    expect(said.ok).toBe(false)
    if (said.ok) return
    expect(said.status).toBe(400)
    expect(said.why).toContain('"Not A Slug" is not a slug')
    expect(listEpics(dir)).toEqual([])
  })

  test('a slug with a leading dash — legal to the protocol, not to this host', () => {
    const dir = project(true)
    const said = createEpic(dir, { slug: '-leading', title: 'Fine' })
    expect(said.ok).toBe(false)
  })

  test('a path, before anything is joined onto one', () => {
    const dir = project(true)
    const said = createEpic(dir, { slug: '../../escaped', title: 'Fine' })
    expect(said.ok).toBe(false)
    expect(existsSync(join(dir, 'escaped.json'))).toBe(false)
    expect(existsSync(join(root, 'escaped.json'))).toBe(false)
  })

  test('a title nothing can be derived from, and no slug given', () => {
    const dir = project(true)
    const said = createEpic(dir, { title: '!!!' })
    expect(said.ok).toBe(false)
    if (!said.ok) expect(said.why).toContain('Nothing in "!!!" makes a slug')
  })

  test('a slug that is already an epic here, which is never overwritten', () => {
    const dir = project(true, { 'taken.json': '{ "slug": "taken", "title": "Somebody’s", "steps": [1, 2] }\n' })
    const said = createEpic(dir, { slug: 'taken', title: 'Mine now' })
    expect(said.ok).toBe(false)
    if (said.ok) return
    expect(said.status).toBe(409)
    expect(said.why).toContain('already an epic called taken')
    expect(epicFile(dir, 'taken')).toBe('{ "slug": "taken", "title": "Somebody’s", "steps": [1, 2] }\n')
  })

  test('the same title rules as a retitle: empty, too long, two lines', () => {
    const dir = project(true)
    expect(createEpic(dir, { title: '   ' }).ok).toBe(false)
    expect(createEpic(dir, { title: 'x'.repeat(201) }).ok).toBe(false)
    expect(createEpic(dir, { title: 'two\nlines' }).ok).toBe(false)
    expect(createEpic(dir, { title: 12 as unknown as string }).ok).toBe(false)
    expect(listEpics(dir)).toEqual([])
  })
})

describe('the slug a title makes', () => {
  test('lowercase, dashes for runs of anything else, trimmed at the ends', () => {
    expect(slugFrom('The page is components')).toBe('the-page-is-components')
    expect(slugFrom('  Modes — are   modules!  ')).toBe('modes-are-modules')
    expect(slugFrom('v2.0: the "portable" kehikko')).toBe('v2-0-the-portable-kehikko')
  })

  test('accents fold to their letters; what has no letter at all makes nothing', () => {
    expect(slugFrom('Ääkköset ja ümlaut')).toBe('aakkoset-ja-umlaut')
    expect(slugFrom('!!!')).toBe('')
    expect(slugFrom('')).toBe('')
  })

  test('cut at eighty, and not left ending in a dash', () => {
    const long = slugFrom(`${'word '.repeat(30)}`)
    expect(long.length).toBeLessThanOrEqual(80)
    expect(long.endsWith('-')).toBe(false)
    expect(EPIC_SLUG.test(long)).toBe(true)
  })
})

/*
 * The door and the page produce THE SAME FILE.
 *
 * Asserted against each other rather than against two hand-written
 * expectations: the claim is not "each writes what I think it writes", it is
 * that there is one writer. The page's path is `POST /host/epics` in
 * `server.ts`, which calls `createEpic(project.path, { slug, title })` and
 * nothing else — so that call, made here exactly as the route makes it, IS the
 * page's path.
 */
describe('one writer, two callers', () => {
  let db: Database
  let openness: Openness
  let wakes: Wakes
  let news: News[]
  let woken: number[]
  const seen: Sighting[] = [{ id: 'a.one', name: 'One', condition: 'ready' }]

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

  beforeEach(() => {
    db = open(':memory:')
    openness = new Openness()
    wakes = new Wakes()
    news = []
    woken = []
    wakes.listen((one) => news.push(one))
  })
  afterEach(() => db.close())

  /** A kehikko in a project folder, about some epic already, with one container. */
  function kehikkoIn(dir: string): { id: number; project: number } {
    const added = addProject(db, dir, 'a project')
    if (!added.ok) throw new Error(added.why)
    const canvas = createCanvas(db, 'the wire', added.project.id)
    editCanvas(db, canvas.id, { epic: 'something-else', placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10 }] })
    return { id: canvas.id, project: added.project.id }
  }

  test('the same bytes from the page’s route and from create_epic', async () => {
    const byPage = project(true)
    const byDoor = project(true)
    const { id } = kehikkoIn(byDoor)

    /* The page's path, exactly as the route calls it. */
    const page = createEpic(byPage, { slug: undefined, title: 'The page is components' })
    if (!page.ok) throw new Error(page.why)

    const done = await call('create_epic', { kehikko: id, title: 'The page is components' }, door())
    expect(done.failed).toBe(false)

    expect(epicFile(byDoor, 'the-page-is-components')).toBe(epicFile(byPage, 'the-page-is-components'))
    /* With a slug given, too. */
    createEpic(byPage, { slug: 'given', title: 'Given' })
    await call('create_epic', { kehikko: id, slug: 'given', title: 'Given' }, door())
    expect(epicFile(byDoor, 'given')).toBe(epicFile(byPage, 'given'))
  })

  test('the door does not open the epic it made, and says so', async () => {
    const dir = project(true)
    const { id, project: projectId } = kehikkoIn(dir)
    const done = await call('create_epic', { kehikko: id, title: 'Not opened' }, door())
    expect(done.failed).toBe(false)
    expect(done.text).toContain('Created not-opened')
    expect(done.text).toContain('still about something-else')
    expect(listCanvases(db).find((c) => c.id === id)?.epic).toBe('something-else')
    /* The page is told its epics changed — not that the kehikko did, because
       it did not — so the dropdown gains the row without a re-read of an
       arrangement that is exactly what is on screen. */
    expect(woken).toEqual([])
    expect(news).toEqual([{ epics: projectId }])
  })

  test('a project with no data/epics is made one by the door as well, and the sentence says so', async () => {
    const dir = project(false)
    const { id } = kehikkoIn(dir)
    const done = await call('create_epic', { kehikko: id, title: 'First here' }, door())
    expect(done.failed).toBe(false)
    expect(done.text).toContain('made data/epics there')
    expect(existsSync(join(dir, 'data', 'epics', 'first-here.json'))).toBe(true)
  })

  test('a bad slug is refused by the server and its sentence reaches the agent as a tool error', async () => {
    const dir = project(true)
    const { id } = kehikkoIn(dir)
    const reply = await mcp(
      { id: 9, method: 'tools/call', params: { name: 'create_epic', arguments: { kehikko: id, slug: 'Bad Slug', title: 'Fine' } } },
      door(),
      { name: 'kehikko', version: '0' },
    )
    const result = (reply.body as { result: { content: { text: string }[]; isError?: boolean } }).result
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('"Bad Slug" is not a slug')
    expect(listEpics(dir)).toEqual([])
    expect(news).toEqual([])
  })

  test('a kehikko in no project has no folder to make an epic in', async () => {
    const canvas = createCanvas(db, 'loose', null)
    const done = await call('create_epic', { kehikko: canvas.id, title: 'Nowhere' }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('in no project')
  })

  test('a title is required, and is bounded before holdings sees it', async () => {
    const dir = project(true)
    const { id } = kehikkoIn(dir)
    expect((await call('create_epic', { kehikko: id }, door())).failed).toBe(true)
    expect((await call('create_epic', { kehikko: id, title: 'x'.repeat(2000) }, door())).failed).toBe(true)
    expect((await call('create_epic', { kehikko: id, title: 'ok', slug: 7 }, door())).failed).toBe(true)
    expect(listEpics(dir)).toEqual([])
  })
})
