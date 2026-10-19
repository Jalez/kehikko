import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/*
 * A project folder that was deleted is never made again — by any path this
 * host takes at start or on a timer.
 *
 * The user's "Community portal" came back as `<old path>/.kehikot/host/…`
 * after its files were moved away and the folder deleted. This file drives
 * every periodic and startup writer over a deleted root, several ticks and a
 * restart, with `node:fs` instrumented: any write that lands under the root
 * is recorded with the stack that made it, so a failure names its writer.
 */

const real = { ...fs }
const writes: string[] = []
let watched: string | null = null

/** Record a write whose target is the watched root or under it, with who made it. */
function heard(kind: string, target: unknown): void {
  if (watched === null || typeof target !== 'string') return
  const at = resolve(target)
  if (at !== watched && !at.startsWith(watched + sep)) return
  if (real.existsSync(watched)) return
  const stack = (new Error().stack ?? '').split('\n').slice(3, 9).join('\n')
  writes.push(`${kind} ${at}\n${stack}`)
}

const wrap = <F extends (...args: never[]) => unknown>(kind: string, fn: F, index = 0): F =>
  ((...args: Parameters<F>) => {
    heard(kind, args[index])
    return fn(...args)
  }) as F

const instrumented = {
  ...real,
  mkdirSync: wrap('mkdirSync', real.mkdirSync),
  writeFileSync: wrap('writeFileSync', real.writeFileSync),
  appendFileSync: wrap('appendFileSync', real.appendFileSync),
  renameSync: wrap('renameSync', real.renameSync, 1),
  cpSync: wrap('cpSync', real.cpSync, 1),
  copyFileSync: wrap('copyFileSync', real.copyFileSync, 1),
}
mock.module('node:fs', () => ({ ...instrumented, default: instrumented }))
afterAll(() => {
  watched = null
})

const { open } = await import('../server/canvases.ts')
const { recordDataVersion } = await import('../server/dataVersions.ts')
const { setDisposition } = await import('../server/dispositions.ts')
const { createEpic, editParts, retitleEpic } = await import('../server/holdings.ts')
const { keep, syncEvery, syncProject } = await import('../server/kehikot.ts')
const { forgetFormerName } = await import('../server/formerName.ts')
const { migrateHostData } = await import('../server/hostData.ts')
const { isGhost, makeUnderRoot, MISSING_SAID, projectRootExists, resetMissingSaid, setMissingLog, setRecordedFolders } = await import('../server/projectRoot.ts')
const { readProjectId, setIdentityLog } = await import('../server/projectIdentity.ts')
const { addProject, adopt, followProjects, identifyAll, isProjectAnswer, knowFolders, listProjects, locateProject, projectById, shareKehikot } = await import('../server/projects.ts')
const { coreFoundation, setBookmarks } = await import('../server/bookmarks.ts')
const { editTrackers } = await import('../server/trackers/edit.ts')
const { Trackers } = await import('../server/trackers/reading.ts')
const { ContentWatch, Contents } = await import('../server/content.ts')
const { Inbox } = await import('../server/inbox.ts')

let scratch: string
let root: string
let dbFile: string

beforeEach(() => {
  scratch = real.realpathSync(real.mkdtempSync(join(tmpdir(), 'kehikko-ghost-')))
  root = join(scratch, 'portal')
  real.mkdirSync(root)
  real.writeFileSync(join(root, 'README.md'), '# portal\n')
  dbFile = join(scratch, 'frame.sqlite')
  writes.length = 0
  watched = null
  resetMissingSaid()
  setMissingLog(() => {})
  setIdentityLog(() => {})
})
afterEach(() => {
  watched = null
  setBookmarks(undefined)
  setRecordedFolders(undefined)
  setMissingLog((line) => console.warn(line))
  real.rmSync(scratch, { recursive: true, force: true })
})

/** A runner that says the project's origin is on GitHub; nothing reaches the network. */
const remotes = (async (argv: string[]) =>
  argv.join(' ').startsWith('git -C')
    ? { code: 0, out: 'origin\thttps://github.com/Jalez/portal.git (fetch)\n', err: '' }
    : { code: 1, out: '', err: 'no' }) as never
