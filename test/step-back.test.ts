import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AutoUpdates, type Facts } from '../server/autoUpdates.ts'
import { declaredDataVersion, pickStepBack, releaseFollower, type StepBackGuard } from '../server/moduleReleases.ts'
import { hasUpdate, readCheckout, update, type Checkout, type Place } from '../server/updates.ts'
import { tagsFromLsRemote, type Tags } from '../server/versions.ts'
import { doneSaid } from '../src/host/autoUpdates.ts'
import { releaseForAgents, releaseSaid, stepBackAsked, steppedBackSaid, type ModuleRelease } from '../src/host/moduleReleases.ts'
import { needsAttention, stepBackWaits } from '../src/host/updates.ts'

/*
 * Stepping back: an installed copy whose release needs a newer protocol than
 * this host has (the app was downgraded) moves to the newest older release
 * that works here — on its own when nothing says that could hurt, otherwise
 * only on the person's press. Every other case still never moves back.
 */

const safe: StepBackGuard = { recorded: null, current: null, pinned: [], kept: false }
const needs: Record<string, string | null> = { 'v1.3.0': '9.0.0', 'v1.2.0': '9.0.0', 'v1.1.0': '2.4.0', 'v1.0.0': null }
const needOf = (tag: string) => needs[tag] ?? null
const RELEASES = ['v1.3.0', 'v1.2.0', 'v1.1.0', 'v1.0.0']

describe('the choice', () => {
  test('the newest older release this host can run', () => {
    expect(pickStepBack(RELEASES, needOf, () => 1, { installed: 'v1.2.0', have: '2.5.0', guard: safe })).toEqual({ to: 'v1.1.0', ask: null })
  })

  test('none when no older release runs here either', () => {
    expect(pickStepBack(RELEASES, needOf, () => 1, { installed: 'v1.2.0', have: '2.0.0', guard: safe })?.to).toBe('v1.0.0')
    expect(pickStepBack(RELEASES, needOf, () => 1, { installed: 'v1.2.0', have: '2.5.0', entry: '9.0.0', guard: safe })).toBeNull()
    expect(pickStepBack(['v1.2.0'], needOf, () => 1, { installed: 'v1.2.0', have: '2.5.0', guard: safe })).toBeNull()
  })

  test('none when the release it is on runs here: it never moves back then', () => {
    expect(pickStepBack(RELEASES, needOf, () => 1, { installed: 'v1.1.0', have: '2.5.0', guard: safe })).toBeNull()
    expect(pickStepBack(RELEASES, needOf, () => 1, { installed: 'v1.2.0', have: '9.0.0', guard: safe })).toBeNull()
    expect(pickStepBack(RELEASES, needOf, () => 1, { installed: null, have: '2.5.0', guard: safe })).toBeNull()
  })

  test('data written in a newer format than the older release reads: it asks', () => {
    const recorded = pickStepBack(RELEASES, needOf, () => 1, { installed: 'v1.2.0', have: '2.5.0', guard: { ...safe, recorded: 2 } })
    expect(recorded?.to).toBe('v1.1.0')
    expect(recorded?.ask).toContain('format 2')
    expect(recorded?.ask).toContain('1.1.0 reads format 1')
    /* What the release it is on declares counts too. */
    expect(pickStepBack(RELEASES, needOf, (tag) => (tag === 'v1.2.0' ? 3 : 1), { installed: 'v1.2.0', have: '2.5.0', guard: { ...safe, current: 3 } })?.ask).toContain('format 3')
    /* The same format, or a higher one: it goes on its own. */
    expect(pickStepBack(RELEASES, needOf, () => 2, { installed: 'v1.2.0', have: '2.5.0', guard: { ...safe, recorded: 2 } })?.ask).toBeNull()
  })

  test('an older release whose data format is not known: it asks', () => {
    const back = pickStepBack(RELEASES, needOf, () => null, { installed: 'v1.2.0', have: '2.5.0', guard: safe })
    expect(back?.to).toBe('v1.1.0')
    expect(back?.ask).toContain('not known which data format 1.1.0 reads')
  })

  test('never past a pinned version without asking', () => {
    expect(pickStepBack(RELEASES, needOf, () => 1, { installed: 'v1.2.0', have: '2.5.0', guard: { ...safe, pinned: ['v1.2.0'] } })?.ask).toContain('pinned to 1.2.0')
    /* A pin at or below where it moves is not passed. */
    expect(pickStepBack(RELEASES, needOf, () => 1, { installed: 'v1.2.0', have: '2.5.0', guard: { ...safe, pinned: ['v1.0.0', 'v1.1.0'] } })?.ask).toBeNull()
  })

  test('never a kept copy without asking', () => {
    expect(pickStepBack(RELEASES, needOf, () => 1, { installed: 'v1.2.0', have: '2.5.0', guard: { ...safe, kept: true } })?.ask).toContain('keep')
  })

  test('the data format is read from a literal in the manifest source, never run', () => {
    expect(declaredDataVersion("export const manifest = {\n  id: 'x',\n  dataVersion: 2,\n}")).toBe(2)
    expect(declaredDataVersion('dataVersion: DATA_VERSION,')).toBeNull()
    expect(declaredDataVersion("{ id: 'x' }")).toBeNull()
    expect(declaredDataVersion('dataVersion: 1, other: { dataVersion: 3 }')).toBeNull()
    expect(declaredDataVersion(null)).toBeNull()
  })
})

