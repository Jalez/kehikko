import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { open } from '../server/canvases.ts'
import { listEpics } from '../server/holdings.ts'
import { addProject, adopt } from '../server/projects.ts'
import { moduleFolder } from 'kehikot-module-protocol'

import { HOST_ID } from '../server/kehikot.ts'
import { HOST_FOLDER, LEGACY_HOST_FOLDER, epicsDir, hostPath, hostRoot, migrateHostData, stateDir } from '../server/hostData.ts'
import { moveHostFolder } from '../server/hostFolderMove.ts'

/**
 * A project's epics and state moved from `<project>/data/{epics,state}` to
 * `<project>/.kehikot/host/{epics,state}`. These hold the migration to the
 * rules it promises: move `data/` when the new place is free, never overwrite,
 * leave both when both exist, and remove `data/` only when the move emptied it.
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
  test('moves data/epics and data/state under .kehikot/host and removes the emptied data/', () => {
    const root = legacy('p')
    const said = migrateHostData(root, log)
    expect(said.moved).toHaveLength(2)
    expect(said.conflicts).toHaveLength(0)
    expect(said.removedData).toBe(true)
    expect(existsSync(join(root, 'data'))).toBe(false)
    expect(readFileSync(join(epicsDir(root), 'a.json'), 'utf8')).toContain('Legacy A')
    expect(readFileSync(join(stateDir(root), 'a.json'), 'utf8')).toContain('then')
    expect(epicsDir(root)).toBe(join(root, '.kehikot', 'host', 'epics'))
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
    expect(said).toEqual({ moved: [], conflicts: [], removedData: false })
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

describe('the host folder', () => {
  test('is .kehikot/host, the protocol’s HOST_FOLDER, and no longer the one its id names', () => {
    expect(HOST_FOLDER).toBe('host')
    expect(LEGACY_HOST_FOLDER).toBe(moduleFolder(HOST_ID))
    expect(HOST_ID).toBe('kehikko')
  })
})

/** A project laid out by a host before protocol 2.2.0: `.kehikot/kehikko/{kehikot.json,epics,trackers.json}`. */
function before(name: string): string {
  const root = join(scratch, name)
  const old = join(root, '.kehikot', 'kehikko')
  mkdirSync(join(old, 'epics'), { recursive: true })
  writeFileSync(join(old, 'epics', 'x.json'), '{"slug":"x","title":"Before X"}\n')
  writeFileSync(join(old, 'kehikot.json'), '{"version":1,"kehikot":[]}\n')
  writeFileSync(join(old, 'trackers.json'), '{"version":1}\n')
  return root
}

describe('moveHostFolder: .kehikot/kehikko becomes .kehikot/host', () => {
  test('renamed whole, once, and said', () => {
    const root = before('p')
    const said = moveHostFolder(root, log)
    expect(said).toEqual({ did: 'moved', from: join(root, '.kehikot', 'kehikko'), to: join(root, '.kehikot', 'host') })
    expect(existsSync(join(root, '.kehikot', 'kehikko'))).toBe(false)
    expect(readFileSync(join(root, '.kehikot', 'host', 'epics', 'x.json'), 'utf8')).toContain('Before X')
    expect(existsSync(join(root, '.kehikot', 'host', 'kehikot.json'))).toBe(true)
    expect(existsSync(join(root, '.kehikot', 'host', 'trackers.json'))).toBe(true)
    expect(lines.some((line) => line.includes('moved'))).toBe(true)
    lines.length = 0
    expect(moveHostFolder(root, log)).toEqual({ did: 'nothing' })
    expect(lines).toEqual([])
  })

  test('nothing to move in a project with no old folder, or none at all', () => {
    const root = join(scratch, 'fresh')
    mkdirSync(root)
    expect(moveHostFolder(root, log)).toEqual({ did: 'nothing' })
    expect(existsSync(join(root, '.kehikot'))).toBe(false)
  })

  test('with both, host/ is kept and read, kehikko/ is left untouched, and it is said once', () => {
    const root = before('both')
    mkdirSync(join(root, '.kehikot', 'host', 'epics'), { recursive: true })
    writeFileSync(join(root, '.kehikot', 'host', 'epics', 'y.json'), '{"slug":"y","title":"After Y"}\n')
    expect(moveHostFolder(root, log).did).toBe('both')
    expect(moveHostFolder(root, log).did).toBe('both')
    expect(lines.filter((line) => line.includes('both')).length).toBe(1)
    expect(existsSync(join(root, '.kehikot', 'kehikko', 'epics', 'x.json'))).toBe(true)
    expect(existsSync(join(root, '.kehikot', 'host', 'epics', 'x.json'))).toBe(false)
    expect(epicsDir(root)).toBe(join(root, '.kehikot', 'host', 'epics'))
  })

  test('a project that cannot be moved is read where it is, and nothing is made beside it', () => {
    const root = before('read-only')
    chmodSync(join(root, '.kehikot'), 0o555)
    try {
      expect(moveHostFolder(root, log).did).toBe('failed')
      expect(hostRoot(root)).toBe(join(root, '.kehikot', 'kehikko'))
      expect(epicsDir(root)).toBe(join(root, '.kehikot', 'kehikko', 'epics'))
      expect(hostPath(root, 'kehikot.json')).toBe(join(root, '.kehikot', 'kehikko', 'kehikot.json'))
      expect(existsSync(join(root, '.kehikot', 'host'))).toBe(false)
    } finally {
      chmodSync(join(root, '.kehikot'), 0o755)
    }
  })

  test('migrateHostData moves it first, so data/ lands in host/', () => {
    const root = before('both-layouts')
    mkdirSync(join(root, 'data', 'state'), { recursive: true })
    writeFileSync(join(root, 'data', 'state', 'x.json'), '{}\n')
    migrateHostData(root, log)
    expect(existsSync(join(root, '.kehikot', 'kehikko'))).toBe(false)
    expect(existsSync(join(root, '.kehikot', 'host', 'state', 'x.json'))).toBe(true)
    expect(existsSync(join(root, '.kehikot', 'host', 'epics', 'x.json'))).toBe(true)
  })

  test('a new project’s files go to host/, and kehikko/ is never made', () => {
    const root = join(scratch, 'new')
    mkdirSync(root)
    expect(hostPath(root, 'trackers.json')).toBe(join(root, '.kehikot', 'host', 'trackers.json'))
    expect(hostPath(null, 'trackers.json')).toBeNull()
    expect(() => hostPath(root, '..', 'x')).toThrow()
  })

  test('addProject moves it, and the project then reports its epics from host/', () => {
    const db = open(':memory:')
    const root = before('added')
    const added = addProject(db, root)
    expect(added.ok).toBe(true)
    expect(existsSync(join(root, '.kehikot', 'kehikko'))).toBe(false)
    expect(listEpics(root).map((epic) => epic.slug)).toContain('x')
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
