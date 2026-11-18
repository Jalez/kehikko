import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { developmentDesk, folderRefused, lookForCheckouts, pointRegistrationAt, readDevelopment, restoreRegistration, type Moved } from '../server/development.ts'
import type { Official } from '../server/official.ts'
import { drifted, pathSaid, runsSaid, showsRuns, startedOnSaid, summaryLines, summarySaid, SUMMARY_LINE_MAX } from '../src/host/development.ts'
import { noticeEntry } from '../src/host/inbox.ts'

const entry = (name: string, port: number): Official =>
  ({ id: `kehikot.${name}`, name: name[0]!.toUpperCase() + name.slice(1), repo: `Jalez/kehikko-${name}`, port, summary: `${name}.`, tags: [] }) as Official

const NOTES = entry('notes', 7820)
const PAPER = entry('paper', 7830)

/** A checkout of `repo` as `git clone` leaves one: a git config naming it, a package.json, a run.sh, and somebody's work. */
function checkout(dir: string, repo: string): string {
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:${repo}.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: repo.split('/')[1], version: '0.0.0-dev' }))
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\n')
  writeFileSync(join(dir, 'unsaved-work.ts'), 'export const draft = 1\n')
  return dir
}

/** Every file under a folder with its bytes and mode, to prove nothing in it changed. */
function fingerprint(dir: string): string {
  const hash = createHash('sha256')
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      const info = statSync(path)
      hash.update(`${relative(dir, path)}:${info.mode}:${info.mtimeMs}\n`)
      if (info.isDirectory()) walk(path)
      else hash.update(readFileSync(path))
    }
  }
  walk(dir)
  return hash.digest('hex')
}

