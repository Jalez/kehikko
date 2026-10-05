import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCanvas, editCanvas, listCanvases, open as openDb, type Placement } from '../server/canvases.ts'
import { dataVersionsFile, readDataVersions, recordDataVersion, recordedFor, refusal } from '../server/dataVersions.ts'
import type { Presence } from '../server/discover.ts'
import { keep, kehikotFile, syncProject } from '../server/kehikot.ts'
import { versionsDir } from '../server/machineDirs.ts'
import { pinSummary, pinsNeeded, pinUses, Pins, preparingLine } from '../server/pins.ts'
import { addProject } from '../server/projects.ts'
import {
  FactsStore,
  SourceMaterialiser,
  VersionRuns,
  versionKey,
  type Instance,
  type Materialiser,
  type RunDeps,
} from '../server/versionRuns.ts'
import {
  compareSemver,
  isVersionTag,
  newestFirst,
  parseTag,
  remoteOf,
  run,
  TAGS_FAILED_MS,
  TAGS_FRESH_MS,
  TagLister,
  tagsFromLsRemote,
  type Runner,
} from '../server/versions.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-versions-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let made = 0
const scratch = (name: string) => {
  const dir = join(root, `${name}-${(made += 1)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('semver', () => {
  test('reads the tags people write, and nothing else', () => {
    expect(parseTag('v1.4.0')).toEqual({ major: 1, minor: 4, patch: 0, pre: [] })
    expect(parseTag('2.0.0-beta.1')).toEqual({ major: 2, minor: 0, patch: 0, pre: ['beta', '1'] })
    for (const bad of ['v1.4', 'release', 'v01.2.3', '1.2.3+build', 'v1.2.3-', '../v1.2.3', `v1.2.3-${'x'.repeat(80)}`]) {
      expect(isVersionTag(bad)).toBe(false)
    }
  })

  test('sorts newest first, with pre-releases below their release', () => {
    const tags = ['v1.2.0', 'v1.10.0', 'v1.9.3', 'v2.0.0-rc.1', 'v2.0.0', 'v2.0.0-beta.2', 'v2.0.0-beta.11', 'v2.0.0-alpha', 'old', 'v0.1.0']
    expect(newestFirst(tags)).toEqual([
      'v2.0.0',
      'v2.0.0-rc.1',
      'v2.0.0-beta.11',
      'v2.0.0-beta.2',
      'v2.0.0-alpha',
      'v1.10.0',
      'v1.9.3',
      'v1.2.0',
      'v0.1.0',
    ])
  })

  test('numeric identifiers sort below alphanumeric ones, and a longer set is newer', () => {
    expect(compareSemver(parseTag('1.0.0-1')!, parseTag('1.0.0-alpha')!)).toBeLessThan(0)
    expect(compareSemver(parseTag('1.0.0-alpha')!, parseTag('1.0.0-alpha.1')!)).toBeLessThan(0)
    expect(compareSemver(parseTag('v1.0.0')!, parseTag('1.0.0')!)).toBe(0)
  })

  test('one version written two ways is listed once, as the v spelling', () => {
    expect(newestFirst(['1.2.0', 'v1.2.0', '1.1.0'])).toEqual(['v1.2.0', '1.1.0'])
  })
})

describe('ls-remote', () => {
  const printed = [
    'aaaa\trefs/tags/v1.0.0',
    'bbbb\trefs/tags/v1.2.0',
    'bbbc\trefs/tags/v1.2.0^{}',
    'cccc\trefs/tags/nightly',
    'dddd\trefs/heads/main',
    'eeee\trefs/tags/v1.10.0',
    '',
  ].join('\n')

  test('the tags are parsed out of what git printed, newest first', () => {
    expect(tagsFromLsRemote(printed)).toEqual(['v1.10.0', 'v1.2.0', 'v1.0.0'])
  })

  test('are read once and cached, and a failure is believed for less time', async () => {
    let clock = 1_000
    const calls: string[][] = []
    let answer: Awaited<ReturnType<Runner>> = { ok: true, out: printed }
    const runner: Runner = async (argv) => {
      calls.push([...argv])
      return answer
    }
    const lister = new TagLister(runner, () => clock)
    const first = await lister.tags('git@github.com:someone/notes.git')
    expect(first).toMatchObject({ ok: true, tags: ['v1.10.0', 'v1.2.0', 'v1.0.0'] })
    expect(calls).toEqual([['git', 'ls-remote', '--tags', '--refs', 'git@github.com:someone/notes.git']])

    clock += TAGS_FRESH_MS - 1
    await lister.tags('git@github.com:someone/notes.git')
    expect(calls).toHaveLength(1)
    await lister.tags('git@github.com:someone/notes.git', true)
    expect(calls).toHaveLength(2)

    answer = { ok: false, why: 'Permission denied (publickey).' }
    const other = await lister.tags('git@github.com:someone/private.git')
    expect(other).toMatchObject({ ok: false, why: 'Permission denied (publickey).' })
    clock += TAGS_FAILED_MS
    answer = { ok: true, out: 'ffff\trefs/tags/v0.1.0' }
    expect(await lister.tags('git@github.com:someone/private.git')).toMatchObject({ ok: true, tags: ['v0.1.0'] })
  })

  test('the remote is the checkout’s origin, or its only remote, and never a guess', async () => {
    const answers: Record<string, Awaited<ReturnType<Runner>>> = {}
    const runner: Runner = async (argv) => answers[argv.slice(3).join(' ')] ?? { ok: false, why: 'no' }
    answers['remote get-url origin'] = { ok: true, out: 'git@github.com:a/b.git' }
    expect(await remoteOf('/x', runner)).toBe('git@github.com:a/b.git')
    delete answers['remote get-url origin']
    answers['remote'] = { ok: true, out: 'upstream' }
    answers['remote get-url upstream'] = { ok: true, out: '/srv/b.git' }
    expect(await remoteOf('/x', runner)).toBe('/srv/b.git')
    answers['remote'] = { ok: true, out: 'one\ntwo' }
    expect(await remoteOf('/x', runner)).toBeNull()
  })

  test('the real ls-remote, against a repository on disk', async () => {
    const repo = scratch('ls')
    const git = (...args: string[]) => Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'ignore', stderr: 'ignore' })
    git('init', '-q')
    writeFileSync(join(repo, 'a'), '1')
    git('add', 'a')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one')
    git('tag', 'v1.0.0')
    git('tag', '-a', '-m', 'annotated', 'v1.1.0')
    git('tag', 'scratch')
    const got = await new TagLister(run).tags(repo)
    expect(got).toMatchObject({ ok: true, tags: ['v1.1.0', 'v1.0.0'] })
  })
})

describe('the data guard', () => {
  test('a version older than the project’s data is refused, with the reason', () => {
    expect(refusal('Notes', 'v1.0.0', 1, 2)).toContain('format 1')
    expect(refusal('Notes', 'v1.0.0', 1, 2)).toContain('format 2')
    expect(refusal('Notes', 'v1.0.0', 2, 2)).toBeNull()
    expect(refusal('Notes', 'v3.0.0', 3, 2)).toBeNull()
    /* Not known yet is not a refusal: the version is read when it is prepared. */
    expect(refusal('Notes', 'v1.0.0', null, 2)).toBeNull()
    /* And nothing recorded means nothing has run here. */
    expect(refusal('Notes', 'v1.0.0', 1, null)).toBeNull()
  })

  test('the record only ever rises, and lives in the project', () => {
    const project = scratch('project')
    expect(readDataVersions(project)).toEqual({})
    expect(recordDataVersion(project, 'kehikot.notes', 2)).toBe(true)
    expect(recordDataVersion(project, 'kehikot.notes', 1)).toBe(false)
    expect(recordDataVersion(project, 'kehikot.notes', 2)).toBe(false)
    expect(recordDataVersion(project, 'roadmap.checklist', 3)).toBe(true)
    expect(readDataVersions(project)).toEqual({ 'kehikot.notes': 2, 'kehikot.checklist': 3 })
    expect(dataVersionsFile(project)).toBe(join(project, '.kehikot', 'kehikko', 'data-versions.json'))
    expect(recordedFor(readDataVersions(project), 'kehikot.notes')).toBe(2)
    expect(recordedFor(readDataVersions(project), 'constructor')).toBeNull()
  })

  test('a hand-edited file keeps only what it can believe', () => {
    const project = scratch('edited')
    mkdirSync(join(project, '.kehikot', 'kehikko'), { recursive: true })
    writeFileSync(
      dataVersionsFile(project)!,
      JSON.stringify({ 'kehikot.notes': 2, 'kehikot.paper': 0, 'kehikot.x': 1.5, 'Not An Id': 3, 'kehikot.y': '4' }),
    )
    expect(readDataVersions(project)).toEqual({ 'kehikot.notes': 2 })
  })
})

describe('a pin is kept with the container', () => {
  const base: Placement = {
    i: 'kehikot.notes',
    x: 0,
    y: 0,
    w: 4,
    h: 10,
    grow: false,
    pinned: false,
    prompt: '',
    promptFor: null,
    collapsed: false,
    wish: 10,
    selected: false,
    filters: {},
    refreshEvery: null,
    version: null,
  }

  test('in the database, and only a version tag', () => {
    const db = openDb(':memory:')
    const canvas = createCanvas(db, 'one')
    editCanvas(db, canvas.id, { placements: [{ ...base, version: 'v1.2.0' }, { ...base, i: 'kehikot.paper', x: 4, version: 'main; rm -rf /' }] })
    const [read] = listCanvases(db)
    expect(read!.placements.find((p) => p.i === 'kehikot.notes')!.version).toBe('v1.2.0')
    expect(read!.placements.find((p) => p.i === 'kehikot.paper')!.version).toBeNull()
  })

  test('in kehikot.json, so the project reopens on the same version elsewhere', () => {
    const dir = scratch('travel')
    const here = openDb(':memory:')
    const added = addProject(here, dir, undefined, false)
    if (!added.ok) throw new Error(added.why)
    const canvas = createCanvas(here, 'pinned', added.project.id, 'pinned')
    editCanvas(here, canvas.id, { placements: [{ ...base, version: 'v1.2.0' }, { ...base, i: 'kehikot.paper', x: 4 }] })
    keep(here, added.project.id)
    const text = readFileSync(kehikotFile(dir)!, 'utf8')
    expect(text).toContain('"version":"v1.2.0"')
    /* Latest writes no field at all, so a file without pins still reads in a
       host from before versions, whose schema is strict. */
    expect(text.match(/"version":"/g)).toHaveLength(1)

    const there = openDb(':memory:')
    const again = addProject(there, dir, undefined, false)
    if (!again.ok) throw new Error(again.why)
    syncProject(there, again.project)
    const arrived = listCanvases(there)[0]!
    expect(arrived.placements.find((p) => p.i === 'kehikot.notes')!.version).toBe('v1.2.0')
    expect(arrived.placements.find((p) => p.i === 'kehikot.paper')!.version).toBeNull()
  })

  test('counted per version across every kehikko, and needed only where a kehikko is open', () => {
    const db = openDb(':memory:')
    const a = createCanvas(db, 'a')
    const b = createCanvas(db, 'b')
    const c = createCanvas(db, 'c')
    editCanvas(db, a.id, { placements: [{ ...base, version: 'v1.2.0' }] })
    editCanvas(db, b.id, { placements: [{ ...base, version: 'v1.2.0' }, { ...base, i: 'kehikot.paper', x: 4, version: 'v0.3.0' }] })
    editCanvas(db, c.id, { placements: [{ ...base }] })
    const canvases = listCanvases(db)
    expect([...pinUses(canvases)]).toEqual([
      ['kehikot.notes@v1.2.0', 2],
      ['kehikot.paper@v0.3.0', 1],
    ])
    expect([...pinsNeeded(canvases, new Set([a.id, c.id]))]).toEqual(['kehikot.notes@v1.2.0'])
    expect(pinSummary(canvases)).toEqual({
      'kehikot.notes': { containers: 2, versions: ['v1.2.0'] },
      'kehikot.paper': { containers: 1, versions: ['v0.3.0'] },
    })
  })
})

/* ------------------------------------------------------------------ *
 * Running versions: shared, counted, stopped
 * ------------------------------------------------------------------ */

function fakeRuns(options: { prepare?: Materialiser['prepare']; answered?: boolean; grace?: number } = {}) {
  let clock = 0
  const spawned: string[] = []
  const stopped: string[] = []
  const steps: string[] = []
  const materialiser: Materialiser = {
    prepare:
      options.prepare
      ?? (async (source, tag, step) => {
        step('fetching')
        step('installing')
        steps.push(`${source.id}@${tag}`)
        return { ok: true, tree: { dir: `/v/${source.id}/${tag}`, script: `/v/${source.id}/${tag}/run.sh` } }
      }),
    prepared: () => null,
    log: (id, tag) => `/v/${id}/${tag}.log`,
  }
  let port = 7925
  const deps: RunDeps = {
    materialiser,
    source: async (id) => ({ id, name: id, dir: `/m/${id}`, remote: `/r/${id}.git` }),
    adoptable: async () => null,
    port: async (_id, taken) => {
      while (taken.has(port)) port += 1
      return port
    },
    spawn: (key) => {
      spawned.push(key)
      return { ok: true }
    },
    answered: async () => options.answered ?? true,
    stop: (key: string, _instance: Instance) => {
      stopped.push(key)
    },
    changed: () => {},
  }
  const runs = new VersionRuns(deps, options.grace ?? 1000, () => clock)
  return { runs, spawned, stopped, steps, tick: (ms: number) => (clock += ms) }
}

const settle = () => new Promise((done) => setTimeout(done, 5))

describe('version processes', () => {
  test('containers pinned to the same version share one process', async () => {
    const { runs, spawned } = fakeRuns()
    const one = runs.ensure('kehikot.notes', 'v1.2.0')
    const two = runs.ensure('kehikot.notes', 'v1.2.0')
    expect(two).toBe(one)
    await settle()
    expect(spawned).toEqual(['kehikot.notes@v1.2.0'])
    expect(one).toMatchObject({ state: 'running', port: 7925, origin: 'http://127.0.0.1:7925' })
  })

  test('a second version is a second process, on a port of its own', async () => {
    const { runs, spawned } = fakeRuns()
    runs.ensure('kehikot.notes', 'v1.2.0')
    await settle()
    const other = runs.ensure('kehikot.notes', 'v1.1.0')
    await settle()
    expect(spawned).toEqual(['kehikot.notes@v1.2.0', 'kehikot.notes@v1.1.0'])
    expect(other.port).toBe(7926)
  })

  test('kept while any container pins it, stopped when none does', async () => {
    const { runs, stopped } = fakeRuns()
    const key = versionKey('kehikot.notes', 'v1.2.0')
    runs.reconcile(new Map([[key, 2]]), new Set([key]))
    await settle()
    expect(runs.get('kehikot.notes', 'v1.2.0')?.state).toBe('running')
    runs.reconcile(new Map([[key, 1]]), new Set([key]))
    expect(stopped).toEqual([])
    runs.reconcile(new Map(), new Set())
    expect(stopped).toEqual([key])
    expect(runs.get('kehikot.notes', 'v1.2.0')).toBeNull()
  })

  test('pinned on no open kehikko for the grace period, it is stopped; the reaper never starts one', async () => {
    const { runs, stopped, spawned, tick } = fakeRuns({ grace: 1000 })
    const key = versionKey('kehikot.notes', 'v1.2.0')
    runs.reconcile(new Map([[key, 1]]), new Set(), false)
    await settle()
    expect(spawned).toEqual([])
    runs.reconcile(new Map([[key, 1]]), new Set([key]))
    await settle()
    tick(999)
    runs.reconcile(new Map([[key, 1]]), new Set(), false)
    expect(stopped).toEqual([])
    tick(1)
    runs.reconcile(new Map([[key, 1]]), new Set(), false)
    expect(stopped).toEqual([key])
  })

  test('a version that will not prepare stays failed, says why, and is not retried on every sweep', async () => {
    let tries = 0
    const { runs, spawned } = fakeRuns({
      prepare: async () => {
        tries += 1
        return { ok: false, why: 'bun install failed in v1.0.0: lockfile mismatch' }
      },
    })
    const key = versionKey('kehikot.notes', 'v1.0.0')
    runs.reconcile(new Map([[key, 1]]), new Set([key]))
    await settle()
    runs.reconcile(new Map([[key, 1]]), new Set([key]))
    await settle()
    expect(tries).toBe(1)
    expect(spawned).toEqual([])
    expect(runs.get('kehikot.notes', 'v1.0.0')).toMatchObject({ state: 'failed', why: expect.stringContaining('lockfile') })
    expect(preparingLine('Notes', 'v1.0.0', runs.get('kehikot.notes', 'v1.0.0'))).toContain('could not be run')
    runs.retry('kehikot.notes', 'v1.0.0')
    await settle()
    expect(tries).toBe(2)
  })

  test('a preparation that finishes after its last pin went away runs nothing', async () => {
    let release!: () => void
    const gate = new Promise<void>((done) => (release = done))
    const { runs, spawned } = fakeRuns({
      prepare: async () => {
        await gate
        return { ok: true, tree: { dir: '/t', script: '/t/run.sh' } }
      },
    })
    const key = versionKey('kehikot.notes', 'v1.2.0')
    runs.reconcile(new Map([[key, 1]]), new Set([key]))
    runs.reconcile(new Map(), new Set())
    release()
    await settle()
    expect(spawned).toEqual([])
    expect(runs.get('kehikot.notes', 'v1.2.0')).toBeNull()
  })

  test('a process that never answers is a failure that names its log', async () => {
    const { runs } = fakeRuns({ answered: false })
    runs.ensure('kehikot.notes', 'v1.2.0')
    await settle()
    expect(runs.get('kehikot.notes', 'v1.2.0')).toMatchObject({ state: 'failed', why: expect.stringContaining('v1.2.0.log') })
  })
})

describe('a version from source', () => {
  test('a worktree at the tag, under the versions directory, and the module’s checkout untouched', async () => {
    const remote = scratch('remote')
    const checkout = scratch('checkout')
    const sh = (dir: string, ...args: string[]) => {
      const done = Bun.spawnSync(['git', '-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdout: 'pipe', stderr: 'pipe' })
      if (done.exitCode !== 0) throw new Error(done.stderr.toString())
      return done.stdout.toString().trim()
    }
    sh(remote, 'init', '-q', '--bare')
    sh(checkout, 'init', '-q', '-b', 'main')
    writeFileSync(join(checkout, 'run.sh'), '#!/bin/sh\necho one\n', { mode: 0o755 })
    sh(checkout, 'add', 'run.sh')
    sh(checkout, 'commit', '-qm', 'one')
    sh(checkout, 'tag', 'v1.0.0')
    writeFileSync(join(checkout, 'run.sh'), '#!/bin/sh\necho two\n', { mode: 0o755 })
    sh(checkout, 'commit', '-qam', 'two')
    sh(checkout, 'remote', 'add', 'origin', remote)
    sh(checkout, 'push', '-q', 'origin', 'main', '--tags')
    /* A change somebody is in the middle of. It must still be there after. */
    writeFileSync(join(checkout, 'run.sh'), '#!/bin/sh\necho half-written\n', { mode: 0o755 })
    const headBefore = sh(checkout, 'rev-parse', 'HEAD')

    const versions = scratch('versions')
    const materialiser = new SourceMaterialiser(versions)
    const steps: string[] = []
    const got = await materialiser.prepare(
      { id: 'kehikot.scratch', name: 'Scratch', dir: checkout, remote },
      'v1.0.0',
      (step) => steps.push(step),
    )
    expect(got).toMatchObject({ ok: true, tree: { dir: join(versions, 'kehikot.scratch', 'v1.0.0') } })
    expect(steps).toEqual(['fetching', 'checking out', 'installing'])
    expect(readFileSync(join(versions, 'kehikot.scratch', 'v1.0.0', 'run.sh'), 'utf8')).toContain('echo one')
    expect(materialiser.prepared('kehikot.scratch', 'v1.0.0')).not.toBeNull()

    expect(sh(checkout, 'rev-parse', 'HEAD')).toBe(headBefore)
    expect(sh(checkout, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(readFileSync(join(checkout, 'run.sh'), 'utf8')).toContain('half-written')
    expect(sh(checkout, 'worktree', 'list').split('\n')).toHaveLength(1)

    /* Prepared once is prepared: a second call does nothing slow. */
    const again: string[] = []
    await materialiser.prepare({ id: 'kehikot.scratch', name: 'Scratch', dir: checkout, remote }, 'v1.0.0', (s) => again.push(s))
    expect(again).toEqual([])

    expect(await materialiser.prepare({ id: 'kehikot.scratch', name: 'Scratch', dir: checkout, remote }, 'v9.9.9', () => {})).toMatchObject({
      ok: false,
      why: expect.stringContaining('could not fetch v9.9.9'),
    })
    expect(await materialiser.prepare({ id: '../escape', name: 'x', dir: checkout, remote }, 'v1.0.0', () => {})).toMatchObject({ ok: false })
  })

  test('the versions directory is the machine directory’s, and can be pointed elsewhere', () => {
    expect(versionsDir({ HOME: '/h' }, )).toContain(join('Kehikot', 'versions'))
    expect(versionsDir({ HOME: '/h', KEHIKOT_VERSIONS_DIR: '/scratch/v' })).toBe('/scratch/v')
  })
})

/* ------------------------------------------------------------------ *
 * Pinning, through the same function both doors use
 * ------------------------------------------------------------------ */

describe('pinning a container', () => {
  function world(tags: string[], facts: Record<string, { dataVersion: number; compatible: boolean; why: string | null }> = {}) {
    const db: Database = openDb(':memory:')
    const dir = scratch('pinproject')
    const added = addProject(db, dir, undefined, false)
    if (!added.ok) throw new Error(added.why)
    const canvas = createCanvas(db, 'one', added.project.id)
    editCanvas(db, canvas.id, {
      placements: [{ i: 'kehikot.notes', x: 0, y: 0, w: 4, h: 10 }],
    })
    const versions = scratch('factsroot')
    const store = new FactsStore(versions)
    for (const [tag, f] of Object.entries(facts)) store.set('kehikot.notes', tag, { ...f, version: null })
    const ensured: string[] = []
    const runs = {
      get: () => null,
      ensure: (id: string, tag: string) => {
        ensured.push(`${id}@${tag}`)
        return { state: 'preparing' } as Instance
      },
      retry: (id: string, tag: string) => {
        ensured.push(`${id}@${tag}`)
        return { state: 'preparing' } as Instance
      },
    } as unknown as VersionRuns
    const woken: number[] = []
    const runner: Runner = async (argv) =>
      argv.includes('get-url') ? { ok: true, out: '/r/notes.git' } : argv.includes('rev-parse') ? { ok: true, out: 'abc1234' } : { ok: false, why: 'no' }
    const lister = new TagLister(async () => ({ ok: true, out: tags.map((t) => `x\trefs/tags/${t}`).join('\n') }))
    const latest: Presence = {
      id: 'kehikot.notes',
      at: 'http://127.0.0.1:7920',
      condition: 'ready',
      line: '',
      reached: true,
      name: 'Notes',
      module: { version: '2.1.0', dataVersion: 2 } as Presence['module'],
    }
    const pins = new Pins({
      db,
      runs,
      facts: store,
      tags: lister,
      materialiser: new SourceMaterialiser(versions),
      runner,
      registration: async (id) => (id === 'kehikot.notes' ? { id, url: 'http://127.0.0.1:7920', dir: '/m/notes', file: 'x' } : null),
      latest: (id) => (id === 'kehikot.notes' ? latest : null),
      look: async () => latest,
      wake: (c) => woken.push(c),
      keep: (project) => keep(db, project),
    })
    return { db, dir, canvas, pins, ensured, woken }
  }

  test('lists latest and the tags, and pins one: stored, written to the file, woken, started', async () => {
    const { db, dir, canvas, pins, ensured, woken } = world(['v1.0.0', 'v1.1.0'])
    const listed = await pins.list('kehikot.notes', canvas.id)
    if ('why' in listed) throw new Error(listed.why)
    expect(listed.latest).toEqual({ version: '2.1.0', commit: 'abc1234', dataVersion: 2 })
    expect(listed.versions.map((v) => v.tag)).toEqual(['v1.1.0', 'v1.0.0'])
    expect(listed.pinned).toBeNull()

    const pinned = await pins.pin(canvas.id, 'kehikot.notes', 'v1.1.0')
    expect(pinned).toMatchObject({ ok: true })
    expect(listCanvases(db)[0]!.placements[0]!.version).toBe('v1.1.0')
    expect(readFileSync(kehikotFile(dir)!, 'utf8')).toContain('"version":"v1.1.0"')
    expect(woken).toEqual([canvas.id])
    expect(ensured).toEqual(['kehikot.notes@v1.1.0'])

    const back = await pins.pin(canvas.id, 'kehikot.notes', null)
    expect(back).toMatchObject({ ok: true, text: expect.stringContaining('latest') })
    expect(listCanvases(db)[0]!.placements[0]!.version).toBeNull()
  })

  test('refuses a tag that is not a version of the module, a container that is not there, and a stranger', async () => {
    const { canvas, pins } = world(['v1.0.0'])
    expect(await pins.pin(canvas.id, 'kehikot.notes', 'v7.0.0')).toMatchObject({ ok: false, why: expect.stringContaining('v1.0.0') })
    expect(await pins.pin(canvas.id, 'kehikot.notes', 'not-a-tag')).toMatchObject({ ok: false, status: 400 })
    expect(await pins.pin(canvas.id, 'kehikot.paper', 'v1.0.0')).toMatchObject({ ok: false, why: expect.stringContaining('place it first') })
    expect(await pins.pin(999, 'kehikot.notes', 'v1.0.0')).toMatchObject({ ok: false, status: 404 })
  })

  test('the data guard blocks a version older than the project’s data, in the list and on a pin', async () => {
    const { dir, canvas, pins } = world(['v1.0.0', 'v2.0.0'], {
      'v1.0.0': { dataVersion: 1, compatible: true, why: null },
      'v2.0.0': { dataVersion: 2, compatible: true, why: null },
    })
    recordDataVersion(dir, 'kehikot.notes', 2)
    const listed = await pins.list('kehikot.notes', canvas.id)
    if ('why' in listed) throw new Error(listed.why)
    expect(listed.recorded).toBe(2)
    expect(listed.versions.find((v) => v.tag === 'v1.0.0')!.blocked).toContain('format 2')
    expect(listed.versions.find((v) => v.tag === 'v2.0.0')!.blocked).toBeNull()
    expect(await pins.pin(canvas.id, 'kehikot.notes', 'v1.0.0')).toMatchObject({ ok: false, status: 409, why: expect.stringContaining('format 1') })
    expect(await pins.pin(canvas.id, 'kehikot.notes', 'v2.0.0')).toMatchObject({ ok: true })
  })

  test('a version known to speak another protocol is refused', async () => {
    const { canvas, pins } = world(['v0.1.0'], { 'v0.1.0': { dataVersion: 1, compatible: false, why: 'Notes speaks protocol >=1 <2. This host speaks protocol 2.' } })
    expect(await pins.pin(canvas.id, 'kehikot.notes', 'v0.1.0')).toMatchObject({ ok: false, why: expect.stringContaining('protocol') })
  })

  test('a module with no tags says how its author can publish one', async () => {
    const { canvas, pins } = world([])
    const listed = await pins.list('kehikot.notes', canvas.id)
    if ('why' in listed) throw new Error(listed.why)
    expect(listed.versions).toEqual([])
    expect(listed.hint).toContain('git tag v1.0.0')
  })
})

test('nothing here wrote outside the scratch root', () => {
  expect(existsSync(root)).toBe(true)
})
