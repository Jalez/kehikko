import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Ran as GhRan, Runner as GhRunner } from '../server/feedback.ts'
import { PAGE_ONLY, refusal, type Own } from '../server/guard.ts'
import { installDesk, MINE_PORT_FLOOR, minePort, portForMine } from '../server/installs.ts'
import { myModulesFile } from '../server/machineDirs.ts'
import { mcp } from '../server/mcp.ts'
import { describeModule, myModulesDesk, readMine, whereOf, type Mine } from '../server/myModules.ts'
import type { Official } from '../server/official.ts'
import { readRegistration } from '../server/registrations.ts'
import type { Ran, Runner } from '../server/versions.ts'

/*
 * "My modules": a module installed from a repository that is on no official
 * list. Against fake runners — the real ones would ask GitHub and clone — and
 * scratch directories only. What matters: nothing is written before the
 * repository has been read and found to be a module, an official repository is
 * installed as the official module, a personal module goes through the same
 * install path and never takes an official port, Remove deletes only what the
 * host installed, a hand-installed checkout is kept only on a press, every
 * write is the page's alone, and the list goes nowhere.
 */

const slides: Official = { id: 'kehikot.slides', name: 'Slides', repo: 'Jalez/kehikko-slides', port: 7990, summary: 'Decks.', tags: ['writing'] }
const browser: Official = { id: 'kehikot.browser', name: 'Browser', repo: 'Jalez/kehikko-browser', port: 8020, summary: 'A browser.', tags: ['code'] }
/* An official entry on the personal grid, to prove a personal module steps over it. */
const high: Official = { id: 'kehikot.high', name: 'High', repo: 'Jalez/kehikko-high', port: 9000, summary: 'High.', tags: [] }

const MANIFEST = `import { MANIFEST_KIND, PROTOCOL, manifestSchema, type Manifest } from 'kehikot-module-protocol'

export const ID = 'kehikot.flows'
export const VERSION = '0.2.0'
export const PREFERRED_PORT = 8000

export const MANIFEST: Manifest = manifestSchema.parse({
  kind: MANIFEST_KIND,
  protocol: PROTOCOL,
  id: ID,
  name: 'Flows',
  version: VERSION,
  summary: 'Diagrams of an epic’s architecture, ' + "written to be walked through one stage at a time.",
  tags: ['reading', 'Not A Tag'],
  modes: [{ id: 'flows', label: 'Flows', scope: 'epic' }],
})
`
const pkg = (protocol = '2.6.0') =>
  JSON.stringify({ name: 'kehikko-flows', dependencies: { 'kehikot-module-protocol': `git+ssh://git@github.com/Jalez/kehikko-protocol.git#v${protocol}` } })

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** What the fake `gh`/`glab` answers: per endpoint, a body, or a failure. */
type Answers = Record<string, string | { code: number; err: string }>

function world(
  options: {
    answers?: Answers
    git?: (argv: readonly string[]) => Ran
    official?: Official[]
    registered?: Array<{ id: string; url: string; dir?: string }>
    protocol?: string
  } = {},
) {
  const base = mkdtempSync(join(tmpdir(), 'kehikot-mine-'))
  scratch.push(base)
  const root = join(base, 'installed')
  const registry = join(base, 'modules')
  const file = join(base, 'my-modules.json')
  const official = options.official ?? [slides, browser]
  const asked: string[][] = []
  const gitCalls: { argv: readonly string[]; cwd?: string }[] = []
  const stopped: string[] = []
  const changed: string[] = []
  const answers = options.answers ?? {}

  const gh: GhRunner = async (argv) => {
    asked.push(argv)
    /* The endpoint is the last argument for both CLIs. */
    const endpoint = argv[argv.length - 1]!
    const answer = answers[endpoint]
    const ran: GhRan =
      answer === undefined
        ? { code: 1, out: '', err: 'gh: Not Found (HTTP 404)' }
        : typeof answer === 'string'
          ? { code: 0, out: answer, err: '' }
          : { code: answer.code, out: '', err: answer.err }
    return ran
  }
  const git: Runner = async (argv, opts) => {
    gitCalls.push({ argv, cwd: opts?.cwd })
    const ran = options.git?.(argv) ?? { ok: true as const, out: '' }
    if (ran.ok && argv[1] === 'clone') mkdirSync(argv[argv.length - 1]!, { recursive: true })
    return ran
  }

  const registrations = async () => [
    ...(options.registered ?? []),
    ...(existsSync(registry)
      ? readdirSync(registry)
          .filter((name) => name.endsWith('.json'))
          .map((name) => {
            const read = JSON.parse(readFileSync(join(registry, name), 'utf8')) as { url: string; dir?: string }
            return { id: name.replace(/\.json$/, ''), url: read.url, dir: read.dir }
          })
      : []),
  ]
  const portOf = (url: string) => Number(new URL(url).port) || null

  const desk = installDesk({
    list: () => official,
    run: git,
    root,
    registry,
    protocol: options.protocol ?? '2.10.0',
    registered: async () => (await registrations()).map((one) => ({ id: one.id, port: portOf(one.url), dir: one.dir })),
  })
  const mine = myModulesDesk({
    file,
    official: () => official,
    desk,
    run: gh,
    git,
    root,
    registry,
    registered: registrations,
    stop: (id) => stopped.push(id),
    changed: () => changed.push('registry'),
    protocol: options.protocol ?? '2.10.0',
    now: () => new Date('2026-10-21T12:00:00Z'),
  })
  return { desk, mine, asked, gitCalls, stopped, changed, root, registry, file, base }
}