/** A machine: a scratch root, a frame database, registrations held in memory, and fakes for the install and the move. */
function machine(registered: Record<string, string>, options: { list?: Official[]; copyFails?: string; moveFails?: (id: string, dir: string) => boolean; keeps?: string[]; running?: string[] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-development-')))
  const installsRoot = join(root, 'installed')
  mkdirSync(installsRoot, { recursive: true })
  const db = new Database(':memory:')
  const registrations = new Map(Object.entries(registered))
  const told: string[] = []
  const copied: string[] = []
  const moved: { id: string; dir: string; now?: boolean }[] = []
  const desk = developmentDesk({
    db,
    official: () => options.list ?? [NOTES, PAPER],
    installsRoot,
    registrations: async () => [...registrations].map(([id, dir]) => ({ id, dir, keep: options.keeps?.includes(id) === true })),
    copy: async (one) => {
      copied.push(one.id)
      if (options.copyFails === one.id) return { ok: false, why: 'the network is down' }
      mkdirSync(join(installsRoot, one.id), { recursive: true })
      return { ok: true }
    },
    point: async (id, dir) => {
      registrations.set(id, dir)
      return { ok: true }
    },
    move: async (id, dir, how): Promise<Moved> => {
      /* A module set to keep running that runs is not stopped for this, unless a person pressed "Move now". */
      if (options.keeps?.includes(id) && options.running?.includes(id) && !how?.now) return { ok: false, why: `${id} keeps running.`, restored: false, later: true }
      moved.push({ id, dir, ...(how?.now ? { now: true } : {}) })
      if (options.moveFails?.(id, dir)) return { ok: false, why: `${id} did not start from ${dir}, so it was put back.`, restored: true }
      registrations.set(id, dir)
      return { ok: true }
    },
    tell: (line) => told.push(line),
    home: root,
  })
  return { root, installsRoot, db, registrations, told, copied, moved, desk }
}

describe('Kehikko development: where official modules run from', () => {
  test('a machine with official modules registered from folders starts with development on, told once, and nothing moves', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-dev-folders-')))
    const notes = checkout(join(root, 'kehikko-notes'), NOTES.repo)
    const m = machine({ [NOTES.id]: notes })
    await m.desk.boot()
    const state = await m.desk.state()
    expect(state.on).toBe(true)
    expect(m.told).toEqual([startedOnSaid(1)])
    const row = state.modules.find((one) => one.id === NOTES.id)!
    expect(row).toMatchObject({ folder: notes, wants: 'folder', runs: { from: 'folder', dir: notes } })
    expect(m.moved).toEqual([])
    /* A second start reads what was kept: no second line. */
    await m.desk.boot()
    expect(m.told).toHaveLength(1)
    expect(readDevelopment(m.db)).toMatchObject({ on: true, folders: { [NOTES.id]: { dir: notes } } })
  })

  test('a machine running everything from releases starts with development off, and says nothing', async () => {
    const m = machine({})
    m.registrations.set(NOTES.id, join(m.installsRoot, NOTES.id))
    await m.desk.boot()
    expect((await m.desk.state()).on).toBe(false)
    expect(m.told).toEqual([])
  })

  test('a module on no official list is never listed, learned or moved, from wherever it runs', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-dev-own-')))
    const own = checkout(join(root, 'my-module'), 'someone/my-module')
    const m = machine({ 'someone.mine': own })
    await m.desk.boot()
    const state = await m.desk.state()
    expect(state.on).toBe(false)
    expect(state.modules).toEqual([])
    await m.desk.setOn(false)
    await m.desk.idle()
    expect(m.moved).toEqual([])
    expect(m.registrations.get('someone.mine')).toBe(own)
  })

  test('turning it off moves every module on a folder to its release, says which folders are no longer used, and never touches them', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-dev-off-')))
    const notes = checkout(join(root, 'kehikko-notes'), NOTES.repo)
    const paper = checkout(join(root, 'kehikko-paper'), PAPER.repo)
    const before = { notes: fingerprint(notes), paper: fingerprint(paper) }
    const m = machine({ [NOTES.id]: notes, [PAPER.id]: paper })
    await m.desk.boot()
    await m.desk.setOn(false)
    await m.desk.idle()
    expect(m.copied.sort()).toEqual([NOTES.id, PAPER.id])
    expect(m.registrations.get(NOTES.id)).toBe(join(m.installsRoot, NOTES.id))
    expect(m.registrations.get(PAPER.id)).toBe(join(m.installsRoot, PAPER.id))
    const state = await m.desk.state()
    expect(state.on).toBe(false)
    expect(state.modules.map((one) => [one.id, one.runs.from, one.move?.step])).toEqual([
      [NOTES.id, 'release', 'done'],
      [PAPER.id, 'release', 'done'],
    ])
    /* The folders are still each module's development folder, for when development is on again. */
    expect(state.modules.map((one) => one.folder)).toEqual([notes, paper])
    expect(state.summary).toContain('2 modules now run from Kehikot’s releases.')
    expect(state.summary).toContain('These folders are no longer used by Kehikot; you can remove them:')
    /* One Inbox line each, the first to read told last. */
    expect(m.told.slice(-summaryLines({ toRelease: 2, toFolder: 0, failed: [], freed: [notes, paper] }, m.root).length).reverse().join(' ')).toBe(state.summary!)
    expect(fingerprint(notes)).toBe(before.notes)
    expect(fingerprint(paper)).toBe(before.paper)
  })

  test('turning it on again runs each module with a folder from it', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-dev-on-')))
    const notes = checkout(join(root, 'kehikko-notes'), NOTES.repo)
    const m = machine({ [NOTES.id]: notes, [PAPER.id]: '' })
    m.registrations.set(PAPER.id, join(m.installsRoot, PAPER.id))
    await m.desk.boot()
    await m.desk.setOn(false)
    await m.desk.idle()
    await m.desk.setOn(true)
    await m.desk.idle()
    expect(m.registrations.get(NOTES.id)).toBe(notes)
    /* No folder: it stays on its release. */
    expect(m.registrations.get(PAPER.id)).toBe(join(m.installsRoot, PAPER.id))
    expect((await m.desk.state()).summary).toBe('1 module now runs from your own folder.')
  })

  test('a module that does not start from its release is put back, and the summary says so', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-dev-fail-')))
    const notes = checkout(join(root, 'kehikko-notes'), NOTES.repo)
    const m = machine({ [NOTES.id]: notes }, { moveFails: (id) => id === NOTES.id })
    await m.desk.boot()
    await m.desk.setOn(false)
    await m.desk.idle()
    expect(m.registrations.get(NOTES.id)).toBe(notes)
    const state = await m.desk.state()
    expect(state.modules[0]!.move).toEqual({ step: 'restored', why: `${NOTES.id} did not start from ${join(m.installsRoot, NOTES.id)}, so it was put back.` })
    expect(state.summary).toBe(`1 did not move. ${NOTES.id} did not start from ${join(m.installsRoot, NOTES.id)}, so it was put back.`.replace(NOTES.id, 'Notes did not move: ' + NOTES.id))
    expect(state.summary).not.toContain('no longer used')
  })

  test('a release that cannot be put in place leaves the registration alone', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-dev-copy-')))
    const notes = checkout(join(root, 'kehikko-notes'), NOTES.repo)
    const m = machine({ [NOTES.id]: notes }, { copyFails: NOTES.id })
    await m.desk.boot()
    await m.desk.setOn(false)
    await m.desk.idle()
    expect(m.moved).toEqual([])
    expect(m.registrations.get(NOTES.id)).toBe(notes)
    expect((await m.desk.state()).modules[0]!.move?.why).toContain('the network is down')
  })

  test('"use the release for this one" while development is on is remembered, and undone the same way', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-dev-one-')))
    const notes = checkout(join(root, 'kehikko-notes'), NOTES.repo)
    const paper = checkout(join(root, 'kehikko-paper'), PAPER.repo)
    const m = machine({ [NOTES.id]: notes, [PAPER.id]: paper })
    await m.desk.boot()
    expect(await m.desk.setModule(NOTES.id, { release: true })).toEqual({ ok: true })
    await m.desk.idle()
    expect(m.registrations.get(NOTES.id)).toBe(join(m.installsRoot, NOTES.id))
    expect(m.registrations.get(PAPER.id)).toBe(paper)
    expect(readDevelopment(m.db)?.folders[NOTES.id]).toEqual({ dir: notes, release: true })
    /* Kept across a restart of the host: a new desk over the same database. */
    const again = developmentDesk({ db: m.db, official: () => [NOTES, PAPER], installsRoot: m.installsRoot, registrations: async () => [...m.registrations].map(([id, dir]) => ({ id, dir })), copy: async () => ({ ok: true }), move: async () => ({ ok: true }), tell: () => {} })
    expect((await again.state()).modules.find((one) => one.id === NOTES.id)).toMatchObject({ release: true, wants: 'release' })
    await m.desk.setModule(NOTES.id, { release: false })
    await m.desk.idle()
    expect(m.registrations.get(NOTES.id)).toBe(notes)
  })

  test('a folder the person adds must be that module’s checkout; one is offered, never taken', async () => {
    const m = machine({})
    m.registrations.set(NOTES.id, join(m.installsRoot, NOTES.id))
    m.registrations.set(PAPER.id, join(m.installsRoot, PAPER.id))
    const notes = checkout(join(m.root, 'Projects', 'kehikko-modules', 'kehikko-notes'), NOTES.repo)
    const wrong = checkout(join(m.root, 'elsewhere', 'kehikko-paper'), 'someone/else')
    await m.desk.boot()
    await m.desk.setOn(true)
    await m.desk.idle()
    const state = await m.desk.state()
    expect(state.modules.find((one) => one.id === NOTES.id)?.found).toBe(notes)
    expect(m.moved).toEqual([])
    const refused = await m.desk.setModule(PAPER.id, { folder: wrong })
    expect(refused).toMatchObject({ ok: false, status: 409 })
    expect(await m.desk.setModule(NOTES.id, { folder: notes })).toEqual({ ok: true })
    await m.desk.idle()
    expect(m.registrations.get(NOTES.id)).toBe(notes)
    /* Forgetting the folder puts it back on its release. */
    await m.desk.setModule(NOTES.id, { folder: null })
    await m.desk.idle()
    expect(m.registrations.get(NOTES.id)).toBe(join(m.installsRoot, NOTES.id))
  })

  test('with development off, a module registered from a folder by hand shows as such and moves on one press', async () => {
    const m = machine({})
    m.registrations.set(NOTES.id, join(m.installsRoot, NOTES.id))
    await m.desk.boot()
    const notes = checkout(join(m.root, 'kehikko-notes'), NOTES.repo)
    m.registrations.set(NOTES.id, notes)
    const row = (await m.desk.state()).modules[0]!
    expect(row).toMatchObject({ runs: { from: 'folder' }, wants: 'release', folder: notes })
    expect(drifted(row) && showsRuns(false, row)).toBe(true)
    await m.desk.setModule(NOTES.id, { move: true })
    await m.desk.idle()
    expect(m.registrations.get(NOTES.id)).toBe(join(m.installsRoot, NOTES.id))
  })
})

