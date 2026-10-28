import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { STAMP_FILE } from 'kehikot-module-protocol/build'

import { installDesk } from '../server/installs.ts'
import { openRun, startOfRun } from '../server/moduleLog.ts'
import {
  adoptedReadyBuilt,
  buildBun,
  builtAt,
  INSTALLED_MARKER,
  isUnder,
  markInstalled,
  servedAs,
  ModuleBuilds,
  olderBun,
  runBuild,
  whyNoBuilds,
  type BuildDeps,
  type Built,
  type Copy,
  type Ran,
} from '../server/moduleBuilds.ts'
import type { Official } from '../server/official.ts'
import { previewUpdate, restartDecision } from '../server/restart.ts'
import { update, type Place } from '../server/updates.ts'
import type { Ran as Runs, Runner } from '../server/versions.ts'
import { moduleRow, stateText, indicator } from '../src/host/updateModel.ts'
import { fromSourceSaid, runsAsSaid } from '../src/host/moduleBuilds.ts'
import type { Checkout } from '../src/host/updates.ts'

/*
 * An installed module is built once, here, when it is installed or updated —
 * never at a start — one build at a time, never under the running module, and
 * a build that does not finish leaves it running from source. See
 * `server/moduleBuilds.ts`.
 */

const root = mkdtempSync(join(tmpdir(), 'kehikot-builds-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let made = 0

const terminal: Copy = { id: 'kehikot.terminal', name: 'Terminal', dir: '/nowhere/terminal' }
const claude: Copy = { id: 'kehikot.claude', name: 'Claude', dir: '/nowhere/claude' }
const journeys: Copy = { id: 'kehikot.journeys', name: 'Journeys', dir: '/nowhere/journeys' }

/**
 * A fake machine: each copy is at a commit, has (or has not) a build script,
 * and has a stamp. A build stamps the commit unless told to fail, and can be
 * held open to see what runs beside it.
 */
function machine(options: { heads?: Record<string, string>; scripts?: string[]; running?: string[]; fail?: string[] } = {}) {
  const heads = new Map(Object.entries(options.heads ?? { [terminal.dir]: 'a'.repeat(40), [claude.dir]: 'b'.repeat(40), [journeys.dir]: 'c'.repeat(40) }))
  const scripts = new Set(options.scripts ?? [terminal.dir, claude.dir])
  const stamps = new Map<string, string>()
  const running = new Set(options.running ?? [])
  const fail = new Set(options.fail ?? [])
  const order: string[] = []
  const lines: string[] = []
  const finished: { id: string; built: Built }[] = []
  let now = 0
  let most = 0
  const gates = new Map<string, () => void>()
  let holding = false
  const deps: BuildDeps = {
    async build(copy, { low }) {
      order.push(`build ${copy.id}${low ? ' (low)' : ''}`)
      now += 1
      most = Math.max(most, now)
      if (holding) await new Promise<void>((open) => gates.set(copy.id, open))
      now -= 1
      if (fail.has(copy.dir)) return { ok: false, why: 'vite build exited with code 1', lines: ['error: something in src/App.tsx'] } satisfies Ran
      stamps.set(copy.dir, heads.get(copy.dir)!)
      return { ok: true, lines: [] }
    },
    head: async (dir) => heads.get(dir) ?? null,
    stamp: (dir, commit) => stamps.get(dir) === commit,
    hasScript: (dir) => scripts.has(dir),
    running: async (id) => running.has(id),
    log: (line) => lines.push(line),
    logOf: (id) => `/logs/${id}.log`,
    finished: (id, built) => finished.push({ id, built }),
  }
  const builds = new ModuleBuilds(deps)
  return {
    builds,
    order,
    lines,
    finished,
    stamps,
    heads,
    running,
    fail,
    most: () => most,
    hold: () => (holding = true),
    open: (id: string) => {
      holding = false
      gates.get(id)?.()
    },
    until: async (id: string) => {
      for (let i = 0; i < 100 && !gates.has(id); i++) await new Promise((wake) => setTimeout(wake, 1))
    },
  }
}

describe('keyed to the commit', () => {
  test('a copy whose stamp names its commit is not built again', async () => {
    const m = machine()
    expect(await m.builds.build(terminal)).toEqual({ kind: 'built', commit: 'a'.repeat(40) })
    expect(await m.builds.build(terminal)).toEqual({ kind: 'current', commit: 'a'.repeat(40) })
    expect(m.order).toEqual(['build kehikot.terminal'])
    /* Moved to another release: built for that one. */
    m.heads.set(terminal.dir, 'd'.repeat(40))
    expect((await m.builds.build(terminal)).kind).toBe('built')
    expect(m.order).toHaveLength(2)
  })

  test('a module with no build script runs from source, and nothing is run', async () => {
    const m = machine()
    expect(await m.builds.build(journeys)).toEqual({ kind: 'none' })
    expect(m.order).toEqual([])
    expect(m.builds.said()).toEqual({})
  })
})

describe('one at a time', () => {
  test('builds are queued and never run beside each other; what a person waits for goes before the background', async () => {
    const m = machine({ scripts: [terminal.dir, claude.dir, journeys.dir] })
    m.hold()
    const background = m.builds.backfill([journeys])
    await m.until(journeys.id)
    /* Asked while the background one runs: queued, not started beside it. */
    const first = m.builds.build(terminal)
    const second = m.builds.build(claude)
    expect(m.builds.state(terminal.id)).toBe('queued')
    expect(m.builds.state(journeys.id)).toBe('building')
    expect(m.builds.busy(journeys.id)).toBe(true)
    expect(m.builds.busy(terminal.id)).toBe(false)
    m.open(journeys.id)
    await Promise.all([background, first, second])
    expect(m.most()).toBe(1)
    expect(m.order).toEqual(['build kehikot.journeys (low)', 'build kehikot.terminal', 'build kehikot.claude'])
  })

  test('a copy asked for twice is built once, and a person asking lifts a background ask to its own terms', async () => {
    const m = machine()
    m.hold()
    const holding = m.builds.build(claude)
    await m.until(claude.id)
    const low = m.builds.backfill([terminal], () => true)
    const high = m.builds.build(terminal)
    m.open(claude.id)
    await holding
    await m.until(terminal.id)
    m.open(terminal.id)
    expect((await high).kind).toBe('built')
    expect((await low)[0]?.kind).toBe('built')
    expect(m.order).toEqual(['build kehikot.claude', 'build kehikot.terminal'])
  })

  test('the background queue is not news until its turn; what a person waits for is "preparing" at once', async () => {
    const m = machine({ scripts: [terminal.dir, claude.dir, journeys.dir] })
    m.hold()
    const building = m.builds.build(terminal)
    await m.until(terminal.id)
    const queued = m.builds.backfill([claude])
    expect(m.builds.said()).toEqual({ [terminal.id]: { state: 'preparing' } })
    m.open(terminal.id)
    m.hold()
    await building
    await m.until(claude.id)
    expect(m.builds.said()).toEqual({ [claude.id]: { state: 'preparing' } })
    m.open(claude.id)
    await queued
    expect(m.builds.said()).toEqual({})
  })
})

describe('never under a running module', () => {
  test('a running module is not built; it is built when it stops', async () => {
    const m = machine({ running: [terminal.id] })
    expect(await m.builds.build(terminal)).toEqual({ kind: 'deferred' })
    expect(m.order).toEqual([])
    expect(m.builds.owes(terminal.id)).toBe(true)
    m.running.delete(terminal.id)
    expect((await m.builds.stopped(terminal))?.kind).toBe('built')
    expect(m.builds.owes(terminal.id)).toBe(false)
    /* Nothing owed: a stop builds nothing. */
    expect(m.builds.stopped(terminal)).toBeNull()
  })

  test('when a build ends, whatever waited for it is decided again', async () => {
    const m = machine()
    await m.builds.build(terminal)
    expect(m.finished.map((one) => [one.id, one.built.kind])).toEqual([[terminal.id, 'built']])
  })
})

describe('failure is never fatal', () => {
  test('a build that fails leaves the module running from source, says so once, and keeps the output for its details', async () => {
    const m = machine({ fail: [terminal.dir] })
    const built = await m.builds.build(terminal)
    expect(built).toEqual({ kind: 'failed', why: 'vite build exited with code 1' })
    expect(m.builds.said()).toEqual({ [terminal.id]: { state: 'failed', why: 'vite build exited with code 1' } })
    expect(m.builds.failure(terminal.id)?.lines).toEqual(['error: something in src/App.tsx'])
    expect(m.lines).toEqual(["kehikko: Terminal runs from source; its build didn't finish: vite build exited with code 1 — its output is in /logs/kehikot.terminal.log"])
    /* An update tries again; the same commit failing again is not said twice. */
    await m.builds.build(terminal)
    expect(m.order).toHaveLength(2)
    expect(m.lines).toHaveLength(1)
    /* The background pass and a stop do not try a failed commit again. */
    await m.builds.backfill([terminal])
    expect(m.order).toHaveLength(2)
    /* Fixed in the next release: built, and the failure is forgotten. */
    m.fail.delete(terminal.dir)
    m.heads.set(terminal.dir, 'e'.repeat(40))
    expect((await m.builds.build(terminal)).kind).toBe('built')
    expect(m.builds.failure(terminal.id)).toBeNull()
    expect(m.builds.said()).toEqual({})
  })

  test('a build that finishes without stamping the commit is a failure: nothing vouches for it', async () => {
    const builds = new ModuleBuilds({
      build: async () => ({ ok: true, lines: [] }),
      head: async () => 'a'.repeat(40),
      stamp: () => false,
      hasScript: () => true,
      running: async () => false,
      log: () => {},
    })
    expect(await builds.build(terminal)).toEqual({ kind: 'failed', why: 'it finished without stamping the commit, so nothing vouches for the build' })
  })

  test('a Bun too old to serve a ready-built module: nothing is built, and it runs from source', async () => {
    const builds = new ModuleBuilds({
      build: async () => {
        throw new Error('never')
      },
      head: async () => 'a'.repeat(40),
      stamp: () => false,
      hasScript: () => true,
      running: async () => false,
      unable: () => whyNoBuilds(async () => '1.3.2', '1.4.0'),
      log: () => {},
    })
    const built = await builds.build(terminal)
    expect(built.kind).toBe('refused')
    expect(built.kind === 'refused' && built.why).toContain('the bun on this computer is 1.3.2')
  })

  test('the Updates menu says it plainly, and the details say which it runs as', () => {
    const reading: Checkout = {
      id: terminal.id,
      name: 'Terminal',
      dir: terminal.dir,
      branch: null,
      commit: 'abc1234',
      dirty: false,
      upstream: null,
      behind: 0,
      ahead: 0,
      incoming: [],
      fetchFailed: null,
      blocked: null,
    }
    const failed = moduleRow(reading, null, null, undefined, { build: { state: 'failed', why: 'vite build exited with code 1' } })
    expect(failed.state).toBe('uptodate')
    expect(failed.fromSource).toBe("Terminal runs from source; its build didn't finish (see log)")
    expect(fromSourceSaid('Terminal')).toBe(failed.fromSource!)
    const preparing = moduleRow(reading, null, null, undefined, { build: { state: 'preparing' } })
    expect(stateText(preparing)).toBe('Preparing Terminal…')
    expect(indicator([preparing])?.label).toBe('Preparing Terminal…')
    /* During an update this page pressed. */
    expect(stateText(moduleRow(reading, null, 'preparing'))).toBe('Preparing Terminal…')
    expect(runsAsSaid({ ready: true })).toBe('Ready-built')
    expect(runsAsSaid({ ready: false })).toBe('Running from source')
  })
})

describe('the existing installs', () => {
  test('the background pass builds what has a script and no stamp, low, and leaves what is wanted for its next stop', async () => {
    const m = machine({ scripts: [terminal.dir, claude.dir] })
    m.stamps.set(claude.dir, 'b'.repeat(40))
    const done = await m.builds.backfill([terminal, claude, journeys], (id) => id === terminal.id)
    /* Terminal is wanted (on the open kehikko): not built under it. Claude is current. Journeys has no script. */
    expect(done.map((one) => one.kind)).toEqual(['deferred', 'current'])
    expect(m.order).toEqual([])
    expect(m.builds.owes(terminal.id)).toBe(true)
    expect((await m.builds.stopped(terminal))?.kind).toBe('built')
    expect(m.order).toEqual(['build kehikot.terminal'])
  })

  test('one with no stamp is built in the background, at low priority', async () => {
    const m = machine()
    const done = await m.builds.backfill([terminal])
    expect(done.map((one) => one.kind)).toEqual(['built'])
    expect(m.order).toEqual(['build kehikot.terminal (low)'])
  })
})

/* ------------------------------------------------------------------ *
 * Against real repositories and a real `bun run build`.
 * ------------------------------------------------------------------ */

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
}

function git(dir: string, ...args: string[]) {
  const ran = Bun.spawnSync(['git', '-C', dir, ...args], { env })
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`)
  return ran.stdout.toString().trim()
}

/**
 * A module repository with a `build` script that stamps the commit as the
 * protocol's `buildModule` does — `dist/index.html` and `dist/.kehikot-built`
 * — or fails when `FAIL` is in its tree. Two releases.
 */
function moduleRepo() {
  const base = join(root, `m${(made += 1)}`)
  const origin = join(base, 'origin.git')
  const work = join(base, 'work')
  mkdirSync(base, { recursive: true })
  git(base, 'init', '--quiet', '--bare', '-b', 'main', origin)
  git(base, 'clone', '--quiet', origin, work)
  git(work, 'switch', '--quiet', '-c', 'main')
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'm', version: '1.0.0', scripts: { build: 'bun run build.ts' } }, null, 2))
  writeFileSync(
    join(work, 'build.ts'),
    [
      "import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'",
      "const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim()",
      "appendFileSync('builds.txt', head + '\\n')",
      "console.log('building ' + head.slice(0, 7))",
      "if (existsSync('FAIL')) { console.error('error: the page does not compile'); process.exit(1) }",
      "mkdirSync('dist', { recursive: true })",
      "writeFileSync('dist/index.html', '<!doctype html>')",
      `writeFileSync('dist/${STAMP_FILE}', head + '\\n')`,
    ].join('\n'),
  )
  writeFileSync(join(work, 'run.sh'), `#!/usr/bin/env bash\nif [ -f dist/${STAMP_FILE} ]; then exec bun run serve.ts; fi\nexec vite\n`)
  writeFileSync(join(work, '.gitignore'), 'dist\nbuilds.txt\n')
  git(work, 'add', '.')
  git(work, 'commit', '--quiet', '-m', 'one')
  git(work, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0')
  writeFileSync(join(work, 'page.txt'), 'two\n')
  git(work, 'add', '.')
  git(work, 'commit', '--quiet', '-m', 'two')
  git(work, 'tag', '-a', 'v1.1.0', '-m', 'v1.1.0')
  git(work, 'push', '--quiet', '-u', 'origin', 'main', '--tags')
  return { base, origin, work }
}

function realBuilds(logs: string) {
  mkdirSync(logs, { recursive: true })
  return new ModuleBuilds({
    build: (copy, options) => runBuild(copy, { ...options, log: join(logs, `${copy.id}.log`) }),
    head: async (dir) => git(dir, 'rev-parse', 'HEAD'),
    stamp: (dir, commit) => builtAt(dir, commit),
    hasScript: (dir) => adoptedReadyBuilt(dir),
    running: async () => false,
    log: () => {},
  })
}

const builds = (dir: string) => (existsSync(join(dir, 'builds.txt')) ? readFileSync(join(dir, 'builds.txt'), 'utf8').trim().split('\n') : [])

describe('built after an install', () => {
  test('cloned, installed, BUILT, then registered — and a build that fails is not an install that failed', async () => {
    const repo = moduleRepo()
    const installs = join(repo.base, 'installed')
    const registry = join(repo.base, 'modules')
    const logs = join(repo.base, 'logs')
    const order: string[] = []
    const real = realBuilds(logs)
    const entry: Official = { id: 'kehikot.thing', name: 'Thing', repo: 'Jalez/kehikko-thing', port: 7990, summary: 'A thing.', tags: [] }
    const run: Runner = async (argv, options): Promise<Runs> => {
      order.push(argv.slice(0, 3).join(' '))
      if (argv[1] === 'clone') {
        git(repo.base, 'clone', '--quiet', repo.origin, argv[argv.length - 1]!)
        git(argv[argv.length - 1]!, 'checkout', '--quiet', '--detach', 'refs/tags/v1.1.0')
      }
      void options
      return { ok: true, out: '' }
    }
    const desk = installDesk({
      list: [entry],
      run,
      root: installs,
      registry,
      registered: async () => (existsSync(registry) ? readdirSync(registry).map((name) => ({ id: name.replace(/\.json$/, ''), port: null })) : []),
      build: async (copy) => {
        order.push(`build ${copy.id} (registered: ${existsSync(join(registry, `${copy.id}.json`))})`)
        return real.build(copy)
      },
    })
    await desk.install(entry.id)
    for (let i = 0; i < 400 && !(await desk.list())[0]?.installed; i++) await new Promise((wake) => setTimeout(wake, 10))
    expect(order).toEqual(['git clone --quiet', `${process.execPath} install --frozen-lockfile`, 'build kehikot.thing (registered: false)'])
    const dir = join(installs, entry.id)
    expect(builtAt(dir, git(dir, 'rev-parse', 'HEAD'))).toBe(true)
    expect(readFileSync(join(logs, 'kehikot.thing.log'), 'utf8')).toContain('building ')

    /* The same, for a release whose build fails: installed and registered all the same. */
    const failing = moduleRepo()
    writeFileSync(join(failing.work, 'FAIL'), '')
    git(failing.work, 'add', '.')
    git(failing.work, 'commit', '--quiet', '-m', 'broken')
    git(failing.work, 'push', '--quiet')
    const other = installDesk({
      list: [entry],
      run: async (argv) => {
        if (argv[1] === 'clone') git(failing.base, 'clone', '--quiet', failing.origin, argv[argv.length - 1]!)
        return { ok: true, out: '' }
      },
      root: join(failing.base, 'installed'),
      registry: join(failing.base, 'modules'),
      registered: async () => (existsSync(join(failing.base, 'modules', `${entry.id}.json`)) ? [{ id: entry.id, port: null }] : []),
      build: (copy) => realBuilds(join(failing.base, 'logs')).build(copy),
    })
    await other.install(entry.id)
    let row = (await other.list())[0]
    for (let i = 0; i < 400 && !row?.installed && row?.install?.state !== 'failed'; i++) {
      await new Promise((wake) => setTimeout(wake, 10))
      row = (await other.list())[0]
    }
    expect(row?.installed).toBe(true)
    expect(existsSync(join(failing.base, 'installed', entry.id, 'dist', STAMP_FILE))).toBe(false)
  }, 30_000)
})

describe('built after an update', () => {
  test('the copy is built for the release it moved to, after its checkout and install; the next update of nothing builds nothing', async () => {
    const repo = moduleRepo()
    const copy = join(repo.base, 'installed', 'kehikot.thing')
    git(repo.base, 'clone', '--quiet', repo.origin, copy)
    git(copy, 'checkout', '--quiet', '--detach', 'refs/tags/v1.0.0')
    const real = realBuilds(join(repo.base, 'logs'))
    const phases: string[] = []
    const place: Place = {
      id: 'kehikot.thing',
      name: 'Thing',
      dir: copy,
      /* As a release follower would: v1.0.0 → v1.1.0. */
      releases: {
        overlay: async (_place, checkout) => ({
          ...checkout,
          release: { follows: 'release', installed: 'v1.0.0', newest: 'v1.1.0', target: git(copy, 'describe', '--tags', '--exact-match') === 'v1.1.0' ? null : 'v1.1.0', notes: [], needsNewer: null, repo: null, error: null },
          blocked: null,
        }),
        settle: async () => ({ ok: true, tag: null }),
      },
      build: (one) => real.build({ id: one.id, name: one.name, dir: one.dir }),
    }
    const done = await update(place, undefined, { merged: () => void phases.push('merged'), preparing: () => phases.push('preparing') })
    expect(done.ok).toBe(true)
    expect(done.ok && done.built).toBe('built')
    expect(phases).toEqual(['merged', 'preparing'])
    const head = git(copy, 'rev-parse', 'HEAD')
    expect(git(copy, 'rev-parse', 'refs/tags/v1.1.0^{commit}')).toBe(head)
    expect(builtAt(copy, head)).toBe(true)
    expect(builds(copy)).toEqual([head])
    /* Asked again with nothing new: the stamp names the commit, nothing runs. */
    expect((await real.build({ id: 'kehikot.thing', name: 'Thing', dir: copy })).kind).toBe('current')
    expect(builds(copy)).toEqual([head])
  }, 30_000)

  test('a checkout somebody edits is updated and never built: it keeps Vite', async () => {
    const repo = moduleRepo()
    const mine = join(repo.base, 'mine')
    git(repo.base, 'clone', '--quiet', repo.origin, mine)
    git(mine, 'reset', '--quiet', '--hard', 'HEAD~1')
    const place: Place = { id: 'kehikot.thing', name: 'Thing', dir: mine }
    const done = await update(place)
    expect(done.ok).toBe(true)
    expect(done.ok && done.built).toBeUndefined()
    expect(builds(mine)).toEqual([])
    /* Only a copy under the installs directory is an installed one. */
    expect(isUnder(mine, join(repo.base, 'installed'))).toBe(false)
    expect(isUnder(join(repo.base, 'installed', 'kehikot.thing'), join(repo.base, 'installed'))).toBe(true)
  }, 30_000)

  test('a ready-built copy is restarted on any change: its page is the build, not a page that reloads itself', () => {
    expect(restartDecision(['src/App.tsx'], new Set()).restart).toBe(false)
    expect(restartDecision(['src/App.tsx'], new Set(), true)).toEqual({ restart: true, because: ['src/App.tsx'] })
    expect(previewUpdate(['src/App.tsx'], new Set(), { running: true, keep: false, ready: true })).toBe('restart')
    expect(previewUpdate(['src/App.tsx'], new Set(), { running: true, keep: false })).toBe('page')
  })
})

describe('none at start', () => {
  /* What starts a module — `begin`, `run`, `start` — never builds; `begin`
     only waits for a build already under way of that one module. */
  const server = readFileSync(join(import.meta.dir, '..', 'server', 'server.ts'), 'utf8')
  const body = (name: string) => {
    const at = server.indexOf(`\nfunction ${name}(`)
    expect(at).toBeGreaterThan(-1)
    return server.slice(at, server.indexOf('\n}\n', at))
  }

  test('starting a module builds nothing', () => {
    for (const name of ['begin', 'run']) {
      const code = body(name)
      expect(code).not.toMatch(/builds\.(build|backfill|stopped)\(|buildPlace\(|runBuild\(/)
    }
    expect(body('begin')).toContain('builds.busy(id)')
    const launch = readFileSync(join(import.meta.dir, '..', 'server', 'launch.ts'), 'utf8')
    expect(launch).not.toContain('moduleBuilds')
  })

  test("a module's details read what the process the host started said, and the disk only for one it did not start", () => {
    const at = server.indexOf('\nasync function buildOf(')
    const code = server.slice(at, server.indexOf('\n}\n', at))
    expect(code).toContain('const started = nursery.holds(id)')
    expect(code).toContain('started ? servedAs(startOfRun(logFile(id))')
    expect(code).toMatch(/served !== null \? served === 'built' : head !== null && builtAt\(dir, head\)/)
  })
})

describe('the Bun it is built with', () => {
  test('a ready-built module needs Bun 1.4.0', () => {
    expect(olderBun('1.3.9')).toBe(true)
    expect(olderBun('1.4.0')).toBe(false)
    expect(olderBun('1.5.2')).toBe(false)
    expect(olderBun('not a version')).toBe(true)
    expect(olderBun('1.4.0-canary.1')).toBe(true)
    expect(olderBun('1.10.0')).toBe(false)
  })

  test('this Bun, and the one on the path, are both asked', async () => {
    expect(await whyNoBuilds(async () => '1.4.0', '1.3.0')).toContain('this Kehikot runs on Bun 1.3.0')
    expect(await whyNoBuilds(async () => '1.4.1', '1.4.0')).toBeNull()
    expect(await whyNoBuilds(async () => null, '1.4.0')).toBeNull()
  })

  test("a host that is bun builds with itself; a compiled one puts a bun that is itself first on the build's path", () => {
    expect(buildBun('/opt/bun/bin/bun', '/usr/bin')).toEqual({ bun: '/opt/bun/bin/bun', env: { PATH: '/opt/bun/bin:/usr/bin', KEHIKOT_HOST_PATH: '/opt/bun/bin' } })
    const compiled = buildBun('/Applications/Kehikot.app/Contents/MacOS/kehikko-host', '/usr/bin')
    expect(compiled.bun).toBe('/Applications/Kehikot.app/Contents/MacOS/kehikko-host')
    expect(compiled.env.BUN_BE_BUN).toBe('1')
    expect(compiled.env.PATH?.endsWith(':/usr/bin')).toBe(true)
    const shim = compiled.env.PATH!.split(':')[0]!
    expect(compiled.env.KEHIKOT_HOST_PATH).toBe(shim)
    expect(readlinkSync(join(shim, 'bun'))).toBe('/Applications/Kehikot.app/Contents/MacOS/kehikko-host')
    rmSync(shim, { recursive: true, force: true })
  })
})

/* ------------------------------------------------------------------ *
 * The install marker a module's run.sh reads, and what a running
 * process says it serves.
 * ------------------------------------------------------------------ */

/** The exact test Terminal's, Claude's and the template's run.sh make before they install: true means "install again". */
function runShWouldInstall(dir: string): boolean {
  const test = '[ ! -d node_modules ] || [ ! -f "$INSTALLED" ] || [ bun.lock -nt "$INSTALLED" ] || [ package.json -nt "$INSTALLED" ]'
  const ran = Bun.spawnSync(['bash', '-c', `INSTALLED=node_modules/.kehikot-installed; ${test}`], { cwd: dir })
  return ran.exitCode === 0
}

describe("the install marker run.sh reads", () => {
  test('is the file run.sh touches, and once the host has written it a start does not install again', () => {
    expect(INSTALLED_MARKER).toBe('node_modules/.kehikot-installed')
    const dir = join(root, `marker${(made += 1)}`)
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{}')
    writeFileSync(join(dir, 'bun.lock'), '{}')
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(dir, 'package.json'), past, past)
    utimesSync(join(dir, 'bun.lock'), past, past)
    expect(runShWouldInstall(dir)).toBe(true)
    expect(markInstalled(dir)).toBe(true)
    expect(readFileSync(join(dir, INSTALLED_MARKER), 'utf8')).toBe('')
    expect(runShWouldInstall(dir)).toBe(false)
    /* A lockfile that moves after it: run.sh installs again, as it should. */
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(dir, 'bun.lock'), later, later)
    expect(runShWouldInstall(dir)).toBe(true)
    expect(markInstalled(dir, new Date(Date.now() + 120_000))).toBe(true)
    expect(runShWouldInstall(dir)).toBe(false)
  })

  test('nothing installed, nothing marked', () => {
    const dir = join(root, `marker${(made += 1)}`)
    mkdirSync(dir, { recursive: true })
    expect(markInstalled(dir)).toBe(false)
    expect(existsSync(join(dir, INSTALLED_MARKER))).toBe(false)
  })

  test("an install writes it after its bun install, so the module's first start does not install again", async () => {
    const base = join(root, `install${(made += 1)}`)
    const registry = join(base, 'modules')
    const entry: Official = { id: 'kehikot.thing', name: 'Thing', repo: 'Jalez/kehikko-thing', port: 7990, summary: 'A thing.', tags: [] }
    const desk = installDesk({
      list: [entry],
      run: async (argv, options) => {
        if (argv[1] === 'clone') {
          const dir = argv[argv.length - 1]!
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'package.json'), '{}')
          writeFileSync(join(dir, 'bun.lock'), '{}')
        }
        /* What bun install leaves. */
        if (argv[1] === 'install') mkdirSync(join(options!.cwd!, 'node_modules'), { recursive: true })
        return { ok: true, out: '' }
      },
      root: join(base, 'installed'),
      registry,
      registered: async () => (existsSync(join(registry, `${entry.id}.json`)) ? [{ id: entry.id, port: null }] : []),
    })
    await desk.install(entry.id)
    for (let i = 0; i < 200 && !(await desk.list())[0]?.installed; i++) await new Promise((wake) => setTimeout(wake, 5))
    const dir = join(base, 'installed', entry.id)
    expect(existsSync(join(dir, INSTALLED_MARKER))).toBe(true)
    expect(runShWouldInstall(dir)).toBe(false)
  })

  test("an update of an installed copy installs from the release's lockfile, frozen, and marks it; an edited checkout is not marked", async () => {
    const make = () => {
      const base = join(root, `upd${(made += 1)}`)
      const origin = join(base, 'origin.git')
      const work = join(base, 'work')
      mkdirSync(base, { recursive: true })
      git(base, 'init', '--quiet', '--bare', '-b', 'main', origin)
      git(base, 'clone', '--quiet', origin, work)
      git(work, 'switch', '--quiet', '-c', 'main')
      mkdirSync(join(work, 'dep'), { recursive: true })
      writeFileSync(join(work, 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }))
      writeFileSync(join(work, '.gitignore'), 'node_modules\n')
      writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'm', version: '1.0.0', dependencies: { dep: 'file:./dep' } }))
      expect(Bun.spawnSync(['bun', 'install'], { cwd: work }).exitCode).toBe(0)
      git(work, 'add', '.')
      git(work, 'commit', '--quiet', '-m', 'one')
      git(work, 'push', '--quiet', '-u', 'origin', 'main')
      const here = join(base, 'here')
      git(base, 'clone', '--quiet', origin, here)
      writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'm', version: '1.1.0', description: 'two', dependencies: { dep: 'file:./dep' } }))
      git(work, 'add', '.')
      git(work, 'commit', '--quiet', '-m', 'two')
      git(work, 'push', '--quiet')
      git(here, 'fetch', '--quiet')
      return here
    }
    /* An installed copy: its place builds (here, nothing to build). */
    const copy = make()
    const done = await update({ id: 'kehikot.thing', name: 'Thing', dir: copy, build: async () => ({ kind: 'none' }) })
    expect(done.ok && done.installed).toBe(true)
    expect(existsSync(join(copy, INSTALLED_MARKER))).toBe(true)
    expect(runShWouldInstall(copy)).toBe(false)
    expect(git(copy, 'status', '--porcelain', '--untracked-files=no')).toBe('')
    /* Somebody's own checkout: installed as before, and its run.sh keeps its own marker. */
    const mine = make()
    const theirs = await update({ id: 'kehikot.thing', name: 'Thing', dir: mine })
    expect(theirs.ok && theirs.installed).toBe(true)
    expect(existsSync(join(mine, INSTALLED_MARKER))).toBe(false)
  }, 30_000)
})

