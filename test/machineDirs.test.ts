import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  frameDbFile,
  legacyModulesDir,
  machineDir,
  migrateMachineData,
  modulesDir,
} from '../server/machineDirs.ts'
import { readRegistrations } from '../server/registrations.ts'

const made: string[] = []
function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'kehikot-machine-'))
  made.push(home)
  return home
}
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** Every file under a directory with its size and mtime, to prove nothing changed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel ? `${rel}/${name}` : name
      const stat = statSync(join(dir, path))
      if (stat.isDirectory()) walk(path)
      /* The -shm file is shared memory a concurrent reader is entitled to use. */ else if (!name.endsWith('-shm'))
        out[path] = `${stat.size}:${stat.mtimeMs}:${readFileSync(join(dir, path)).toString('base64')}`
    }
  }
  walk('')
  return out
}

/** A legacy ~/.roadmap with a WAL-mode database another "host" still has open. */
function legacy(home: string): { db: Database; modules: string } {
  const dir = join(home, '.roadmap')
  const modules = join(dir, 'modules')
  mkdirSync(modules, { recursive: true })
  writeFileSync(join(modules, 'roadmap.notes.json'), JSON.stringify({ url: 'http://127.0.0.1:7001' }))
  writeFileSync(join(modules, 'roadmap.paper.json'), JSON.stringify({ url: 'http://127.0.0.1:7002' }))
  const db = new Database(join(dir, 'frame.sqlite'), { create: true })
  db.exec('pragma journal_mode = wal')
  db.exec('pragma wal_autocheckpoint = 0')
  db.exec('create table canvases (id integer primary key, name text)')
  db.query('insert into canvases (name) values (?)').run('first')
  /* Left in the WAL, not checkpointed: a file copy of frame.sqlite alone would miss it. */
  db.query('insert into canvases (name) values (?)').run('only in the wal')
  return { db, modules }
}

describe('where machine state lives', () => {
  test('Application Support on macOS, XDG elsewhere, overridable by KEHIKOT_* and the old ROADMAP_*', () => {
    expect(machineDir({ HOME: '/Users/x' }, 'darwin')).toBe('/Users/x/Library/Application Support/Kehikot')
    expect(machineDir({ HOME: '/home/x' }, 'linux')).toBe('/home/x/.local/share/kehikot')
    expect(machineDir({ HOME: '/home/x', XDG_DATA_HOME: '/data' }, 'linux')).toBe('/data/kehikot')
    expect(frameDbFile({ KEHIKOT_FRAME_DB: '/a', ROADMAP_FRAME_DB: '/b' })).toBe('/a')
    expect(frameDbFile({ ROADMAP_FRAME_DB: '/b' })).toBe('/b')
    expect(modulesDir({ KEHIKOT_MODULES_DIR: '/m', ROADMAP_MODULES_DIR: '/n' })).toBe('/m')
    expect(modulesDir({ ROADMAP_MODULES_DIR: '/n' })).toBe('/n')
    /* An overridden registry never falls back to a person's real one. */
    expect(legacyModulesDir({ HOME: '/Users/x', KEHIKOT_MODULES_DIR: '/m' })).toBeNull()
    expect(legacyModulesDir({ HOME: '/Users/x' })).toBe('/Users/x/.roadmap/modules')
  })
})