describe('a module set to keep running', () => {
  const setUp = async (options: { running?: boolean } = { running: true }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-dev-keep-')))
    const notes = checkout(join(root, 'kehikko-notes'), NOTES.repo)
    const paper = checkout(join(root, 'kehikko-paper'), PAPER.repo)
    const m = machine({ [NOTES.id]: notes, [PAPER.id]: paper }, { keeps: [PAPER.id], running: options.running ? [PAPER.id] : [] })
    await m.desk.boot()
    await m.desk.setOn(false)
    await m.desk.idle()
    return { m, notes, paper }
  }

  test('is not stopped for the move, and the summary says so: it names it, why, and when it moves', async () => {
    const { m, paper } = await setUp()
    expect(m.registrations.get(PAPER.id)).toBe(paper)
    const state = await m.desk.state()
    expect(state.summary).toContain('1 module now runs from Kehikot’s releases. 1 did not move.')
    expect(state.summary).toContain('Paper did not move yet: it is set to keep running')
    expect(state.summary).toContain('Move now')
    /* Told in the Inbox as lines of their own, each whole. */
    expect(m.told.some((line) => line.startsWith('Paper did not move yet'))).toBe(true)
    const row = state.modules.find((one) => one.id === PAPER.id)!
    expect(row).toMatchObject({ keeps: true, runs: { from: 'folder' }, move: { step: 'later' } })
  })

  test('is still waiting after the host restarts: the row is derived, not remembered', async () => {
    const { m } = await setUp()
    const again = developmentDesk({
      db: m.db,
      official: () => [NOTES, PAPER],
      installsRoot: m.installsRoot,
      registrations: async () => [...m.registrations].map(([id, dir]) => ({ id, dir, keep: id === PAPER.id })),
      copy: async () => ({ ok: true }),
      move: async () => ({ ok: true }),
      tell: () => {},
    })
    expect((await again.state()).modules.find((one) => one.id === PAPER.id)?.move?.step).toBe('later')
    expect(again.owes(PAPER.id, { dir: m.registrations.get(PAPER.id), keep: true })).toBe(true)
  })

  test('moves by itself at its next restart, from its release, and says so; the folder is untouched', async () => {
    const { m, paper } = await setUp()
    const before = fingerprint(paper)
    expect(m.desk.owes(PAPER.id, { dir: paper, keep: true })).toBe(true)
    expect(m.desk.owes(NOTES.id, { dir: join(m.installsRoot, NOTES.id), keep: true })).toBe(false)
    const settling = await m.desk.beforeStart(PAPER.id)
    expect(settling?.dir).toBe(join(m.installsRoot, PAPER.id))
    expect(m.registrations.get(PAPER.id)).toBe(join(m.installsRoot, PAPER.id))
    expect(m.copied).toContain(PAPER.id)
    await settling!.finish(true)
    const row = (await m.desk.state()).modules.find((one) => one.id === PAPER.id)!
    expect(row).toMatchObject({ runs: { from: 'release' }, move: { step: 'done' } })
    expect(m.told.join(' ')).toContain('1 module now runs from Kehikot’s releases.')
    expect(m.told.join(' ')).toContain('is no longer used by Kehikot')
    expect(fingerprint(paper)).toBe(before)
    /* Nothing is owed any more. */
    expect(m.desk.owes(PAPER.id, { dir: m.registrations.get(PAPER.id), keep: true })).toBe(false)
  })

  test('a restart whose release does not answer puts the registration back and does not try again by itself', async () => {
    const { m, paper } = await setUp()
    const settling = await m.desk.beforeStart(PAPER.id)
    await settling!.finish(false, 'it did not answer.')
    expect(m.registrations.get(PAPER.id)).toBe(paper)
    expect((await m.desk.state()).modules.find((one) => one.id === PAPER.id)?.move?.step).toBe('restored')
    expect(m.desk.owes(PAPER.id, { dir: paper, keep: true })).toBe(false)
    expect(await m.desk.beforeStart(PAPER.id)).toBeNull()
    /* A person's press makes it a candidate again (it is still running, so it waits for its next restart). */
    await m.desk.setModule(PAPER.id, { move: true })
    await m.desk.idle()
    expect(m.desk.owes(PAPER.id, { dir: paper, keep: true })).toBe(true)
  })

  test('"Move now" moves a running one, which the host stops only because a person pressed', async () => {
    const { m, paper } = await setUp()
    expect(m.moved.some((one) => one.id === PAPER.id)).toBe(false)
    expect(await m.desk.setModule(PAPER.id, { move: true, now: true })).toEqual({ ok: true })
    await m.desk.idle()
    expect(m.moved.find((one) => one.id === PAPER.id)).toEqual({ id: PAPER.id, dir: join(m.installsRoot, PAPER.id), now: true })
    expect(m.registrations.get(PAPER.id)).toBe(join(m.installsRoot, PAPER.id))
    expect((await m.desk.state()).modules.find((one) => one.id === PAPER.id)?.move?.step).toBe('done')
    expect(fingerprint(paper)).toBeTruthy()
  })

  test('one that is not running moves with the rest', async () => {
    const { m } = await setUp({ running: false })
    expect(m.registrations.get(PAPER.id)).toBe(join(m.installsRoot, PAPER.id))
  })
})

