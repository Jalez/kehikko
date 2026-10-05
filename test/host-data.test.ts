import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { open } from '../server/canvases.ts'
import { listEpics } from '../server/holdings.ts'
import { addProject, adopt } from '../server/projects.ts'
import { moduleFolder } from 'kehikot-module-protocol'

import { HOST_ID } from '../server/kehikot.ts'
import { HOST_FOLDER, epicsDir, migrateHostData, stateDir } from '../server/hostData.ts'

/**
 * A project's epics and state moved from `<project>/data/{epics,state}`, and
 * then from `<project>/.kehikot/roadmap/{epics,state}` (the folder named after
 * the app before it was Kehikot), to `<project>/.kehikot/kehikko/{epics,state}`.
 * These hold the migration to the rules it promises: move `data/` and copy
 * `.kehikot/roadmap/` when the new place is free, never overwrite, never delete
 * the pre-rename copy, leave both when both exist, and remove `data/` only when
 * the move emptied it.
 */

let scratch: string
const lines: string[] = []
const log = (line: string) => lines.push(line)
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-host-data-')))
  lines.length = 0
})
afterEach(() => rmSync(scratch, { recursive: true, force: true }))

function legacy(name: string, { epics = true, state = true, other = false } = {}): string {
  const root = join(scratch, name)
  if (epics) {
    mkdirSync(join(root, 'data', 'epics'), { recursive: true })
    writeFileSync(join(root, 'data', 'epics', 'a.json'), '{"slug":"a","title":"Legacy A"}\n')
  }
  if (state) {
    mkdirSync(join(root, 'data', 'state'), { recursive: true })
    writeFileSync(join(root, 'data', 'state', 'a.json'), '{"generated":"then"}\n')
  }
  if (other) writeFileSync(join(root, 'data', 'requests.db'), 'x')
  mkdirSync(root, { recursive: true })
  return root
}

describe('migrateHostData', () => {
  test('moves data/epics and data/state under .kehikot/kehikko and removes the emptied data/', () => {
    const root = legacy('p')
    const said = migrateHostData(root, log)
    expect(said.moved).toHaveLength(2)
    expect(said.conflicts).toHaveLength(0)
    expect(said.removedData).toBe(true)
    expect(existsSync(join(root, 'data'))).toBe(false)
    expect(readFileSync(join(epicsDir(root), 'a.json'), 'utf8')).toContain('Legacy A')
    expect(readFileSync(join(stateDir(root), 'a.json'), 'utf8')).toContain('then')
    expect(epicsDir(root)).toBe(join(root, '.kehikot', 'kehikko', 'epics'))
  })

  test('keeps data/ when something else is still in it', () => {
    const root = legacy('p', { other: true })
    const said = migrateHostData(root, log)
    expect(said.moved).toHaveLength(2)
    expect(said.removedData).toBe(false)
    expect(existsSync(join(root, 'data', 'requests.db'))).toBe(true)
  })

  test('never overwrites: when both exist the legacy one is left and both paths are logged', () => {
    const root = legacy('p', { state: false })
    mkdirSync(epicsDir(root), { recursive: true })
    writeFileSync(join(epicsDir(root), 'b.json'), '{"slug":"b","title":"New B"}\n')
    const said = migrateHostData(root, log)
    expect(said.moved).toHaveLength(0)
    expect(said.conflicts).toEqual([[join(root, 'data', 'epics'), epicsDir(root)]])
    expect(existsSync(join(root, 'data', 'epics', 'a.json'))).toBe(true)
    expect(existsSync(join(epicsDir(root), 'a.json'))).toBe(false)
    expect(lines.some((line) => line.includes(join(root, 'data', 'epics')) && line.includes(epicsDir(root)))).toBe(true)
  })

  test('moves only the one that is free when the other conflicts', () => {
    const root = legacy('p')
    mkdirSync(stateDir(root), { recursive: true })
    const said = migrateHostData(root, log)
    expect(said.moved).toEqual([[join(root, 'data', 'epics'), epicsDir(root)]])
    expect(said.conflicts).toEqual([[join(root, 'data', 'state'), stateDir(root)]])
    expect(said.removedData).toBe(false)
  })

  test('a folder with no data/ is left untouched, and no .kehikot is made', () => {
    const root = join(scratch, 'thesis')
    mkdirSync(root)
    const said = migrateHostData(root, log)
    expect(said).toEqual({ moved: [], copied: [], conflicts: [], removedData: false })
    expect(existsSync(join(root, '.kehikot'))).toBe(false)
  })

  test('a data/ with neither epics nor state is not touched', () => {
    const root = join(scratch, 'app')
    mkdirSync(join(root, 'data'), { recursive: true })
    const said = migrateHostData(root, log)
    expect(said.moved).toHaveLength(0)
    expect(existsSync(join(root, 'data'))).toBe(true)
    expect(existsSync(join(root, '.kehikot'))).toBe(false)
  })
})