describe('the words', () => {
  const release = (more: Partial<ModuleRelease>): ModuleRelease => ({
    follows: 'release',
    installed: 'v1.2.0',
    newest: null,
    target: null,
    notes: ['v1.2.0'],
    needsNewer: { tag: 'v1.2.0', protocol: '9.0.0' },
    repo: null,
    error: null,
    ...more,
  })

  test('a step back that goes on its own reads as a move back', () => {
    const one = release({ target: 'v1.1.0', back: { to: 'v1.1.0', ask: null } })
    expect(releaseSaid(one)).toBe('1.2.0 → back to 1.1.0')
    expect(stepBackAsked(one)).toBeNull()
    expect(releaseForAgents(one)).toContain('steps back to v1.1.0')
    expect(steppedBackSaid('M', 'v1.1.0')).toBe('M was moved back to 1.1.0, which works with this Kehikot.')
  })

  test('one that waits asks, and gets a row of its own', () => {
    const one = release({ back: { to: 'v1.1.0', ask: 'Risky.' } })
    expect(releaseSaid(one)).toBe('1.2.0 needs a newer Kehikot')
    expect(stepBackAsked(one)).toBe('Step back to 1.1.0?')
    const reading = { id: 'kehikot.m', name: 'M', dir: '/x', branch: null, commit: 'abc', dirty: false, upstream: null, behind: 0, ahead: 0, incoming: [], fetchFailed: null, blocked: 'already up to date', release: one }
    expect(stepBackWaits(reading)).toBe(true)
    expect(needsAttention(reading, null)).toBe(true)
    expect(releaseForAgents(one)).toContain('waits for the person: Risky.')
  })
})

/* ---- against real repositories ---- */

const root = mkdtempSync(join(tmpdir(), 'kehikko-step-back-'))
let made = 0
afterAll(() => rmSync(root, { recursive: true, force: true }))

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

const pkg = (version: string, protocol: string) =>
  `${JSON.stringify({ name: 'm', version, dependencies: { 'kehikot-module-protocol': `git+ssh://git@github.com/Jalez/kehikko-protocol.git#v${protocol}` } })}\n`