describe('the summary lists every module that did not move', () => {
  const long = (count: number) => Array.from({ length: count }, (_, index) => `/Users/someone/projects/kehikko-module-number-${index}`)

  test('moved, failed and deferred are all in it, each line short enough for the Inbox to hold whole', () => {
    const lines = summaryLines(
      {
        toRelease: 14,
        toFolder: 0,
        failed: [
          { name: 'Alpha', why: 'Alpha’s release could not be put in place, so it still runs from your folder: the network is down' },
          { name: 'Beta', why: 'x', later: true },
          { name: 'Gamma', why: 'Gamma did not start from /x/installed/kehikot.gamma, so it was put back on /Users/someone/projects/kehikko-gamma.' },
          { name: 'Delta', why: 'x', later: true },
          { name: 'Epsilon', why: 'x', later: true },
          { name: 'Zeta', why: 'x', later: true },
        ],
        freed: long(14),
      },
      '/Users/someone',
    )
    expect(lines[0]).toBe('14 modules now run from Kehikot’s releases. 6 did not move.')
    for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']) expect(lines.filter((line) => line.startsWith(name)).length).toBe(1)
    expect(lines.filter((line) => /did not move yet/.test(line))).toHaveLength(4)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(SUMMARY_LINE_MAX)
    /* Every folder is still named, in as many lines as it takes. */
    for (const folder of long(14)) expect(lines.join(' ')).toContain(folder.replace('/Users/someone', '~'))
    /* And what the Inbox keeps of each line is the whole line: the 120-character label, with the rest as its detail. */
    for (const line of lines) {
      const { entry } = noticeEntry('kehikot.host', 'Kehikot', { epic: '', message: line, level: 'done', refs: [] }, 'id', 1)
      expect(entry.detail ?? entry.label).toBe(line)
    }
  })

  test('with none unmoved there is no "did not move"; with nothing to move, it says so', () => {
    expect(summaryLines({ toRelease: 2, toFolder: 0, failed: [], freed: [] }, null)).toEqual(['2 modules now run from Kehikot’s releases.'])
    expect(summaryLines({ toRelease: 0, toFolder: 0, failed: [], freed: [] }, null)).toEqual(['Every module already ran from where it should.'])
  })

  test('a move that throws is still in it', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-dev-throws-')))
    const notes = checkout(join(root, 'kehikko-notes'), NOTES.repo)
    const m = machine({ [NOTES.id]: notes })
    await m.desk.boot()
    const original = m.desk
    await original.setOn(true)
    m.registrations.set(NOTES.id, notes)
    const broken = developmentDesk({
      db: m.db,
      official: () => [NOTES],
      installsRoot: m.installsRoot,
      registrations: async () => [{ id: NOTES.id, dir: notes }],
      copy: async () => {
        throw new Error('disk full')
      },
      move: async () => ({ ok: true }),
      tell: () => {},
    })
    await broken.setOn(false)
    await broken.idle()
    expect((await broken.state()).summary).toContain('1 did not move.')
    expect((await broken.state()).summary).toContain('disk full')
  })
})