describe('"Ready-built" is what is running', () => {
  test("read from what the process said at its start: the protocol's run names the build it serves", () => {
    expect(servedAs(['installing…', 'kehikot.terminal serves its built page on http://127.0.0.1:7920/app (31203b5)'], true)).toBe('built')
    expect(servedAs(['kehikot.terminal: NOT serving the built page. It is stale.', 'kehikot.terminal serves its built page on http://127.0.0.1:7920/app — refused, see above'], true)).toBe('source')
    /* Vite says nothing of the sort. */
    expect(servedAs(['  VITE v6.3.5  ready in 312 ms', '  ➜  Local:   http://127.0.0.1:7920/'], true)).toBe('source')
    /* Still starting, nothing said yet: not known. */
    expect(servedAs([], false)).toBeNull()
  })

  test("the start of this run is read, however long it has gone on", () => {
    const file = join(root, `log${(made += 1)}`, 'kehikot.terminal.log')
    openRun(file, new Date(0))
    appendFileSync(file, 'an older run served from source\n')
    openRun(file, new Date(1))
    appendFileSync(file, 'kehikot.terminal serves its built page on http://127.0.0.1:7920/app (31203b5)\n')
    for (let i = 0; i < 2000; i++) appendFileSync(file, `terminal: a shell said line ${i} of a long session\n`)
    expect(statSync(file).size).toBeGreaterThan(32 * 1024)
    expect(servedAs(startOfRun(file), true)).toBe('built')
    expect(startOfRun(file)).not.toContain('an older run served from source')
  })
})