function module() {
  const base = join(root, `m${(made += 1)}`)
  const origin = join(base, 'origin.git')
  const author = join(base, 'author')
  const copy = join(base, 'installed')
  mkdirSync(base, { recursive: true })
  Bun.spawnSync(['git', 'init', '--quiet', '--bare', '--initial-branch=main', origin], { env })
  Bun.spawnSync(['git', 'clone', '--quiet', origin, author], { env })
  git(author, 'checkout', '--quiet', '-b', 'main')
  const release = (version: string, protocol: string, dataVersion: number | null = 1) => {
    writeFileSync(join(author, 'package.json'), pkg(version, protocol))
    writeFileSync(join(author, 'manifest.ts'), `export const manifest = {\n  id: 'kehikot.m',\n${dataVersion === null ? '' : `  dataVersion: ${dataVersion},\n`}}\n`)
    git(author, 'add', 'package.json', 'manifest.ts')
    git(author, 'commit', '--quiet', '-m', `release ${version}`)
    git(author, 'push', '--quiet', 'origin', 'main')
    git(author, 'tag', '-a', `v${version}`, '-m', `v${version}`)
    git(author, 'push', '--quiet', 'origin', `v${version}`)
  }
  /** Installed at `tag`, detached, as the app leaves a copy. */
  const install = (tag: string) => {
    Bun.spawnSync(['git', 'clone', '--quiet', origin, copy], { env })
    git(copy, 'checkout', '--quiet', '--detach', `refs/tags/${tag}`)
  }
  return { origin, copy, release, install }
}

function followerOf(origin: string, have: string, guard?: Omit<StepBackGuard, 'current'>) {
  const tags = {
    async tags(): Promise<Tags> {
      return { ok: true, tags: tagsFromLsRemote(git(origin, 'for-each-ref', '--format=x\t%(refname)', 'refs/tags')), at: 1 }
    },
  }
  return releaseFollower({ tags, have, entryProtocol: () => undefined, ...(guard ? { stepBack: () => guard } : {}), now: () => 1_000_000 })
}

async function read(place: Place): Promise<Checkout> {
  const reading = await readCheckout(place, true)
  if ('error' in reading) throw new Error(reading.error)
  return reading
}

describe('an installed copy on a release this host cannot run', () => {
  test('steps back to the newest release it can, on its own, when nothing argues against it', async () => {
    const m = module()
    m.release('1.0.0', '2.0.0')
    m.release('1.1.0', '2.4.0')
    m.release('1.2.0', '9.0.0')
    m.install('v1.2.0')
    const place: Place = { id: 'kehikot.m', name: 'M', dir: m.copy, releases: followerOf(m.origin, '2.5.0', { recorded: 1, pinned: [], kept: false }) }
    const reading = await read(place)
    expect(reading.release).toMatchObject({ installed: 'v1.2.0', target: 'v1.1.0', back: { to: 'v1.1.0', ask: null } })
    expect(hasUpdate(reading)).toBe(true)
    expect(reading.blocked).toBeNull()
    const done = await update(place)
    expect(done.ok).toBe(true)
    expect(git(m.copy, 'describe', '--exact-match', '--tags', 'HEAD')).toBe('v1.1.0')
    /* There, it runs: nothing moves it again, back or forward. */
    const after = await read(place)
    expect(after.release).toMatchObject({ installed: 'v1.1.0', target: null })
    expect(after.release?.back).toBeUndefined()
  })

  test('asks when the older release might misread the data, and moves only once the person allows it', async () => {
    const m = module()
    m.release('1.0.0', '2.0.0', 1)
    m.release('1.1.0', '9.0.0', 2)
    m.install('v1.1.0')
    const follower = followerOf(m.origin, '2.5.0', { recorded: 2, pinned: [], kept: false })
    const place: Place = { id: 'kehikot.m', name: 'M', dir: m.copy, releases: follower }
    const reading = await read(place)
    expect(reading.release?.target).toBeNull()
    expect(reading.release?.back?.to).toBe('v1.0.0')
    expect(reading.release?.back?.ask).toContain('format 2')
    expect(hasUpdate(reading)).toBe(false)
    expect((await update(place)).ok).toBe(false)
    expect(git(m.copy, 'describe', '--exact-match', '--tags', 'HEAD')).toBe('v1.1.0')

    follower.allow!('kehikot.m', 'v1.0.0')
    const done = await update(place)
    expect(done.ok).toBe(true)
    expect(git(m.copy, 'describe', '--exact-match', '--tags', 'HEAD')).toBe('v1.0.0')
  })

  test('without a guard to consult, it asks', async () => {
    const m = module()
    m.release('1.0.0', '2.0.0')
    m.release('1.1.0', '9.0.0')
    m.install('v1.1.0')
    const reading = await read({ id: 'kehikot.m', name: 'M', dir: m.copy, releases: followerOf(m.origin, '2.5.0') })
    expect(reading.release?.target).toBeNull()
    expect(reading.release?.back?.ask).not.toBeNull()
  })

  test('once the app is upgraded again, it moves forward as ever', async () => {
    const m = module()
    m.release('1.0.0', '2.0.0')
    m.release('1.1.0', '9.0.0')
    m.install('v1.0.0')
    const reading = await read({ id: 'kehikot.m', name: 'M', dir: m.copy, releases: followerOf(m.origin, '9.0.0', { recorded: 1, pinned: [], kept: false }) })
    expect(reading.release).toMatchObject({ installed: 'v1.0.0', target: 'v1.1.0' })
    expect(reading.release?.back).toBeUndefined()
  })
})