describe('the pieces', () => {
  test('a registration is pointed elsewhere keeping every key, and put back word for word', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kehikko-reg-'))
    const file = join(dir, 'kehikot.notes.json')
    const text = '{\n  "url": "http://127.0.0.1:7820",\n  "dir": "/x/kehikko-notes",\n  "keep": true\n}\n'
    writeFileSync(file, text)
    const pointed = pointRegistrationAt(file, '/y/installed/kehikot.notes')
    expect(pointed).toEqual({ ok: true, before: text })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ url: 'http://127.0.0.1:7820', dir: '/y/installed/kehikot.notes', keep: true })
    restoreRegistration(file, text)
    expect(readFileSync(file, 'utf8')).toBe(text)
  })

  test('folderRefused and lookForCheckouts', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-look-')))
    const installs = join(root, 'installed')
    mkdirSync(installs)
    const notes = checkout(join(root, 'projects', 'kehikko-notes'), NOTES.repo)
    expect(folderRefused(NOTES, notes, installs)).toBeNull()
    expect(folderRefused(PAPER, notes, installs)).toContain('is not a copy of Jalez/kehikko-paper')
    expect(folderRefused(NOTES, 'relative/path', installs)).toContain('not a full path')
    expect(folderRefused(NOTES, join(root, 'missing'), installs)).toContain('not there')
    const inside = checkout(join(installs, 'kehikot.notes'), NOTES.repo)
    expect(folderRefused(NOTES, inside, installs)).toContain('Kehikot’s own copies')
    expect([...lookForCheckouts(root, [NOTES, PAPER], installs)]).toEqual([[NOTES.id, notes]])
  })

  test('the words', () => {
    expect(pathSaid('/Users/a/projects/kehikko-notes', '/Users/a')).toBe('~/projects/kehikko-notes')
    expect(runsSaid({ from: 'release', version: '1.6.1' }, null)).toBe('Release 1.6.1')
    expect(runsSaid({ from: 'folder', dir: '/Users/a/projects/kehikko-notes' }, '/Users/a')).toBe('Your folder ~/projects/kehikko-notes')
    expect(startedOnSaid(20)).toBe('Kehikko development is on because 20 modules run from your own folders. Turn it off in Settings › Modules to run them all from Kehikot’s releases.')
    expect(summarySaid({ toRelease: 1, toFolder: 0, failed: [], freed: ['/Users/a/projects/kehikko-notes'] }, '/Users/a')).toBe(
      '1 module now runs from Kehikot’s releases. Your folder ~/projects/kehikko-notes is no longer used by Kehikot; you can remove it. Press Move unused folders to the Trash in Settings › Modules to clear it; each is checked first.',
    )
  })
})
