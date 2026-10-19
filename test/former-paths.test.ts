import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ID } from 'kehikot-module-protocol'
import { isProjectResult } from 'kehikot-module-protocol/serve'

import { open } from '../server/canvases.ts'
import { setIdentityLog } from '../server/projectIdentity.ts'
import { addProject, forgetProject, formerProjectAt, isProjectAnswer, projectById, relinkProject } from '../server/projects.ts'

/*
 * `/host/is-project` for a path a project HAD (protocol 2.3.0): a module's door
 * handed the old path after a rename is told where the project is now, and its
 * id, so it can follow once. Every folder is a scratch directory.
 */

let root: string
let db: Database

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-former-')))
  db = open(':memory:')
  setIdentityLog(() => {})
})
afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

function folder(name: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A project added at `from`, its folder renamed to `to`, and relinked there. */
function moved(from: string, to: string): { id: number; uid: string } {
  const added = addProject(db, folder(from))
  if (!added.ok) throw new Error(added.why)
  renameSync(join(root, from), join(root, to))
  const relinked = relinkProject(db, added.project.id, join(root, to))
  if (!relinked.ok) throw new Error(relinked.why)
  const uid = projectById(db, added.project.id)?.uid
  if (!uid) throw new Error('no id')
  return { id: added.project.id, uid }
}

describe('a project is answered with its id', () => {
  test('project: true and the id, as the protocol reads it', () => {
    const added = addProject(db, folder('here'))
    if (!added.ok) throw new Error(added.why)
    const said = isProjectAnswer(db, join(root, 'here'))
    expect(said).toEqual({ ok: true, project: true, id: projectById(db, added.project.id)!.uid! })
    expect(PROJECT_ID.test((said as { id: string }).id)).toBe(true)
    expect(isProjectResult.parse(said)).toEqual(said)
  })
})

describe('a former path', () => {
  test('says where the project moved, and its id', () => {
    const { uid } = moved('before', 'after')
    const said = isProjectAnswer(db, join(root, 'before'))
    expect(said).toEqual({ ok: true, project: false, movedTo: join(root, 'after'), id: uid })
    expect(isProjectResult.parse(said)).toEqual(said)
    /* Any spelling of it: a trailing slash, a dot-dot. */
    expect(isProjectAnswer(db, `${join(root, 'before')}/`)).toMatchObject({ movedTo: join(root, 'after') })
    expect(isProjectAnswer(db, join(root, 'after', '..', 'before'))).toMatchObject({ movedTo: join(root, 'after') })
    /* And the new path is the project, with the same id. */
    expect(isProjectAnswer(db, join(root, 'after'))).toEqual({ ok: true, project: true, id: uid })
  })

  test('a plain folder made again at the old path is not a project, so the move is still said', () => {
    const { uid } = moved('before', 'after')
    folder('before')
    expect(isProjectAnswer(db, join(root, 'before'))).toEqual({ ok: true, project: false, movedTo: join(root, 'after'), id: uid })
  })

  test('another project now at the old path wins: no movedTo', () => {
    moved('before', 'after')
    const again = addProject(db, folder('before'))
    if (!again.ok) throw new Error(again.why)
    const said = isProjectAnswer(db, join(root, 'before'))
    expect(said).toEqual({ ok: true, project: true, id: projectById(db, again.project.id)!.uid! })
    expect(said).not.toHaveProperty('movedTo')
  })

  test('the newest move wins', () => {
    moved('shared', 'first')
    const second = addProject(db, folder('shared'))
    if (!second.ok) throw new Error(second.why)
    renameSync(join(root, 'shared'), join(root, 'second'))
    relinkProject(db, second.project.id, join(root, 'second'))
    expect(isProjectAnswer(db, join(root, 'shared'))).toMatchObject({ movedTo: join(root, 'second'), id: projectById(db, second.project.id)!.uid! })
  })

  test('a forgotten project is not followed, and an unrelated folder is a bare no', () => {
    const { id } = moved('before', 'after')
    forgetProject(db, id)
    expect(formerProjectAt(db, join(root, 'before'))).toBeNull()
    expect(isProjectAnswer(db, join(root, 'before'))).toEqual({ ok: true, project: false })
    expect(isProjectAnswer(db, folder('stranger'))).toEqual({ ok: true, project: false })
    expect(isProjectAnswer(db, 'relative')).toEqual({ ok: true, project: false })
    expect(isProjectAnswer(db, null)).toEqual({ ok: true, project: false })
  })
})