/** A readable GitHub repository holding a module. */
const flowsRepo = (protocol?: string, extra: Answers = {}): Answers => ({
  'repos/jaakkorajalasol/kehikko-flows': JSON.stringify({ full_name: 'jaakkorajalasol/kehikko-flows', private: true, default_branch: 'main' }),
  'repos/jaakkorajalasol/kehikko-flows/contents/manifest.ts': MANIFEST,
  'repos/jaakkorajalasol/kehikko-flows/contents/package.json': pkg(protocol),
  ...extra,
})

async function settled(w: ReturnType<typeof world>, id: string) {
  for (let i = 0; i < 200; i++) {
    const row = (await w.mine.list()).modules.find((one) => one.id === id)
    if (row && (row.installed || row.install?.state === 'failed')) return row
    await new Promise((done) => setTimeout(done, 5))
  }
  throw new Error('the install never settled')
}

const post = (w: ReturnType<typeof world>, path: string, body: unknown) =>
  w.mine.route(new Request(`http://h${path}`, { method: 'POST', body: JSON.stringify(body) }), new URL(`http://h${path}`))

describe('reading what a repository holds', () => {
  test('the id, name, summary and tags out of manifest.ts, and the protocol it pins out of package.json — never run', () => {
    expect(describeModule(MANIFEST, pkg('2.6.0'))).toEqual({
      ok: true,
      id: 'kehikot.flows',
      name: 'Flows',
      summary: 'Diagrams of an epic’s architecture, written to be walked through one stage at a time.',
      tags: ['reading'],
      protocol: '2.6.0',
    })
    expect(describeModule(MANIFEST, JSON.stringify({ dependencies: { 'kehikot-module-protocol': '^2.3.1' } }))).toMatchObject({ ok: true, protocol: '2.3.1' })
  })

  test('what is not a module is said to be not one', () => {
    expect(describeModule('export const x = 1', pkg())).toMatchObject({ ok: false, why: expect.stringContaining('not a Kehikot module') })
    expect(describeModule(MANIFEST, JSON.stringify({ dependencies: {} }))).toMatchObject({ ok: false, why: expect.stringContaining('does not depend') })
    expect(describeModule(MANIFEST, null)).toMatchObject({ ok: false })
    expect(describeModule(MANIFEST.replace("'kehikot.flows'", "'../../etc'"), pkg())).toMatchObject({ ok: false, why: expect.stringContaining('not a module id') })
  })

  test('owner/repo is GitHub; a GitLab link keeps its groups; anything else is refused', () => {
    expect(whereOf('jaakkorajalasol/kehikko-flows')).toEqual({ ok: true, where: { tracker: 'github', host: 'github.com', repo: 'jaakkorajalasol/kehikko-flows' } })
    expect(whereOf('https://github.com/jaakkorajalasol/kehikko-flows/pulls')).toMatchObject({ ok: true, where: { repo: 'jaakkorajalasol/kehikko-flows' } })
    expect(whereOf('https://gitlab.com/group/sub/thing.git')).toEqual({ ok: true, where: { tracker: 'gitlab', host: 'gitlab.com', repo: 'group/sub/thing' } })
    expect(whereOf('https://example.org/a/b')).toMatchObject({ ok: false })
    expect(whereOf('--upload-pack=x/y')).toMatchObject({ ok: false })
    expect(whereOf('../../etc')).toMatchObject({ ok: false })
  })
})