describe('only modules that adopted ready-built copies are built', () => {
  const copy = (files: Record<string, string>) => {
    const dir = join(root, `adopt-${(made += 1)}`)
    mkdirSync(dir, { recursive: true })
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    return dir
  }
  const pkg = JSON.stringify({ scripts: { build: 'vite build' } })

  test('a plain old build script is not adoption; a build plus a run.sh that checks the stamp is', () => {
    expect(adoptedReadyBuilt(copy({ 'package.json': pkg }))).toBe(false)
    expect(adoptedReadyBuilt(copy({ 'package.json': pkg, 'run.sh': 'exec vite\n' }))).toBe(false)
    expect(adoptedReadyBuilt(copy({ 'run.sh': `[ -f dist/${STAMP_FILE} ]`, 'package.json': '{}' }))).toBe(false)
    expect(adoptedReadyBuilt(copy({ 'package.json': pkg, 'run.sh': `[ -f dist/${STAMP_FILE} ] && exec bun run serve.ts` }))).toBe(true)
  })

  test('an old build script is never run and says nothing; an adopter is built; a stale failure is dropped', async () => {
    const old = copy({ 'package.json': pkg, 'run.sh': 'exec vite\n' })
    const adopter = copy({ 'package.json': pkg, 'run.sh': `[ -f dist/${STAMP_FILE} ]` })
    const ran: string[] = []
    let failing = true
    const deps: BuildDeps = {
      build: async (c) => {
        ran.push(c.dir)
        return failing ? { ok: false, why: 'exited with code 1', lines: [] } : { ok: true, lines: [] }
      },
      head: async () => 'a'.repeat(40),
      stamp: () => false,
      hasScript: (dir) => adoptedReadyBuilt(dir),
      running: async () => false,
      log: () => {},
    }
    const builds = new ModuleBuilds(deps)
    const a: Copy = { id: 'kehikot.journeys', name: 'Journeys', dir: old }
    const b: Copy = { id: 'kehikot.terminal', name: 'Terminal', dir: adopter }
    /* 0.1.55 recorded a failure for the old one: the same id, now judged by what it adopted. */
    await builds.build({ ...a, dir: adopter })
    expect(builds.said()[a.id]).toEqual({ state: 'failed', why: 'exited with code 1' })
    await builds.backfill([a, b])
    expect(ran).toEqual([adopter, adopter])
    expect(builds.said()[a.id]).toBeUndefined()
    expect(builds.failure(a.id)).toBeNull()
    expect(await builds.build(a)).toEqual({ kind: 'none' })
    failing = false
    expect((await builds.build(b)).kind).toBe('failed')
    expect(ran.filter((dir) => dir === old)).toEqual([])
  })
})
