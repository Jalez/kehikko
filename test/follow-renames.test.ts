import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectFile } from 'kehikot-module-protocol'

import { coreFoundation, setBookmarks, type Bookmarks } from '../server/bookmarks.ts'
import { open } from '../server/canvases.ts'
import { readProjectId, setIdentityLog } from '../server/projectIdentity.ts'
import { addProject, adopt, followedSaid, followProjects, formerPaths, keepBookmark, projectById } from '../server/projects.ts'
import { followedSaid as followedSentence } from '../src/host/projects.ts'

/*
 * A project folder renamed or moved is followed by its macOS bookmark
 * (`server/bookmarks.ts`, `followProjects`). The real CoreFoundation is used
 * where there is one (macOS); everything else runs against a fake. Every
 * folder is a scratch directory.
 */

const MAC = platform() === 'darwin'
const real = MAC ? coreFoundation() : null

let root: string
let db: Database
let lines: string[]

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-follow-')))
  db = open(':memory:')
  lines = []
  setIdentityLog((line) => lines.push(line))
})
afterEach(() => {
  setBookmarks(undefined)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

function folder(name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}

function added(path: string) {
  const got = addProject(db, path)
  if (!got.ok) throw new Error(got.why)
  return got.project
}

function bookmarkOf(id: number): Uint8Array | null {
  return db.query<{ bookmark: Uint8Array | null }, [number]>('select bookmark from projects where id = ?').get(id)?.bookmark ?? null
}

/** Bookmarks that resolve wherever a test says, and count what was minted. */
function fake(where: (bookmark: Uint8Array) => { path: string; stale: boolean } | null): Bookmarks & { minted: string[] } {
  const minted: string[] = []
  return {
    minted,
    mint(path) {
      minted.push(path)
      return new TextEncoder().encode(`${path}#${minted.length}`)
    },
    resolve: where,
  }
}

describe.skipIf(!MAC)("CoreFoundation's bookmarks", () => {
  test('a bookmark to a scratch folder resolves to it, and after a rename and a move to where it went', () => {
    expect(real).not.toBeNull()
    const marks = real!
    const at = folder('a b ä')
    const minted = marks.mint(at)
    expect(minted?.length).toBeGreaterThan(0)
    /* CoreFoundation spells a name decomposed (NFD); the filesystem resolves it to the name on disk. */
    expect(realpathSync(marks.resolve(minted!)!.path)).toBe(at)

    renameSync(at, join(root, 'renamed'))
    const renamed = marks.resolve(minted!)
    expect(renamed?.path).toBe(join(root, 'renamed'))
    expect(renamed?.stale).toBe(true)

    folder('deeper')
    renameSync(join(root, 'renamed'), join(root, 'deeper', 'moved'))
    expect(marks.resolve(minted!)?.path).toBe(join(root, 'deeper', 'moved'))
  })

  test('a bookmark to a deleted folder resolves to nothing', () => {
    const at = folder('gone')
    const minted = real!.mint(at)!
    rmSync(at, { recursive: true })
    expect(real!.resolve(minted)).toBeNull()
  })

  test('garbage is not a bookmark', () => {
    expect(real!.resolve(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  test('a renamed project is followed on start: same row, same id, its old path kept, nothing made at the old path', () => {
    setBookmarks(real)
    const at = folder('thesis')
    const project = added(at)
    expect(bookmarkOf(project.id)).not.toBeNull()
    const before = bookmarkOf(project.id)

    const to = join(root, 'thesis-2026')
    renameSync(at, to)
    adopt(db, {})

    const after = projectById(db, project.id)!
    expect(after.path).toBe(to)
    expect(after.uid).toBe(project.uid)
    expect(after.missing).toBe(false)
    expect(after.followed).toBe(at)
    expect(formerPaths(db, project.id).map((one) => one.path)).toEqual([at])
    expect(existsSync(at)).toBe(false)
    expect(readdirSync(root)).toEqual(['thesis-2026'])
    /* Minted again for where it is now. */
    expect(bookmarkOf(project.id)).not.toEqual(before)
    expect(lines.some((line) => line.includes(`was moved to ${to}`))).toBe(true)
  })

  test('a folder moved while the host runs is followed by the next check', () => {
    setBookmarks(real)
    const at = folder('notes')
    const project = added(at)
    folder('archive')
    const to = join(root, 'archive', 'notes')
    renameSync(at, to)
    expect(projectById(db, project.id)!.missing).toBe(true)

    expect(followProjects(db)).toEqual([{ id: project.id, from: at, to }])
    expect(projectById(db, project.id)!.path).toBe(to)
    /* And once is enough. */
    expect(followProjects(db)).toEqual([])
  })

  test('a folder that now carries another id is not followed, and nothing is written into it', () => {
    setBookmarks(real)
    const at = folder('app')
    const project = added(at)
    const to = join(root, 'app-renamed')
    renameSync(at, to)
    const stranger = '00000000-0000-4000-8000-000000000000'
    writeFileSync(projectFile(to)!, JSON.stringify({ id: stranger, createdAt: new Date().toISOString() }))

    expect(followProjects(db, { thorough: true })).toEqual([])
    const after = projectById(db, project.id)!
    expect(after.path).toBe(at)
    expect(after.missing).toBe(true)
    expect(readProjectId(to)).toBe(stranger)
    expect(existsSync(at)).toBe(false)
  })

  test('moved away and something else put where it was: not followed (a bookmark tries the path first), the newcomer kept', () => {
    setBookmarks(real)
    const at = folder('site')
    const project = added(at)
    const to = join(root, 'site-old')
    renameSync(at, to)
    folder('site')
    writeFileSync(join(at, 'index.html'), '<p>new</p>')

    expect(followProjects(db, { thorough: true })).toEqual([])
    expect(projectById(db, project.id)!.path).toBe(at)
    expect(readdirSync(at)).toEqual(['index.html'])
  })

  test('a folder put in the Trash is not followed there', () => {
    setBookmarks(real)
    const at = folder('draft')
    const project = added(at)
    folder('.Trash')
    renameSync(at, join(root, '.Trash', 'draft'))
    expect(followProjects(db)).toEqual([])
    expect(projectById(db, project.id)!.missing).toBe(true)
  })
})

describe('following, whatever the machine', () => {
  test('no bookmarks (off macOS, or no CoreFoundation): nothing minted, nothing followed', () => {
    setBookmarks(null)
    const at = folder('plain')
    const project = added(at)
    expect(bookmarkOf(project.id)).toBeNull()
    renameSync(at, join(root, 'plain-2'))
    expect(followProjects(db, { thorough: true })).toEqual([])
    adopt(db, {})
    expect(projectById(db, project.id)!.missing).toBe(true)
  })

  test('a bookmark that resolves stale is minted again, where the project is', () => {
    let stale = false
    const marks = fake(() => ({ path: at, stale }))
    setBookmarks(marks)
    const at = folder('kept')
    const project = added(at)
    expect(marks.minted).toEqual([at])

    followProjects(db, { thorough: true })
    expect(marks.minted).toEqual([at])
    stale = true
    followProjects(db, { thorough: true })
    expect(marks.minted).toEqual([at, at])
    expect(new TextDecoder().decode(bookmarkOf(project.id)!)).toBe(`${at}#2`)
  })

  test('a bookmark resolving to a folder with no id is not followed', () => {
    const at = folder('one')
    const elsewhere = folder('elsewhere')
    setBookmarks(fake(() => ({ path: elsewhere, stale: true })))
    const project = added(at)
    rmSync(at, { recursive: true })
    expect(followProjects(db)).toEqual([])
    expect(projectById(db, project.id)!.missing).toBe(true)
    expect(existsSync(join(elsewhere, '.kehikot'))).toBe(false)
  })

  test("a bookmark resolving to another project's folder is not followed", () => {
    const at = folder('first')
    const other = folder('second')
    const marks = fake(() => ({ path: other, stale: true }))
    setBookmarks(marks)
    const project = added(at)
    added(other)
    rmSync(at, { recursive: true })
    expect(followProjects(db)).toEqual([])
    expect(projectById(db, project.id)!.path).toBe(at)
  })

  test('keepBookmark does not bookmark a folder that carries another id', () => {
    const marks = fake(() => null)
    const at = folder('mine')
    setBookmarks(null)
    const project = added(at)
    writeFileSync(projectFile(at)!, JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', createdAt: new Date().toISOString() }))
    keepBookmark(db, project.id, marks)
    expect(marks.minted).toEqual([])
  })

  test('followed is said once: cleared when the page has told the person', () => {
    const at = folder('said')
    const to = join(root, 'said-2')
    setBookmarks(fake(() => ({ path: to, stale: true })))
    const project = added(at)
    renameSync(at, to)
    followProjects(db)
    const after = projectById(db, project.id)!
    expect(followedSentence(after)).toBe(`said-2 was moved to ${to}. Kehikot followed it.`)
    expect(followedSaid(db, project.id)).toBe(true)
    expect(projectById(db, project.id)!.followed).toBeNull()
    expect(followedSaid(db, project.id)).toBe(false)
  })
})