describe('adding a repository', () => {
  test('a readable module is shown before anything is written', async () => {
    const w = world({ answers: flowsRepo() })
    const checked = await w.mine.check('https://github.com/jaakkorajalasol/kehikko-flows')
    expect(checked).toEqual({
      ok: true,
      kind: 'mine',
      id: 'kehikot.flows',
      name: 'Flows',
      summary: 'Diagrams of an epic’s architecture, written to be walked through one stage at a time.',
      tags: ['reading'],
      repo: 'jaakkorajalasol/kehikko-flows',
      host: 'github.com',
      protocol: '2.6.0',
      private: true,
    })
    /* Read with the person's gh, as them; nothing cloned, nothing written. */
    expect(w.asked.every((argv) => argv[0] === 'gh' && argv[1] === 'api')).toBe(true)
    expect(w.gitCalls).toEqual([])
    expect(existsSync(w.file)).toBe(false)
    expect(existsSync(w.registry)).toBe(false)
  })

  test('adding writes the entry and installs it through the shared path, on a port from 9000 up', async () => {
    const w = world({ answers: flowsRepo() })
    const added = await post(w, '/host/mine/add', { repo: 'jaakkorajalasol/kehikko-flows' })
    expect(added?.status).toBe(202)
    const row = await settled(w, 'kehikot.flows')
    expect(row).toMatchObject({ installed: true, mine: true, host: 'github.com', repo: 'jaakkorajalasol/kehikko-flows' })

    const dir = join(w.root, 'kehikot.flows')
    /* Every call that fetches or runs anything; the list reads the checkout's remote afterwards, to say where it is from. */
    expect(w.gitCalls.map((call) => call.argv.join(' ')).filter((one) => !one.endsWith('remote get-url origin'))).toEqual([
      `git clone --quiet https://github.com/jaakkorajalasol/kehikko-flows.git ${dir}`,
      'bun install --frozen-lockfile',
    ])
    expect(readRegistration('kehikot.flows.json', readFileSync(join(w.registry, 'kehikot.flows.json'), 'utf8'))).toEqual({
      ok: true,
      registration: { id: 'kehikot.flows', url: 'http://127.0.0.1:9000', dir },
    })
    expect(readMine(w.file)).toEqual({
      broken: null,
      modules: [
        {
          id: 'kehikot.flows',
          name: 'Flows',
          repo: 'jaakkorajalasol/kehikko-flows',
          host: 'github.com',
          port: 9000,
          summary: 'Diagrams of an epic’s architecture, written to be walked through one stage at a time.',
          tags: ['reading'],
          protocol: '2.6.0',
          added: '2026-10-21',
        },
      ],
    })
  })

  test('a repository this login cannot read is refused, and nothing is written or cloned', async () => {
    const w = world({ answers: { 'repos/someone/secret': { code: 1, err: 'gh: Not Found (HTTP 404)' } } })
    const answered = await post(w, '/host/mine/add', { repo: 'someone/secret' })
    expect(answered?.status).toBe(422)
    expect((await answered!.json()).error).toContain('someone/secret could not be read with your login')
    const notLoggedIn = world({ answers: { 'repos/someone/secret': { code: 4, err: 'To get started with GitHub CLI, please run:  gh auth login' } } })
    expect(await notLoggedIn.mine.check('someone/secret')).toMatchObject({ ok: false, why: expect.stringContaining('gh auth login') })
    for (const one of [w, notLoggedIn]) {
      expect(one.gitCalls).toEqual([])
      expect(existsSync(one.file)).toBe(false)
    }
  })

  test('a repository with no module in it is refused, and nothing is written', async () => {
    const empty = world({ answers: { 'repos/someone/plain': JSON.stringify({ full_name: 'someone/plain', private: false }) } })
    expect(await empty.mine.check('someone/plain')).toMatchObject({ ok: false, status: 422, why: expect.stringContaining('has no manifest.ts') })
    const notOurs = world({
      answers: {
        'repos/someone/other': JSON.stringify({ full_name: 'someone/other', private: false }),
        'repos/someone/other/contents/manifest.ts': 'export const MANIFEST = { name: "x" }',
        'repos/someone/other/contents/package.json': '{}',
      },
    })
    expect(await notOurs.mine.add('someone/other')).toMatchObject({ ok: false, why: expect.stringContaining('not a Kehikot module') })
    for (const one of [empty, notOurs]) {
      expect(one.gitCalls).toEqual([])
      expect(existsSync(one.file)).toBe(false)
    }
  })

  test('a repository on the official list is installed as the official module, and My modules is not written', async () => {
    const w = world()
    expect(await w.mine.check('https://github.com/jalez/kehikko-slides')).toEqual({
      ok: true,
      kind: 'official',
      id: 'kehikot.slides',
      name: 'Slides',
      summary: 'Decks.',
      repo: 'Jalez/kehikko-slides',
      installed: false,
    })
    /* Known without asking GitHub. */
    expect(w.asked).toEqual([])
    expect(await w.mine.add('Jalez/kehikko-slides')).toEqual({ ok: true, id: 'kehikot.slides', official: true })
    for (let i = 0; i < 200 && !existsSync(join(w.registry, 'kehikot.slides.json')); i++) await new Promise((done) => setTimeout(done, 5))
    expect(JSON.parse(readFileSync(join(w.registry, 'kehikot.slides.json'), 'utf8')).url).toBe('http://127.0.0.1:7990')
    expect(existsSync(w.file)).toBe(false)
  })

  test('a module that calls itself by an official id is refused', async () => {
    const w = world({
      answers: {
        'repos/someone/fake-slides': JSON.stringify({ full_name: 'someone/fake-slides', private: false }),
        'repos/someone/fake-slides/contents/manifest.ts': MANIFEST.replace("'kehikot.flows'", "'kehikot.slides'"),
        'repos/someone/fake-slides/contents/package.json': pkg(),
      },
    })
    expect(await w.mine.add('someone/fake-slides')).toMatchObject({ ok: false, status: 409, why: expect.stringContaining('official Slides') })
    expect(existsSync(w.file)).toBe(false)
  })

  test('the same protocol check as an official entry: one that needs a newer Kehikot is shown and not added', async () => {
    const w = world({ answers: flowsRepo('9.0.0') })
    expect(await w.mine.check('jaakkorajalasol/kehikko-flows')).toMatchObject({ ok: true, newer: { protocol: '9.0.0', has: '2.10.0' } })
    expect(await w.mine.add('jaakkorajalasol/kehikko-flows')).toMatchObject({ ok: false, status: 409, why: expect.stringContaining('needs a newer Kehikot') })
    expect(w.gitCalls).toEqual([])
    expect(existsSync(w.file)).toBe(false)
  })

  test('a module from a GitLab is read with glab and cloned from its host', async () => {
    const project = encodeURIComponent('group/sub/flows')
    const w = world({
      answers: {
        [`projects/${project}`]: JSON.stringify({ path_with_namespace: 'group/sub/flows', default_branch: 'main', visibility: 'private' }),
        [`projects/${project}/repository/files/manifest.ts/raw?ref=main`]: MANIFEST,
        [`projects/${project}/repository/files/package.json/raw?ref=main`]: pkg(),
      },
    })
    expect(await w.mine.add('https://gitlab.com/group/sub/flows')).toMatchObject({ ok: true, id: 'kehikot.flows' })
    expect(w.asked.every((argv) => argv.slice(0, 4).join(' ') === 'glab api --hostname gitlab.com')).toBe(true)
    expect((await settled(w, 'kehikot.flows')).installed).toBe(true)
    expect(w.gitCalls[0]!.argv.join(' ')).toBe(`git clone --quiet https://gitlab.com/group/sub/flows.git ${join(w.root, 'kehikot.flows')}`)
  })
})