const adapter = {
  async list() {
    return { ok: true as const, rows: [], notFound: [] }
  },
  async refs() {
    return { ok: true as const, rows: [], notFound: [] }
  },
  async detail() {
    return new Map()
  },
}

/** Bookmarks that resolve to the folder's old path, as CoreFoundation does for a deleted folder. */
const pathBookmarks = {
  mint: (path: string) => new TextEncoder().encode(path),
  resolve: (mark: Uint8Array) => ({ path: new TextDecoder().decode(mark), stale: false }),
}

/** Everything the host does at start, in the order `server.ts` does it. */
function start(db: ReturnType<typeof open>): void {
  adopt(db, { KEHIKOT_SEED_PROJECT: root })
  forgetFormerName(db, { ...process.env, HOME: scratch }, () => {})
  syncEvery(db)
}

/** One round of every timer and every write a page or an agent can cause. */
async function tick(db: ReturnType<typeof open>, id: number, trackers: InstanceType<typeof Trackers>, watch: InstanceType<typeof ContentWatch>): Promise<void> {
  followProjects(db, { marks: pathBookmarks })
  followProjects(db, { thorough: true, marks: pathBookmarks })
  syncEvery(db)
  syncProject(db, { id, path: root })
  keep(db, id)
  identifyAll(db)
  migrateHostData(root, () => {})
  recordDataVersion(root, 'kehikot.notes', 4)
  setDisposition(root, { ref: '#1', value: 'done' }, 'test')
  createEpic(root, { title: 'Another epic' })
  editTrackers(root, { kind: 'remotes', on: false }, [])
  shareKehikot(db, id, true)
  await trackers.refresh(root, { project: true })
  trackers.tick(Date.now() + 3_600_000)
  trackers.stateChanged(root)
  watch.watching([root])
  new Inbox(db).importNotifications(id, root)
  listProjects(db)
  projectById(db, id)
  await new Promise((done) => setTimeout(done, 20))
}

describe('a deleted project folder', () => {
  test('is not made again by any writer, over several ticks and a restart', async () => {
    setBookmarks(pathBookmarks)
    let db = open(dbFile)
    start(db)
    const project = listProjects(db).find((one) => one.path === root)!
    expect(project).toBeTruthy()
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter } as never })
    const watch = new ContentWatch({ changed: () => {}, log: () => {} })
    new Contents()
    /* Every file the host writes, written while the folder is there. */
    await tick(db, project.id, trackers, watch)
    expect(real.existsSync(join(root, '.kehikot', 'host'))).toBe(true)
    expect(real.existsSync(join(root, '.kehikot', 'project.json'))).toBe(true)

    /* Moved away, then deleted, as the person did. */
    real.renameSync(root, join(scratch, 'kollekti'))
    watched = root

    for (let i = 0; i < 3; i++) {
      await tick(db, project.id, trackers, watch)
      expect(writes).toEqual([])
      expect(real.existsSync(root)).toBe(false)
    }

    /* A restart: a fresh database handle, a fresh start over the same file. */
    watch.close()
    db.close()
    resetMissingSaid()
    db = open(dbFile)
    start(db)
    const again = new Trackers({ run: remotes, adapters: { github: adapter } as never })
    const watch2 = new ContentWatch({ changed: () => {}, log: () => {} })
    for (let i = 0; i < 2; i++) await tick(db, project.id, again, watch2)
    watch2.close()
    db.close()
    expect(writes).toEqual([])
    expect(real.existsSync(root)).toBe(false)
  })
})


/* ---- a ghost: the folder an older host made again at the old path ---- */

const MAC = process.platform === 'darwin'

/** What an older host (0.1.24) did at a deleted root: `mkdir -p` its folder, and a `.gitignore` in it. */
function ghostAt(path: string): void {
  real.mkdirSync(join(path, '.kehikot', 'kehikko'), { recursive: true })
  real.writeFileSync(join(path, '.kehikot', 'kehikko', '.gitignore'), 'tracker-reading.json\n')
}

/** Every file under a folder with its size and time, to see that nothing touched it. */
function snapshot(path: string): string[] {
  const out: string[] = []
  for (const name of real.readdirSync(path, { recursive: true }) as string[]) {
    const at = real.statSync(join(path, name))
    out.push(`${name} ${at.isDirectory() ? 'dir' : at.size} ${at.mtimeMs}`)
  }
  return out.sort()
}

