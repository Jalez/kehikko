import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installDesk, portFor } from '../server/installs.ts'
import { OFFICIAL, officialOf, readOfficial, type Official } from '../server/official.ts'
import { readRegistration } from '../server/registrations.ts'
import type { Ran, Runner } from '../server/versions.ts'

/*
 * The official list, and installing from it — against a fake runner, because
 * the real one would clone repositories. What matters is that only a listed
 * module can be installed, that nothing from a request reaches git or a path,
 * that the registration lands where the host sweeps, and that every way of
 * failing is a sentence that is still there when the page asks.
 */

const slides: Official = { id: 'kehikot.slides', name: 'Slides', repo: 'Jalez/kehikko-slides', port: 7990, summary: 'Decks.', tags: ['writing'] }
const notes: Official = { id: 'kehikot.notes', name: 'Notes', repo: 'Jalez/kehikko-notes', port: 7940, summary: 'Notes.', tags: ['reading'] }

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function world(answers: (argv: readonly string[]) => Ran = () => ({ ok: true, out: '' }), registered: { id: string; port: number | null }[] = []) {
  const base = mkdtempSync(join(tmpdir(), 'kehikot-installs-'))
  scratch.push(base)
  const root = join(base, 'installed')
  const registry = join(base, 'modules')
  const calls: { argv: readonly string[]; cwd?: string }[] = []
  const woken: string[] = []
  let release: () => void = () => {}
  const held = new Promise<void>((done) => (release = done))
  let hold = false
  const run: Runner = async (argv, options) => {
    calls.push({ argv, cwd: options?.cwd })
    if (hold) await held
    const ran = answers(argv)
    /* A clone that worked leaves a directory, as git does. */
    if (ran.ok && argv[1] === 'clone') mkdirSync(argv[argv.length - 1]!, { recursive: true })
    return ran
  }
  const desk = installDesk({
    list: [slides, notes],
    run,
    root,
    registry,
    registered: async () => [
      ...registered,
      ...(existsSync(registry) ? readdirSync(registry).map((name) => ({ id: name.replace(/\.json$/, ''), port: null })) : []),
    ],
    installed: (id) => woken.push(id),
  })
  return { desk, calls, woken, root, registry, holding: () => (hold = true), release: () => release() }
}

async function settled(desk: ReturnType<typeof installDesk>, id: string) {
  for (let i = 0; i < 200; i++) {
    const row = (await desk.list()).find((one) => one.id === id)!
    if (row.installed || row.install?.state === 'failed') return row
    await new Promise((done) => setTimeout(done, 5))
  }
  throw new Error('the install never settled')
}

describe('the official list', () => {
  test('the one this host ships parses, with no module twice and every repository named owner/name', () => {
    expect(OFFICIAL.length).toBeGreaterThan(10)
    expect(new Set(OFFICIAL.map((one) => one.id)).size).toBe(OFFICIAL.length)
    expect(new Set(OFFICIAL.map((one) => one.port)).size).toBe(OFFICIAL.length)
    for (const one of OFFICIAL) expect(one.repo).toMatch(/^Jalez\/kehikko-[a-z]+$/)
  })

  test('a module is found under either spelling of its id', () => {
    expect(officialOf('roadmap.slides', [slides])?.id).toBe('kehikot.slides')
    expect(officialOf('me.scores', [slides])).toBeNull()
  })

  test('a list no host could use is refused where it is read', () => {
    expect(() => readOfficial({ modules: [slides, slides] })).toThrow('twice')
    expect(() => readOfficial({ modules: [{ ...slides, repo: '../../etc' }] })).toThrow()
    expect(() => readOfficial({ modules: [{ ...slides, repo: '--upload-pack=x/y' }] })).toThrow()
    expect(() => readOfficial({ modules: [{ ...slides, id: 'Not An Id' }] })).toThrow()
  })
})