describe('installing and updating through the shared path', () => {
  test('a failed install is a sentence; Install again brings the clone level first, then registers', async () => {
    let installs = 0
    const w = world({
      answers: flowsRepo(),
      git: (argv) => {
        if (argv[0] === 'bun') return ++installs === 1 ? { ok: false, why: 'lockfile is frozen' } : { ok: true, out: '' }
        if (argv.includes('get-url')) return { ok: true, out: 'git@github.com:jaakkorajalasol/kehikko-flows.git' }
        return { ok: true, out: '' }
      },
    })
    await w.mine.add('jaakkorajalasol/kehikko-flows')
    expect((await settled(w, 'kehikot.flows')).install).toEqual({
      state: 'failed',
      why: 'Flows was cloned, and its dependencies could not be installed: lockfile is frozen',
    })
    expect((await post(w, '/host/mine/install', { module: 'kehikot.flows' }))?.status).toBe(202)
    expect((await settled(w, 'kehikot.flows')).installed).toBe(true)
    const said = w.gitCalls.map((call) => call.argv.join(' '))
    const pull = said.indexOf(`git -C ${join(w.root, 'kehikot.flows')} pull --ff-only --quiet`)
    expect(pull).toBeGreaterThan(-1)
    expect(pull).toBeLessThan(said.lastIndexOf('bun install --frozen-lockfile'))
    expect(said.filter((one) => one.startsWith('git clone'))).toHaveLength(1)
  })

  test('the repository comes from the list, never from the request', async () => {
    const w = world({ answers: flowsRepo() })
    const answered = await post(w, '/host/mine/install', { module: 'kehikot.flows', repo: 'evil/thing', dir: '/tmp/x' })
    expect(answered?.status).toBe(404)
    expect(w.gitCalls).toEqual([])
  })

  test('an installed module is under the folder the host levels before starting (installed/<id>)', async () => {
    const w = world({ answers: flowsRepo() })
    await w.mine.add('jaakkorajalasol/kehikko-flows')
    await settled(w, 'kehikot.flows')
    expect(JSON.parse(readFileSync(join(w.registry, 'kehikot.flows.json'), 'utf8')).dir).toBe(join(w.root, 'kehikot.flows'))
  })
})