/** The person's story: a project, its files moved into a sibling, the folder deleted, then a ghost made where it was. */
function story(db: ReturnType<typeof open>, { carryId }: { carryId: boolean }): { id: number; uid: string; kollekti: string } {
  const added = addProject(db, root)
  if (!added.ok) throw new Error(added.why)
  const uid = added.project.uid!
  const kollekti = join(scratch, 'kollekti')
  real.mkdirSync(kollekti)
  for (const name of real.readdirSync(root)) {
    if (name === '.kehikot' && !carryId) continue
    real.renameSync(join(root, name), join(kollekti, name))
  }
  real.rmSync(root, { recursive: true, force: true })
  ghostAt(root)
  return { id: added.project.id, uid, kollekti }
}

describe('a ghost at a project\'s path', () => {
  test('is missing — listed, asked, and for every writer — and nothing is written into it', async () => {
    let db = open(dbFile)
    knowFolders(db)
    const { id } = story(db, { carryId: false })
    const before = snapshot(root)
    expect(isGhost(root)).toBe(true)
    expect(projectRootExists(root)).toBe(false)
    expect(projectById(db, id)?.missing).toBe(true)
    expect(isProjectAnswer(db, root)).toEqual({ ok: true, project: false, missing: true, why: MISSING_SAID })

    setBookmarks(pathBookmarks)
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter } as never })
    const watch = new ContentWatch({ changed: () => {}, log: () => {} })
    for (let i = 0; i < 2; i++) await tick(db, id, trackers, watch)
    watch.close()
    db.close()
    db = open(dbFile)
    knowFolders(db)
    start(db)
    expect(projectById(db, id)?.missing).toBe(true)
    db.close()
    expect(snapshot(root)).toEqual(before)
    expect(real.existsSync(join(root, '.kehikot', 'host'))).toBe(false)
  })

  test.skipIf(!MAC)('a row from before folders were recorded: the ghost is told by being born with its .kehikot', () => {
    const db = open(dbFile)
    knowFolders(db)
    const { id } = story(db, { carryId: false })
    db.query('update projects set folder = null').run()
    expect(projectById(db, id)?.missing).toBe(true)
    /* A folder of the person's own, made well before its .kehikot, holding only that, is the project. */
    const own = join(scratch, 'own')
    real.mkdirSync(own)
    const old = new Date(Date.now() - 60_000)
    real.utimesSync(own, old, old) // APFS moves the birth time back with an earlier mtime
    real.mkdirSync(join(own, '.kehikot', 'journeys'), { recursive: true })
    db.query("insert into projects (name, path, rank) values ('own', ?, 9)").run(own)
    const row = listProjects(db).find((one) => one.path === own)!
    expect(row.missing).toBe(false)
    identifyAll(db)
    expect(db.query<{ folder: string | null }, [string]>('select folder from projects where path = ?').get(own)?.folder).toBeTruthy()
    db.close()
  })

  test.skipIf(!MAC)('a folder the person made and added that holds only .kehikot is the project, not a ghost', () => {
    const db = open(dbFile)
    knowFolders(db)
    const empty = join(scratch, 'planning')
    real.mkdirSync(empty)
    const added = addProject(db, empty)
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(real.readdirSync(empty)).toEqual(['.kehikot'])
    expect(projectById(db, added.project.id)?.missing).toBe(false)
    expect(isGhost(empty)).toBe(false)
    db.close()
  })

  test.skipIf(!MAC)('a bookmark that leads to the ghost is not followed; the folder beside it with the id is, at start', () => {
    const marks = coreFoundation()!
    setBookmarks(marks)
    const db = open(dbFile)
    knowFolders(db)
    const { id, uid, kollekti } = story(db, { carryId: true })
    const before = snapshot(root)
    /* CoreFoundation resolves the bookmark of a deleted folder to one re-made at its path. */
    expect(followProjects(db, { marks })).toEqual([])
    expect(projectById(db, id)?.missing).toBe(true)
    const followed = followProjects(db, { thorough: true, marks })
    expect(followed).toEqual([{ id, from: root, to: kollekti }])
    expect(projectById(db, id)).toMatchObject({ path: kollekti, missing: false, uid })
    expect(snapshot(root)).toEqual(before)
    db.close()
  })

  test('a ghost carrying the id is never followed into, even when a bookmark leads there', () => {
    const db = open(dbFile)
    knowFolders(db)
    const added = addProject(db, root)
    if (!added.ok) throw new Error(added.why)
    /* The project is renamed away and its files deleted; a host makes a ghost at the new name with the id. */
    const elsewhere = join(scratch, 'renamed')
    real.renameSync(root, elsewhere)
    real.rmSync(elsewhere, { recursive: true })
    ghostAt(elsewhere)
    real.writeFileSync(join(elsewhere, '.kehikot', 'project.json'), JSON.stringify({ id: added.project.uid, createdAt: new Date().toISOString() }))
    const marks = { mint: () => new Uint8Array([1]), resolve: () => ({ path: elsewhere, stale: false }) }
    expect(followProjects(db, { thorough: true, marks })).toEqual([])
    expect(projectById(db, added.project.id)?.path).toBe(root)
    db.close()
  })

  test('Locate… a folder with no id while the project\'s path holds a ghost: offered on the person\'s word, then relinked', () => {
    const db = open(dbFile)
    knowFolders(db)
    const { id, uid, kollekti } = story(db, { carryId: false })
    const before = snapshot(root)
    const asked = locateProject(db, id, kollekti)
    expect(asked.ok).toBe(false)
    expect(!asked.ok && asked.anyway).toBe(true)
    const done = locateProject(db, id, kollekti, true)
    expect(done.ok).toBe(true)
    expect(projectById(db, id)).toMatchObject({ path: kollekti, missing: false, uid })
    expect(readProjectId(kollekti)).toBe(uid)
    expect(snapshot(root)).toEqual(before)
    db.close()
  })

  test('an epic a host left in the ghost is neither retitled nor given parts', () => {
    const db = open(dbFile)
    knowFolders(db)
    story(db, { carryId: false })
    real.mkdirSync(join(root, '.kehikot', 'kehikko', 'epics'))
    real.writeFileSync(join(root, '.kehikot', 'kehikko', 'epics', 'left.json'), '{\n  "title": "Left"\n}\n')
    const before = snapshot(root)
    expect(retitleEpic(root, 'left', 'Renamed').ok).toBe(false)
    expect(editParts(root, 'left', { add: { name: 'One' } }).written).toBe(false)
    expect(snapshot(root)).toEqual(before)
    db.close()
  })

  test('Locate… still refuses a folder that is another project here', () => {
    const db = open(dbFile)
    knowFolders(db)
    const { id } = story(db, { carryId: false })
    const other = join(scratch, 'other')
    real.mkdirSync(other)
    real.writeFileSync(join(other, 'x.txt'), 'x')
    expect(addProject(db, other).ok).toBe(true)
    const asked = locateProject(db, id, other, true)
    expect(asked.ok).toBe(false)
    db.close()
  })

  test('adding the folder that carries the id relinks the project instead of making a copy', () => {
    const db = open(dbFile)
    knowFolders(db)
    const { id, uid, kollekti } = story(db, { carryId: true })
    real.writeFileSync(join(root, '.kehikot', 'project.json'), JSON.stringify({ id: uid, createdAt: new Date().toISOString() }))
    const added = addProject(db, kollekti)
    expect(added.ok && added.relinked).toBe(true)
    expect(projectById(db, id)).toMatchObject({ path: kollekti, uid })
    expect(readProjectId(kollekti)).toBe(uid)
    expect(listProjects(db)).toHaveLength(1)
    db.close()
  })
})

describe('makeUnderRoot', () => {
  test('a root deleted between the check and the write is not made again', () => {
    real.mkdirSync(join(root, 'keep'))
    setRecordedFolders((asked) => {
      /* Consulted inside the check, after the folder was seen: the person deletes it now. */
      if (asked === root && real.existsSync(root)) real.rmSync(root, { recursive: true })
      return undefined
    })
    expect(makeUnderRoot(root, join(root, '.kehikot', 'host'))).toBe(false)
    expect(real.existsSync(root)).toBe(false)
  })

  test('refuses a folder outside the root', () => {
    expect(() => makeUnderRoot(root, join(scratch, 'elsewhere'))).toThrow()
  })
})