describe('migrating from ~/.roadmap', () => {
  test('old only: the database is snapshotted (WAL included) and registrations copied; the old dir is untouched', () => {
    const home = scratchHome()
    const env = { HOME: home }
    const { db } = legacy(home)
    const before = snapshot(join(home, '.roadmap'))

    const done = migrateMachineData(env)
    expect(done.frameDb?.to).toBe(frameDbFile(env))
    expect(done.modules).toEqual(['roadmap.notes.json', 'roadmap.paper.json'])

    const copied = new Database(frameDbFile(env), { readonly: true })
    expect(copied.query<{ name: string }, []>('select name from canvases order by id').all().map((r) => r.name)).toEqual([
      'first',
      'only in the wal',
    ])
    copied.close()
    expect(readdirSync(modulesDir(env)).sort()).toEqual(['roadmap.notes.json', 'roadmap.paper.json'])
    /* Copies keep their times, so a later rewrite of the old file is "newer". */
    expect(Math.floor(statSync(join(modulesDir(env), 'roadmap.notes.json')).mtimeMs)).toBe(
      Math.floor(statSync(join(home, '.roadmap', 'modules', 'roadmap.notes.json')).mtimeMs),
    )
    /* No temp files left behind. */
    expect(readdirSync(machineDir(env)).filter((name) => name.includes('migrating'))).toEqual([])

    /* The other host can still write its database. */
    db.query('insert into canvases (name) values (?)').run('after')
    db.close()
    const after = snapshot(join(home, '.roadmap'))
    for (const [file, was] of Object.entries(before)) {
      if (file.startsWith('frame.sqlite')) continue // the other host's own write above
      expect(after[file]).toBe(was)
    }
  })

  test('the old directory is never written by the migration', () => {
    const home = scratchHome()
    const { db } = legacy(home)
    db.exec('pragma wal_checkpoint(truncate)')
    db.close()
    const before = snapshot(join(home, '.roadmap'))
    migrateMachineData({ HOME: home })
    expect(snapshot(join(home, '.roadmap'))).toEqual(before)
  })

  test('both present: the new one is used and nothing is copied', () => {
    const home = scratchHome()
    const env = { HOME: home }
    legacy(home).db.close()
    mkdirSync(modulesDir(env), { recursive: true })
    const fresh = new Database(frameDbFile(env), { create: true })
    fresh.exec('create table mine (x)')
    fresh.close()

    const done = migrateMachineData(env)
    expect(done).toEqual({ frameDb: null, modules: [] })
    const kept = new Database(frameDbFile(env), { readonly: true })
    expect(kept.query('select name from sqlite_master where name = ?').get('mine')).not.toBeNull()
    kept.close()
    expect(readdirSync(modulesDir(env))).toEqual([])
  })

  test('neither present: nothing is made, and the host starts fresh', () => {
    const home = scratchHome()
    expect(migrateMachineData({ HOME: home })).toEqual({ frameDb: null, modules: [] })
    expect(existsSync(machineDir({ HOME: home }))).toBe(false)
  })

  test('an overridden database or registry is never migrated into', () => {
    const home = scratchHome()
    legacy(home).db.close()
    const elsewhere = join(home, 'elsewhere.sqlite')
    const env = { HOME: home, KEHIKOT_FRAME_DB: elsewhere, KEHIKOT_MODULES_DIR: join(home, 'm') }
    expect(migrateMachineData(env)).toEqual({ frameDb: null, modules: [] })
    expect(existsSync(elsewhere)).toBe(false)
    expect(existsSync(join(home, 'm'))).toBe(false)
  })
})

describe('the registry falls back to ~/.roadmap/modules', () => {
  const saved = { HOME: process.env.HOME, K: process.env.KEHIKOT_MODULES_DIR, R: process.env.ROADMAP_MODULES_DIR }
  afterEach(() => {
    process.env.HOME = saved.HOME
    if (saved.K === undefined) delete process.env.KEHIKOT_MODULES_DIR
    else process.env.KEHIKOT_MODULES_DIR = saved.K
    if (saved.R === undefined) delete process.env.ROADMAP_MODULES_DIR
    else process.env.ROADMAP_MODULES_DIR = saved.R
  })

  test('modules still registering in the old place are found; on a clash the newer file wins', async () => {
    const home = scratchHome()
    process.env.HOME = home
    delete process.env.KEHIKOT_MODULES_DIR
    delete process.env.ROADMAP_MODULES_DIR
    const old = join(home, '.roadmap', 'modules')
    const now = modulesDir({ HOME: home })
    mkdirSync(old, { recursive: true })
    mkdirSync(now, { recursive: true })

    writeFileSync(join(old, 'roadmap.notes.json'), JSON.stringify({ url: 'http://127.0.0.1:7001' }))
    /* Both have paper; the old one was rewritten more recently (a module that
       restarted on another port and still registers the old way). */
    writeFileSync(join(now, 'roadmap.paper.json'), JSON.stringify({ url: 'http://127.0.0.1:7002' }))
    writeFileSync(join(old, 'roadmap.paper.json'), JSON.stringify({ url: 'http://127.0.0.1:7012' }))
    utimesSync(join(now, 'roadmap.paper.json'), 1000, 1000)
    utimesSync(join(old, 'roadmap.paper.json'), 2000, 2000)
    /* Both have slides at the same time: the new directory wins the tie. */
    writeFileSync(join(now, 'roadmap.slides.json'), JSON.stringify({ url: 'http://127.0.0.1:7003' }))
    writeFileSync(join(old, 'roadmap.slides.json'), JSON.stringify({ url: 'http://127.0.0.1:7013' }))
    utimesSync(join(now, 'roadmap.slides.json'), 3000, 3000)
    utimesSync(join(old, 'roadmap.slides.json'), 3000, 3000)

    const swept = await readRegistrations()
    expect(swept.dir).toBe(now)
    expect(Object.fromEntries(swept.registrations.map((r) => [r.id, r.url]))).toEqual({
      'roadmap.notes': 'http://127.0.0.1:7001',
      'roadmap.paper': 'http://127.0.0.1:7012',
      'roadmap.slides': 'http://127.0.0.1:7003',
    })

    /* Given a directory, only that directory is read. */
    expect((await readRegistrations(now)).registrations.map((r) => r.id)).toEqual(['roadmap.paper', 'roadmap.slides'])

    /* An overridden registry does not fall back. */
    process.env.KEHIKOT_MODULES_DIR = now
    expect((await readRegistrations()).registrations.map((r) => r.id)).toEqual(['roadmap.paper', 'roadmap.slides'])
  })
})