describe('a forward update', () => {
  test('still never moves a copy back', async () => {
    const m = module()
    m.release('1.0.0', '2.0.0')
    m.release('1.1.0', '2.4.0')
    m.release('1.2.0', '9.0.0')
    m.install('v1.1.0')
    const place: Place = { id: 'kehikot.m', name: 'M', dir: m.copy, releases: followerOf(m.origin, '2.5.0', { recorded: 1, pinned: [], kept: false }) }
    const reading = await read(place)
    expect(reading.release).toMatchObject({ installed: 'v1.1.0', target: null, needsNewer: { tag: 'v1.2.0', protocol: '9.0.0' } })
    expect(reading.release?.back).toBeUndefined()
    expect(hasUpdate(reading)).toBe(false)
    expect((await update(place)).ok).toBe(false)
    expect(git(m.copy, 'describe', '--exact-match', '--tags', 'HEAD')).toBe('v1.1.0')
  })
})

describe('the automatic updates', () => {
  test('a step back taken is said as one, and told once', async () => {
    const told: string[] = []
    const reading: Checkout = {
      id: 'kehikot.m', name: 'M', dir: '/x', branch: null, commit: 'abc', dirty: false, upstream: 'v1.1.0', behind: 0, ahead: 0, incoming: [], fetchFailed: null, blocked: null,
      release: { follows: 'release', installed: 'v1.2.0', newest: null, target: 'v1.1.0', notes: ['v1.1.0'], needsNewer: null, repo: null, error: null, back: { to: 'v1.1.0', ask: null } },
    }
    const facts: Facts = { name: 'M', installed: true, pinned: [], running: false, onScreen: false, holdsShells: false, kept: false, busy: false }
    const auto = new AutoUpdates({
      on: () => true,
      facts: () => facts,
      apply: async () => ({ ok: true, checkout: null }),
      changed: () => {},
      steppedBack: (_id, name, to) => told.push(steppedBackSaid(name, to)),
      log: () => {},
    })
    await auto.found([reading])
    const done = auto.said().updated
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ from: '1.2.0', to: '1.1.0', back: true, major: false })
    expect(doneSaid(done[0]!)).toBe('M 1.2.0 → back to 1.1.0')
    expect(told).toEqual(['M was moved back to 1.1.0, which works with this Kehikot.'])
  })
})
