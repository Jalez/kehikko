import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { open } from '../server/canvases.ts'
import { listEpics } from '../server/holdings.ts'
import { addProject, adopt } from '../server/projects.ts'
import { epicsDir, migrateLegacyEpicData, stateDir } from '../server/epicData.ts'

/**
 * A project's epics and state moved from `<project>/data/{epics,state}`, and
 * then from `<project>/.kehikot/roadmap/{epics,state}`, to
 * `<project>/.kehikot/{epics,state}`. These hold the move to the rules
 * it promises: rename when the new place is free, never overwrite, leave both
 * when both exist, and remove `data/` only when the move emptied it.
 */

let scratch: string
const lines: string[] = []
const log = (line: string) => lines.push(line)
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-roadmap-data-')))
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

describe('migrateLegacyEpicData', () => {
  function underRoadmap(name: string, { other = false } = {}): string {
    const root = join(scratch, name)
    mkdirSync(join(root, '.kehikot', 'roadmap', 'epics'), { recursive: true })
    mkdirSync(join(root, '.kehikot', 'roadmap', 'state'), { recursive: true })
    writeFileSync(join(root, '.kehikot', 'roadmap', 'epics', 'r.json'), '{"slug":"r","title":"Roadmap R"}\n')
    writeFileSync(join(root, '.kehikot', 'roadmap', 'state', 'r.json'), '{"generated":"then"}\n')
    if (other) writeFileSync(join(root, '.kehikot', 'roadmap', 'requests.db'), 'x')
    return root
  }

  test('moves .kehikot/roadmap/{epics,state} to .kehikot/ and removes the emptied roadmap folder', () => {
    const root = underRoadmap('r')
    const said = migrateLegacyEpicData(root, log)
    expect(said.moved).toHaveLength(2)
    expect(readFileSync(join(epicsDir(root), 'r.json'), 'utf8')).toContain('Roadmap R')
    expect(readFileSync(join(stateDir(root), 'r.json'), 'utf8')).toContain('then')
    expect(existsSync(join(root, '.kehikot', 'roadmap'))).toBe(false)
  })

  test('keeps .kehikot/roadmap when something else is still in it', () => {
    const root = underRoadmap('r', { other: true })
    migrateLegacyEpicData(root, log)
    expect(existsSync(join(root, '.kehikot', 'roadmap', 'requests.db'))).toBe(true)
    expect(existsSync(join(epicsDir(root), 'r.json'))).toBe(true)
  })

  test('never overwrites .kehikot/epics; the old folder stays and both are reported', () => {
    const root = underRoadmap('r')
    mkdirSync(epicsDir(root), { recursive: true })
    writeFileSync(join(epicsDir(root), 'kept.json'), '{}\n')
    const said = migrateLegacyEpicData(root, log)
    expect(said.conflicts.map(([from]) => from)).toContain(join(root, '.kehikot', 'roadmap', 'epics'))
    expect(existsSync(join(root, '.kehikot', 'roadmap', 'epics', 'r.json'))).toBe(true)
    expect(existsSync(join(epicsDir(root), 'r.json'))).toBe(false)
  })

  test('.kehikot/roadmap wins over data/ when both hold epics; data/ is left alone', () => {
    const root = underRoadmap('both')
    mkdirSync(join(root, 'data', 'epics'), { recursive: true })
    writeFileSync(join(root, 'data', 'epics', 'd.json'), '{}\n')
    migrateLegacyEpicData(root, log)
    expect(existsSync(join(epicsDir(root), 'r.json'))).toBe(true)
    expect(existsSync(join(root, 'data', 'epics', 'd.json'))).toBe(true)
  })

  test('moves data/epics and data/state to .kehikot/ and removes the emptied data/', () => {
    const root = legacy('p')
    const said = migrateLegacyEpicData(root, log)
    expect(said.moved).toHaveLength(2)
    expect(said.conflicts).toHaveLength(0)
    expect(said.removedData).toBe(true)
    expect(existsSync(join(root, 'data'))).toBe(false)
    expect(readFileSync(join(epicsDir(root), 'a.json'), 'utf8')).toContain('Legacy A')
    expect(readFileSync(join(stateDir(root), 'a.json'), 'utf8')).toContain('then')
    expect(epicsDir(root)).toBe(join(root, '.kehikot', 'epics'))
  })

  test('keeps data/ when something else is still in it', () => {
    const root = legacy('p', { other: true })
    const said = migrateLegacyEpicData(root, log)
    expect(said.moved).toHaveLength(2)
    expect(said.removedData).toBe(false)
    expect(existsSync(join(root, 'data', 'requests.db'))).toBe(true)
  })

  test('never overwrites: when both exist the legacy one is left and both paths are logged', () => {
    const root = legacy('p', { state: false })
    mkdirSync(epicsDir(root), { recursive: true })
    writeFileSync(join(epicsDir(root), 'b.json'), '{"slug":"b","title":"New B"}\n')
    const said = migrateLegacyEpicData(root, log)
    expect(said.moved).toHaveLength(0)
    expect(said.conflicts).toEqual([[join(root, 'data', 'epics'), epicsDir(root)]])
    expect(existsSync(join(root, 'data', 'epics', 'a.json'))).toBe(true)
    expect(existsSync(join(epicsDir(root), 'a.json'))).toBe(false)
    expect(lines.some((line) => line.includes(join(root, 'data', 'epics')) && line.includes(epicsDir(root)))).toBe(true)
  })

  test('moves only the one that is free when the other conflicts', () => {
    const root = legacy('p')
    mkdirSync(stateDir(root), { recursive: true })
    const said = migrateLegacyEpicData(root, log)
    expect(said.moved).toEqual([[join(root, 'data', 'epics'), epicsDir(root)]])
    expect(said.conflicts).toEqual([[join(root, 'data', 'state'), stateDir(root)]])
    expect(said.removedData).toBe(false)
  })

  test('a folder with no data/ is left untouched, and no .kehikot is made', () => {
    const root = join(scratch, 'thesis')
    mkdirSync(root)
    const said = migrateLegacyEpicData(root, log)
    expect(said).toEqual({ moved: [], conflicts: [], removedData: false })
    expect(existsSync(join(root, '.kehikot'))).toBe(false)
  })

  test('a data/ with neither epics nor state is not touched', () => {
    const root = join(scratch, 'app')
    mkdirSync(join(root, 'data'), { recursive: true })
    const said = migrateLegacyEpicData(root, log)
    expect(said.moved).toHaveLength(0)
    expect(existsSync(join(root, 'data'))).toBe(true)
    expect(existsSync(join(root, '.kehikot'))).toBe(false)
  })
})

describe('the host migrates when it adopts or adds a project', () => {
  test('addProject moves legacy epics, and the project then reports them', () => {
    const db = open(':memory:')
    const root = legacy('roadmap')
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
