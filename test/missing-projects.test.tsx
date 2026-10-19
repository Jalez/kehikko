import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

import { createCanvas, open } from '../server/canvases.ts'
import { recordDataVersion } from '../server/dataVersions.ts'
import { setDisposition } from '../server/dispositions.ts'
import { createEpic } from '../server/holdings.ts'
import { keep, syncEvery, syncProject } from '../server/kehikot.ts'
import { call, type Door } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { makeUnderRoot, resetMissingSaid, setMissingLog } from '../server/projectRoot.ts'
import { addProject, isMissingProject, isProject, listProjects, projectById, shareKehikot } from '../server/projects.ts'
import { editTrackers } from '../server/trackers/edit.ts'
import { Wakes } from '../server/wake.ts'
import { MISSING_SAID, MissingMark, MissingProject } from '../src/canvas/MissingProject.tsx'

/**
 * A project whose folder was renamed, moved or deleted is never made again.
 *
 * Every write under a project root used to `mkdirSync(…, { recursive: true })`,
 * and at every start `syncEvery` wrote `kehikot.json` from the database for a
 * project whose file would not read — which, for a folder that is gone, rebuilt
 * the old path with `.kehikot/kehikko/kehikot.json` inside it.
 */

let scratch: string
let root: string
let db: Database
let said: string[]

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-missing-')))
  root = join(scratch, 'renamed-away')
  mkdirSync(root)
  db = open(':memory:')
  said = []
  resetMissingSaid()
  setMissingLog((line) => said.push(line))
})
afterEach(() => {
  setMissingLog((line) => console.warn(line))
  resetMissingSaid()
  db.close()
  rmSync(scratch, { recursive: true, force: true })
})

/** A project with a kehikko and its file written, and then its folder gone. */
function goneProject(): { id: number; canvas: number } {
  const added = addProject(db, root)
  if (!added.ok) throw new Error(added.why)
  const canvas = createCanvas(db, 'second', added.project.id).id
  keep(db, added.project.id)
  expect(existsSync(join(root, '.kehikot', 'kehikko', 'kehikot.json'))).toBe(true)
  rmSync(root, { recursive: true, force: true })
  return { id: added.project.id, canvas }
}

/** Nothing at all is left in the scratch folder: no root, no `.kehikot`, no parents. */
function nothingMade(): void {
  expect(existsSync(root)).toBe(false)
  expect(readdirSync(scratch)).toEqual([])
}

describe('a project whose folder is gone', () => {
  test('listProjects and projectById say missing, and nothing about epics, git or sharing', () => {
    const { id } = goneProject()
    const [listed] = listProjects(db)
    expect(listed).toMatchObject({ id, missing: true, epics: false, git: false, shared: false })
    expect(projectById(db, id)?.missing).toBe(true)
    nothingMade()
  })

  test('a folder that is there is not missing', () => {
    const added = addProject(db, root)
    expect(added.ok && added.project.missing).toBe(false)
  })

  test('a sync at start makes nothing: no folder, no kehikot.json', () => {
    const { id } = goneProject()
    expect(syncEvery(db)).toEqual([])
    expect(syncProject(db, { id, path: root }).outcome).toBe('missing')
    keep(db, id)
    nothingMade()
  })

  test('a disposition is refused in the sentence, and nothing is written', () => {
    goneProject()
    const marked = setDisposition(root, { ref: '#1', value: 'done' }, 'test')
    expect(marked.ok).toBe(false)
    expect(!marked.ok && marked.why).toContain(MISSING_SAID)
    nothingMade()
  })

  test('a data version is not recorded, and nothing is written', () => {
    goneProject()
    expect(recordDataVersion(root, 'kehikot.notes', 3)).toBe(false)
    nothingMade()
  })

  test('tracker sources, a new epic and the .gitignore are all refused without writing', () => {
    const { id } = goneProject()
    const edited = editTrackers(root, { kind: 'remotes', on: false }, [])
    expect(edited.outcome).toBe('declined')
    expect(edited.why).toContain(MISSING_SAID)
    const made = createEpic(root, { title: 'A new epic' })
    expect(made.ok).toBe(false)
    expect(shareKehikot(db, id, false).ok).toBe(false)
    nothingMade()
  })

  test('is said once per root per start, not once per write', () => {
    goneProject()
    syncEvery(db)
    syncEvery(db)
    recordDataVersion(root, 'kehikot.notes', 3)
    setDisposition(root, { ref: '#1', value: 'done' }, 'test')
    expect(said).toHaveLength(1)
    expect(said[0]).toContain(root)
  })

  test('the helper makes folders inside a root that is there, and never the root', () => {
    expect(makeUnderRoot(root, join(root, '.kehikot', 'kehikko'))).toBe(true)
    expect(existsSync(join(root, '.kehikot', 'kehikko'))).toBe(true)
    rmSync(root, { recursive: true, force: true })
    expect(makeUnderRoot(root, join(root, '.kehikot', 'kehikko'))).toBe(false)
    nothingMade()
  })

  test('/host/is-project: not a project, and missing says why', () => {
    goneProject()
    expect(isProject(db, root)).toBe(false)
    expect(isMissingProject(db, root)).toBe(true)
    expect(isMissingProject(db, `${root}/`)).toBe(true)
    /* A link to the parent still names it, as `/tmp` does `/private/tmp` on a Mac. */
    const link = join(tmpdir(), `kehikko-missing-link-${process.pid}`)
    symlinkSync(scratch, link)
    try {
      expect(isMissingProject(db, join(link, 'renamed-away'))).toBe(true)
    } finally {
      rmSync(link)
    }
    expect(isMissingProject(db, join(scratch, 'never-a-project'))).toBe(false)
    nothingMade()
  })

  test('the MCP door answers in a sentence, without throwing and without writing', async () => {
    const { canvas } = goneProject()
    const openness = new Openness()
    const wakes = new Wakes()
    const door: Door = {
      db,
      which: () => openness.open(),
      wake: (kehikko) => wakes.woke(kehikko),
      epicsChanged: (project) => wakes.epicsChanged(project),
      dispositionsChanged: (project) => wakes.dispositionsChanged(project),
      seen: async () => [],
    }
    const marked = await call('mark_disposition', { kehikko: canvas, ref: '#1', value: 'done' }, door)
    expect(marked.failed).toBe(true)
    expect(marked.text).toContain(MISSING_SAID)
    const epic = await call('create_epic', { kehikko: canvas, title: 'Anything' }, door)
    expect(epic.failed).toBe(true)
    expect(epic.text).toContain(MISSING_SAID)
    const read = await call('read_canvas', { kehikko: canvas }, door)
    expect(read.text).toContain(MISSING_SAID)
    nothingMade()
  })
})

describe('the page', () => {
  test('a missing project opens on the sentence and its path, not on a canvas', () => {
    const html = renderToStaticMarkup(<MissingProject project={{ name: 'renamed-away', path: '/old/renamed-away' }} />)
    expect(html).toContain("Kehikot can&#x27;t find this folder any more. It was moved, renamed or deleted.")
    expect(html).toContain('/old/renamed-away')
    expect(html).toContain('data-missing-project')
  })

  test('its row in the list says moved or renamed, with the sentence as its label', () => {
    const html = renderToStaticMarkup(<MissingMark />)
    expect(html).toContain('moved or renamed')
    expect(html).toContain('aria-label="Kehikot can&#x27;t find this folder any more. It was moved, renamed or deleted."')
  })

  test('the page and the server say the same sentence', async () => {
    const server = await import('../server/projectRoot.ts')
    expect(server.MISSING_SAID).toBe(MISSING_SAID)
  })
})