function preRename(name: string): string {
  const root = join(scratch, name)
  for (const dir of ['epics', 'state']) {
    mkdirSync(join(root, '.kehikot', 'roadmap', dir), { recursive: true })
    writeFileSync(join(root, '.kehikot', 'roadmap', dir, 'a.json'), `{"slug":"a","title":"Before the rename","in":"${dir}"}\n`)
  }
  return root
}

describe('migrateHostData, from .kehikot/roadmap/', () => {
  test('the host folder is the one its own id names', () => {
    expect(HOST_FOLDER).toBe(moduleFolder(HOST_ID))
  })

  test('copies epics and state into .kehikot/kehikko, and leaves the originals where they are', () => {
    const root = preRename('p')
    const said = migrateHostData(root, log)
    expect(said.copied).toEqual([
      [join(root, '.kehikot', 'roadmap', 'epics'), join(root, '.kehikot', 'kehikko', 'epics')],
      [join(root, '.kehikot', 'roadmap', 'state'), join(root, '.kehikot', 'kehikko', 'state')],
    ])
    expect(epicsDir(root)).toBe(join(root, '.kehikot', 'kehikko', 'epics'))
    expect(readFileSync(join(epicsDir(root), 'a.json'), 'utf8')).toContain('Before the rename')
    expect(readFileSync(join(stateDir(root), 'a.json'), 'utf8')).toContain('state')
    expect(existsSync(join(root, '.kehikot', 'roadmap', 'epics', 'a.json'))).toBe(true)
    expect(existsSync(join(root, '.kehikot', 'roadmap', 'state', 'a.json'))).toBe(true)
  })

  test('is idempotent, and never overwrites what is already in the new place', () => {
    const root = preRename('p')
    mkdirSync(join(root, '.kehikot', 'kehikko', 'epics'), { recursive: true })
    writeFileSync(join(root, '.kehikot', 'kehikko', 'epics', 'b.json'), '{"slug":"b","title":"Already here"}\n')
    const first = migrateHostData(root, log)
    expect(first.copied.map(([, to]) => to)).toEqual([join(root, '.kehikot', 'kehikko', 'state')])
    expect(existsSync(join(epicsDir(root), 'a.json'))).toBe(false)
    expect(migrateHostData(root, log)).toEqual({ moved: [], copied: [], conflicts: [], removedData: false })
  })

  test('reads the pre-rename folder while the new one is not there', () => {
    const root = preRename('p')
    expect(epicsDir(root)).toBe(join(root, '.kehikot', 'roadmap', 'epics'))
    expect(listEpics(root).map((epic) => epic.slug)).toEqual(['a'])
  })

  test('a legacy data/ beside a pre-rename folder is a conflict, and is left alone', () => {
    const root = legacy('p', { state: false })
    preRename('p')
    const said = migrateHostData(root, log)
    expect(said.moved).toHaveLength(0)
    expect(said.conflicts).toEqual([[join(root, 'data', 'epics'), join(root, '.kehikot', 'kehikko', 'epics')]])
    expect(existsSync(join(root, 'data', 'epics', 'a.json'))).toBe(true)
  })
})

describe('the host migrates when it adopts or adds a project', () => {
  test('addProject moves legacy epics, and the project then reports them', () => {
    const db = open(':memory:')
    const root = legacy('somewhere')
    const added = addProject(db, root)
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.project.epics).toBe(true)
    expect(listEpics(root).map((epic) => epic.slug)).toEqual(['a'])
    expect(existsSync(join(root, 'data'))).toBe(false)
    db.close()
  })

  test('adopt moves legacy epics in a project the host already knew', () => {
    const db = open(':memory:')
    const root = join(scratch, 'known')
    mkdirSync(root)
    expect(addProject(db, root).ok).toBe(true)
    /* The legacy layout appears after the project was added — the case of a
       project registered before the move. */
    legacy('known')
    const settled = adopt(db, {})
    expect(settled.seeded?.epics).toBe(true)
    expect(existsSync(join(epicsDir(root), 'a.json'))).toBe(true)
    db.close()
  })
})