describe('the port a personal module is given', () => {
  test('from 9000 up, never one the official list names or one that is taken', () => {
    expect(MINE_PORT_FLOOR).toBe(9000)
    expect(minePort([])).toBe(9000)
    expect(minePort([9000, 9010])).toBe(9020)
    const entry = { ...slides, id: 'me.thing', port: 9000 }
    expect(portForMine(entry, [], [7990])).toBe(9000)
    expect(portForMine(entry, [9000], [7990])).toBe(9010)
    expect(portForMine(entry, [], [9000])).toBe(9010)
    /* An entry that names an official module's port is moved off it. */
    expect(portForMine({ ...entry, port: 8020 }, [], [8020])).toBe(9000)
    expect(portForMine({ ...entry, port: 8020 }, [], [])).toBe(9000)
  })

  test('adding steps over an official port on the personal grid and over what is registered', async () => {
    const w = world({ answers: flowsRepo(), official: [slides, high], registered: [{ id: 'me.other', url: 'http://127.0.0.1:9010' }] })
    await w.mine.add('jaakkorajalasol/kehikko-flows')
    expect(readMine(w.file).modules[0]!.port).toBe(9020)
    await settled(w, 'kehikot.flows')
    expect(JSON.parse(readFileSync(join(w.registry, 'kehikot.flows.json'), 'utf8')).url).toBe('http://127.0.0.1:9020')
  })
})