describe('installing an official module', () => {
  test('clones, installs and registers, in a directory the host owns', async () => {
    const { desk, calls, woken, root, registry } = world()
    const started = await desk.install('kehikot.slides')
    expect(started).toMatchObject({ ok: true, install: { state: 'installing' } })
    const row = await settled(desk, 'kehikot.slides')
    expect(row.installed).toBe(true)

    const dir = join(root, 'kehikot.slides')
    expect(calls.map((call) => call.argv.join(' '))).toEqual([
      `git clone --quiet https://github.com/Jalez/kehikko-slides.git ${dir}`,
      'bun install --frozen-lockfile',
    ])
    expect(calls[1]!.cwd).toBe(dir)

    /* A registration the host's own reader accepts, naming the checkout. */
    const read = readRegistration('kehikot.slides.json', readFileSync(join(registry, 'kehikot.slides.json'), 'utf8'))
    expect(read).toEqual({ ok: true, registration: { id: 'kehikot.slides', url: 'http://127.0.0.1:7990', dir } })
    expect(readdirSync(registry)).toEqual(['kehikot.slides.json'])
    expect(woken).toEqual(['kehikot.slides'])
  })

  test('the list says how far it has got while it runs', async () => {
    const { desk, holding, release } = world()
    holding()
    await desk.install('kehikot.slides')
    const row = (await desk.list()).find((one) => one.id === 'kehikot.slides')!
    expect(row).toMatchObject({ installed: false, install: { state: 'installing', step: 'cloning' } })
    /* A second press joins the one in flight rather than cloning twice. */
    expect(await desk.install('kehikot.slides')).toMatchObject({ ok: true, install: { state: 'installing' } })
    release()
    expect((await settled(desk, 'kehikot.slides')).installed).toBe(true)
  })

  test('only what is on the list, named by id — nothing else in a request is read', async () => {
    const { desk, calls } = world()
    expect(await desk.install('me.scores')).toMatchObject({ ok: false, status: 404 })
    const answered = await desk.route(
      new Request('http://h/host/official/install', { method: 'POST', body: JSON.stringify({ module: 'me.scores', repo: 'evil/thing', dir: '/tmp/x' }) }),
      new URL('http://h/host/official/install'),
    )
    expect(answered?.status).toBe(404)
    expect(calls).toEqual([])
  })

  test('a module already registered is not installed over', async () => {
    const { desk, calls } = world(undefined, [{ id: 'kehikot.slides', port: 7990 }])
    expect(await desk.install('kehikot.slides')).toMatchObject({ ok: false, status: 409 })
    expect((await desk.list()).find((one) => one.id === 'kehikot.slides')).toMatchObject({ installed: true })
    expect(calls).toEqual([])
  })

  test('falls back to ssh when https cannot clone, and says why when neither can', async () => {
    const overSsh = world((argv) => (argv[1] === 'clone' && String(argv[3]).startsWith('https') ? { ok: false, why: 'no route' } : { ok: true, out: '' }))
    await overSsh.desk.install('kehikot.slides')
    expect((await settled(overSsh.desk, 'kehikot.slides')).installed).toBe(true)
    expect(overSsh.calls[1]!.argv[3]).toBe('git@github.com:Jalez/kehikko-slides.git')

    const neither = world((argv) => (argv[1] === 'clone' ? { ok: false, why: 'could not resolve host' } : { ok: true, out: '' }))
    await neither.desk.install('kehikot.slides')
    const row = await settled(neither.desk, 'kehikot.slides')
    expect(row.install).toEqual({ state: 'failed', why: 'Jalez/kehikko-slides could not be cloned: could not resolve host' })
    expect(existsSync(neither.registry)).toBe(false)
    expect(neither.woken).toEqual([])
  })

  test('a failed dependency install is kept as a sentence, and the next press reuses the clone', async () => {
    let installs = 0
    const { desk, calls, root } = world((argv) => {
      if (argv[0] === 'bun') return ++installs === 1 ? { ok: false, why: 'lockfile is frozen' } : { ok: true, out: '' }
      if (argv.includes('get-url')) return { ok: true, out: 'https://github.com/Jalez/kehikko-slides.git' }
      return { ok: true, out: '' }
    })
    await desk.install('kehikot.slides')
    expect((await settled(desk, 'kehikot.slides')).install).toEqual({
      state: 'failed',
      why: 'Slides was cloned, and its dependencies could not be installed: lockfile is frozen',
    })
    await desk.install('kehikot.slides')
    expect((await settled(desk, 'kehikot.slides')).installed).toBe(true)
    expect(calls.filter((call) => call.argv[1] === 'clone')).toHaveLength(1)
    expect(calls.some((call) => call.argv.join(' ') === `git -C ${join(root, 'kehikot.slides')} remote get-url origin`)).toBe(true)
  })

  test('a clone left by a failed attempt is brought up to date before it is installed again', async () => {
    let installs = 0
    const { desk, calls, root } = world((argv) => {
      if (argv[0] === 'bun') return ++installs === 1 ? { ok: false, why: 'lockfile is frozen' } : { ok: true, out: '' }
      if (argv.includes('get-url')) return { ok: true, out: 'https://github.com/Jalez/kehikko-slides.git' }
      return { ok: true, out: '' }
    })
    await desk.install('kehikot.slides')
    await settled(desk, 'kehikot.slides')
    await desk.install('kehikot.slides')
    expect((await settled(desk, 'kehikot.slides')).installed).toBe(true)
    const said = calls.map((call) => call.argv.join(' '))
    const pull = said.indexOf(`git -C ${join(root, 'kehikot.slides')} pull --ff-only --quiet`)
    /* The fix for a repository that would not install arrives as a commit, so
       the pull has to come BEFORE the second install, not merely happen. */
    expect(pull).toBeGreaterThan(-1)
    expect(pull).toBeLessThan(said.lastIndexOf('bun install --frozen-lockfile'))
  })

  test('a clone that cannot be updated is still tried, and the failure says both things', async () => {
    const { desk } = world((argv) => {
      if (argv[0] === 'bun') return { ok: false, why: 'lockfile is frozen' }
      if (argv.includes('get-url')) return { ok: true, out: 'https://github.com/Jalez/kehikko-slides.git' }
      if (argv.includes('pull')) return { ok: false, why: 'could not resolve host github.com' }
      return { ok: true, out: '' }
    })
    await desk.install('kehikot.slides')
    await settled(desk, 'kehikot.slides')
    await desk.install('kehikot.slides')
    expect((await settled(desk, 'kehikot.slides')).install).toEqual({
      state: 'failed',
      why: 'Slides was cloned, and its dependencies could not be installed: lockfile is frozen — and the clone, left by an earlier attempt, could not be brought up to date first: could not resolve host github.com',
    })
  })

  test('a directory in the way that is not this module is never cloned over', async () => {
    const { desk, calls, root } = world((argv) => (argv.includes('get-url') ? { ok: true, out: 'git@github.com:somebody/else.git' } : { ok: true, out: '' }))
    mkdirSync(join(root, 'kehikot.slides'), { recursive: true })
    writeFileSync(join(root, 'kehikot.slides', 'mine.txt'), 'kept')
    await desk.install('kehikot.slides')
    const row = await settled(desk, 'kehikot.slides')
    expect(row.install?.state).toBe('failed')
    expect(calls.some((call) => call.argv[1] === 'clone' || call.argv[0] === 'bun')).toBe(false)
    expect(readFileSync(join(root, 'kehikot.slides', 'mine.txt'), 'utf8')).toBe('kept')
  })
})

describe('the port a new registration names', () => {
  test('the listed one when it is free, else the next free place on the grid', () => {
    expect(portFor(slides, [7940, 7950])).toBe(7990)
    expect(portFor(slides, [7990, 7861])).toBe(8000)
    expect(portFor(notes, [7940])).toBe(7960)
    expect(portFor(notes, [7940, 7960, 7970])).toBe(7980)
  })
})