describe('removing one', () => {
  test('stops it, deletes the installed copy and its registration, and forgets it', async () => {
    const w = world({ answers: flowsRepo() })
    await w.mine.add('jaakkorajalasol/kehikko-flows')
    await settled(w, 'kehikot.flows')
    writeFileSync(join(w.root, 'kehikot.flows', 'file.ts'), 'x')
    const answered = await post(w, '/host/mine/remove', { module: 'kehikot.flows' })
    expect(answered?.status).toBe(200)
    expect(w.stopped).toEqual(['kehikot.flows'])
    expect(existsSync(join(w.root, 'kehikot.flows'))).toBe(false)
    expect(existsSync(join(w.registry, 'kehikot.flows.json'))).toBe(false)
    expect(readMine(w.file).modules).toEqual([])
    expect(w.changed.length).toBeGreaterThan(0)
  })

  test('a registration naming somebody’s own checkout, and that checkout, are left alone', async () => {
    const w = world({ answers: flowsRepo() })
    const own = join(w.base, 'my-checkout')
    mkdirSync(own, { recursive: true })
    mkdirSync(w.registry, { recursive: true })
    writeFileSync(join(w.registry, 'kehikot.flows.json'), JSON.stringify({ url: 'http://127.0.0.1:9000', dir: own }))
    const entry: Mine = { id: 'kehikot.flows', name: 'Flows', repo: 'a/b', host: 'github.com', port: 9000, summary: '', tags: [], added: '2026-10-21' }
    writeFileSync(w.file, JSON.stringify({ modules: [entry] }))
    expect((await w.mine.remove('kehikot.flows')).ok).toBe(true)
    expect(existsSync(own)).toBe(true)
    expect(existsSync(join(w.registry, 'kehikot.flows.json'))).toBe(true)
    expect(readMine(w.file).modules).toEqual([])
  })

  test('only one of the person’s own modules is removed from here — never an official one', async () => {
    const w = world({ registered: [{ id: 'kehikot.slides', url: 'http://127.0.0.1:7990' }] })
    expect(await w.mine.remove('kehikot.slides')).toMatchObject({ ok: false, status: 404 })
    expect(w.stopped).toEqual([])
  })
})

describe('a module installed by hand', () => {
  function handInstalled(port: number, remote = 'git@github.com:jaakkorajalasol/kehikko-flows.git') {
    const w = world({ git: (argv) => (argv.includes('get-url') ? { ok: true, out: remote } : { ok: true, out: '' }) })
    const dir = join(w.root, 'kehikot.flows')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.ts'), MANIFEST)
    writeFileSync(join(dir, 'package.json'), pkg())
    mkdirSync(w.registry, { recursive: true })
    writeFileSync(join(w.registry, 'kehikot.flows.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, dir, keep: false }))
    return w
  }

  test('is offered, and nothing is written until the person presses', async () => {
    const w = handInstalled(8020)
    const listed = await w.mine.list()
    expect(listed.adoptable).toEqual([{ id: 'kehikot.flows', name: 'Flows', from: 'jaakkorajalasol/kehikko-flows', moves: { from: 8020, to: 9000 } }])
    expect(existsSync(w.file)).toBe(false)
    expect(JSON.parse(readFileSync(join(w.registry, 'kehikot.flows.json'), 'utf8')).url).toBe('http://127.0.0.1:8020')
    expect(w.stopped).toEqual([])
  })

  test('keeping it writes its entry, and moves it off an official port', async () => {
    const w = handInstalled(8020)
    expect((await post(w, '/host/mine/adopt', { module: 'kehikot.flows' }))?.status).toBe(200)
    expect(w.stopped).toEqual(['kehikot.flows'])
    expect(JSON.parse(readFileSync(join(w.registry, 'kehikot.flows.json'), 'utf8'))).toEqual({
      url: 'http://127.0.0.1:9000',
      dir: join(w.root, 'kehikot.flows'),
      keep: false,
    })
    expect(readMine(w.file).modules).toEqual([
      {
        id: 'kehikot.flows',
        name: 'Flows',
        repo: 'jaakkorajalasol/kehikko-flows',
        host: 'github.com',
        port: 9000,
        summary: 'Diagrams of an epic’s architecture, written to be walked through one stage at a time.',
        tags: ['reading'],
        protocol: '2.6.0',
        added: '2026-10-21',
        adopted: true,
      },
    ])
    /* Kept, it is an ordinary one of theirs: installed, and no longer offered. */
    const listed = await w.mine.list()
    expect(listed.adoptable).toEqual([])
    expect(listed.modules).toMatchObject([{ id: 'kehikot.flows', installed: true, mine: true }])
  })

  test('one on a port of its own keeps it, and is not stopped', async () => {
    const w = handInstalled(9050)
    await w.mine.adopt('kehikot.flows')
    expect(w.stopped).toEqual([])
    expect(readMine(w.file).modules[0]!.port).toBe(9050)
  })

  test('a checkout of an official repository is not offered', async () => {
    const w = handInstalled(9050, 'https://github.com/Jalez/kehikko-slides.git')
    expect((await w.mine.list()).adoptable).toEqual([])
    expect(await w.mine.adopt('kehikot.flows')).toMatchObject({ ok: false, status: 404 })
  })
})

describe('who may do any of it', () => {
  const PAGE = 'http://127.0.0.1:4170'
  const self: Own = { origins: [PAGE], hosts: new Set(['127.0.0.1:4171']) }
  const WRITES = ['/host/mine/check', '/host/mine/add', '/host/mine/install', '/host/mine/remove', '/host/mine/adopt']
  const ask = (path: string, headers: Record<string, string>) => refusal({ method: 'POST', pathname: path, headers: new Headers(headers) }, self)

  test('every write is the page’s alone: a program and another origin are refused', () => {
    for (const path of WRITES) {
      expect(PAGE_ONLY).toContain(path)
      expect(ask(path, { origin: PAGE, 'content-type': 'application/json', 'content-length': '2' })).toBeNull()
      expect(ask(path, { 'content-type': 'application/json', 'content-length': '2' })?.status).toBe(403)
      expect(ask(path, { origin: 'https://example.org', 'content-type': 'application/json', 'content-length': '2' })?.status).toBe(403)
    }
  })

  test('the host’s MCP door has no tool that adds, installs or removes a module', async () => {
    const db = new Database(':memory:')
    const reply = await mcp(
      { id: 1, method: 'tools/list' },
      { db, which: () => [], wake: () => {}, epicsChanged: () => {}, dispositionsChanged: () => {}, seen: async () => [] } as never,
      { name: 'kehikko', version: '0.1.0' },
    )
    db.close()
    const tools = (reply.body as { result: { tools: { name: string; description?: string }[] } }).result.tools
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/install|repositor|mine|adopt|uninstall/i)
      expect(tool.description ?? '').not.toMatch(/\/host\/mine|my modules/i)
    }
    const door = readFileSync(join(import.meta.dir, '..', 'server', 'mcp.ts'), 'utf8')
    expect(door).not.toMatch(/myModules|\/host\/mine|myModulesFile/)
  })
})

describe('the list goes nowhere', () => {
  test('only the host’s own wiring reads the file: nothing that publishes, proposes or talks to a module', () => {
    const server = join(import.meta.dir, '..', 'server')
    const readers = readdirSync(server, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => /myModulesFile|my-modules\.json|from '\.\/myModules\.ts'/.test(readFileSync(join(server, name), 'utf8')))
      .sort()
    expect(readers).toEqual(['machineDirs.ts', 'myModules.ts', 'server.ts'])
    expect(myModulesFile()).toBe(process.env.KEHIKOT_MY_MODULES!)
  })

  test('adding a second module asks about that repository only — the first is never named to anyone', async () => {
    const answers: Answers = {
      ...flowsRepo(),
      'repos/someone/second': JSON.stringify({ full_name: 'someone/second', private: true }),
      'repos/someone/second/contents/manifest.ts': MANIFEST.replace("'kehikot.flows'", "'me.second'").replace("name: 'Flows'", "name: 'Second'"),
      'repos/someone/second/contents/package.json': pkg(),
    }
    const w = world({ answers })
    await w.mine.add('jaakkorajalasol/kehikko-flows')
    await settled(w, 'kehikot.flows')
    w.asked.splice(0)
    w.gitCalls.splice(0)
    await w.mine.add('someone/second')
    await settled(w, 'me.second')
    const everything = [...w.asked.map((argv) => argv.join(' ')), ...w.gitCalls.map((call) => call.argv.join(' '))].join('\n')
    expect(everything).not.toContain('kehikko-flows')
    expect(everything).not.toContain('kehikot.flows')
    /* And the GET answers with the list — the page's own read — and is not a write anybody can make. */
    const got = await w.mine.route(new Request('http://h/host/mine'), new URL('http://h/host/mine'))
    expect((await got!.json()).modules.map((one: { id: string }) => one.id)).toEqual(['kehikot.flows', 'me.second'])
    expect(PAGE_ONLY).not.toContain('/host/mine')
  })

  test('a list that cannot be read is left as it is, and nothing is added over it', async () => {
    const w = world({ answers: flowsRepo() })
    writeFileSync(w.file, '{ not json')
    const listed = await w.mine.list()
    expect(listed.broken).toContain('could not be read')
    expect(await w.mine.add('jaakkorajalasol/kehikko-flows')).toMatchObject({ ok: false, status: 500 })
    expect(readFileSync(w.file, 'utf8')).toBe('{ not json')
    expect(w.gitCalls).toEqual([])
  })
})
