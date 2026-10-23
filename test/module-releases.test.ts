import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { notesBetween, pickNewest, protocolPin, releaseFollower, ASK_AT_MOST_EVERY_MS } from '../server/moduleReleases.ts'
import { releaseNotesDesk } from '../server/releaseNotes.ts'
import { hasUpdate, readCheckout, update, type Checkout, type Place } from '../server/updates.ts'
import { tagsFromLsRemote, type Tags } from '../server/versions.ts'
import {
  isRelease,
  needsNewerSaid,
  releaseForAgents,
  releaseInView,
  releaseLine,
  releaseNotesTitle,
  releaseSaid,
  releasesNewestFirst,
  worksSaid,
  type ModuleRelease,
} from '../src/host/moduleReleases.ts'
import type { AppProtocol } from '../src/host/worksWith.ts'
import { moduleRow, stateText } from '../src/host/updateModel.ts'
import { waiting } from '../src/host/updates.ts'

/*
 * Installed modules run their releases. Against real repositories where git
 * decides (which tag a copy is on, what contains what, the checkout itself),
 * and with the remote's tag list stubbed where the network would be — which
 * is also where a private repository's credentials would be used.
 */

const root = mkdtempSync(join(tmpdir(), 'kehikko-releases-'))
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

const pkg = (version: string, protocol = '2.0.0') =>
  `${JSON.stringify({ name: 'm', version, dependencies: { 'kehikot-module-protocol': `git+ssh://git@github.com/Jalez/kehikko-protocol.git#v${protocol}` } })}\n`

/** A module's repository (`origin`), a clone that publishes to it, and the installed copy under test. */
function module() {
  const base = join(root, `m${(made += 1)}`)
  const origin = join(base, 'origin.git')
  const author = join(base, 'author')
  const copy = join(base, 'installed')
  mkdirSync(base, { recursive: true })
  Bun.spawnSync(['git', 'init', '--quiet', '--bare', '--initial-branch=main', origin], { env })
  Bun.spawnSync(['git', 'clone', '--quiet', origin, author], { env })
  git(author, 'checkout', '--quiet', '-b', 'main')
  const commit = (file: string, text: string, message: string) => {
    writeFileSync(join(author, file), text)
    git(author, 'add', file)
    git(author, 'commit', '--quiet', '-m', message)
    git(author, 'push', '--quiet', 'origin', 'main')
  }
  /** Publish a release: package.json at the version, an annotated tag, pushed. */
  const release = (version: string, protocol = '2.0.0') => {
    commit('package.json', pkg(version, protocol), `release ${version}`)
    git(author, 'tag', '-a', `v${version}`, '-m', `v${version}`)
    git(author, 'push', '--quiet', 'origin', `v${version}`)
  }
  commit('package.json', pkg('0.0.1'), 'first')
  const clone = () => Bun.spawnSync(['git', 'clone', '--quiet', origin, copy], { env })
  const place = (follower = followerOf(origin)): Place => ({ id: 'kehikot.m', name: 'M', dir: copy, releases: follower.follower })
  return { origin, author, copy, commit, release, clone, place }
}

/** The follower, with the remote's tags read from the bare origin as `git ls-remote` would — stubbed, and counted. */
function followerOf(origin: string, options: { entry?: string; have?: string; fail?: string; apps?: () => AppProtocol[] | null } = {}) {
  let asked = 0
  let fresh = 0
  let clock = 1_000_000
  const tags = {
    async tags(url: string, isFresh = false): Promise<Tags> {
      asked += 1
      if (isFresh) fresh += 1
      expect(url).toBe(origin)
      if (options.fail) return { ok: false, why: options.fail, at: clock }
      return { ok: true, tags: tagsFromLsRemote(git(origin, 'for-each-ref', '--format=x\t%(refname)', 'refs/tags')), at: clock }
    },
  }
  const follower = releaseFollower({
    tags,
    have: options.have ?? '2.5.0',
    entryProtocol: () => options.entry,
    ...(options.apps ? { apps: options.apps } : {}),
    now: () => clock,
  })
  return {
    follower,
    get asked() {
      return asked
    },
    get fresh() {
      return fresh
    },
    tick(ms: number) {
      clock += ms
    },
  }
}

async function read(place: Place, fetch = true): Promise<Checkout> {
  const reading = await readCheckout(place, fetch)
  if ('error' in reading) throw new Error(reading.error)
  return reading
}

const view = (more: Partial<ModuleRelease> = {}): ModuleRelease => ({
  follows: 'release',
  installed: 'v1.5.0',
  newest: 'v1.6.0',
  target: 'v1.6.0',
  notes: ['v1.6.0'],
  needsNewer: null,
  repo: 'Jalez/kehikko-journeys',
  error: null,
  ...more,
})

describe('which release', () => {
  test('releases are vX.Y.Z only, newest first by semver; pre-releases and other tags are ignored', () => {
    expect(isRelease('v1.2.0')).toBe(true)
    expect(isRelease('1.2.0')).toBe(false)
    expect(isRelease('v2.0.0-beta.1')).toBe(false)
    expect(releasesNewestFirst(['v1.2.0', 'v1.10.0', 'v2.0.0-rc.1', 'v1.9.3', 'nightly', 'v1.2.0'])).toEqual(['v1.10.0', 'v1.9.3', 'v1.2.0'])
  })

  test('the newest whose protocol need is met; a newer one that is not met is skipped and said', () => {
    const needs: Record<string, string | null> = { 'v1.2.0': '3.0.0', 'v1.1.0': '2.4.0', 'v1.0.0': null }
    expect(pickNewest(['v1.2.0', 'v1.1.0', 'v1.0.0'], (tag) => needs[tag] ?? null, { have: '2.5.0' })).toEqual({
      newest: 'v1.1.0',
      needsNewer: { tag: 'v1.2.0', protocol: '3.0.0' },
    })
    /* The list entry's own protocol still applies to every release. */
    expect(pickNewest(['v1.1.0'], () => null, { have: '2.5.0', entry: '9.0.0' })).toEqual({
      newest: null,
      needsNewer: { tag: 'v1.1.0', protocol: '9.0.0' },
    })
    /* Nothing older than the installed release is ever chosen. */
    expect(pickNewest(['v1.2.0', 'v1.0.0'], (tag) => (tag === 'v1.2.0' ? '3.0.0' : null), { have: '2.5.0', floor: 'v1.1.0' }).newest).toBeNull()
  })

  test('the protocol pin is read the way the install check reads it', () => {
    expect(protocolPin(pkg('1.0.0', '2.6.0'))).toBe('2.6.0')
    expect(protocolPin('{"dependencies":{"kehikot-module-protocol":"^2.7.1"}}')).toBe('2.7.1')
    expect(protocolPin('{"name":"x"}')).toBeNull()
    expect(protocolPin('not json')).toBeNull()
  })

  test('notes run from after the installed release up to the target, newest first', () => {
    expect(notesBetween(['v1.4.0', 'v1.5.0', 'v1.6.0', 'v1.7.0', 'v1.5.1'], 'v1.5.0', 'v1.6.0')).toEqual(['v1.6.0', 'v1.5.1'])
  })
})

describe('an installed copy', () => {
  test('with no release yet it follows main, as before', async () => {
    const m = module()
    m.clone()
    m.commit('a.txt', 'a\n', 'more')
    const f = followerOf(m.origin)
    const reading = await read(m.place(f))
    expect(reading.release).toMatchObject({ follows: 'main', installed: null, newest: null, target: null })
    expect(reading.behind).toBe(1)
    expect(hasUpdate(reading)).toBe(true)
    expect(releaseSaid(reading.release!)).toBe('following main · no releases yet')
    const done = await update(m.place(f))
    expect(done.ok).toBe(true)
    expect(git(m.copy, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
  })

  test('a fresh clone is put on the newest release, detached at its tag', async () => {
    const m = module()
    m.release('1.0.0')
    m.release('1.1.0')
    m.commit('later.txt', 'unreleased\n', 'after the release')
    m.clone()
    const f = followerOf(m.origin)
    expect(await f.follower.settle(m.place(f))).toEqual({ ok: true, tag: 'v1.1.0' })
    expect(git(m.copy, 'describe', '--exact-match', '--tags', 'HEAD')).toBe('v1.1.0')
    expect((await read(m.place(f))).release).toMatchObject({ follows: 'release', installed: 'v1.1.0', target: null })
  })

  test('on a release, a newer one is fetched and checked out at its tag', async () => {
    const m = module()
    m.release('1.5.0')
    m.clone()
    const f = followerOf(m.origin)
    await f.follower.settle(m.place(f))
    m.commit('feature.txt', 'new\n', 'a feature')
    m.release('1.6.0')
    const reading = await read(m.place(f))
    expect(reading.release).toMatchObject({ follows: 'release', installed: 'v1.5.0', newest: 'v1.6.0', target: 'v1.6.0', notes: ['v1.6.0'] })
    expect(reading.upstream).toBe('v1.6.0')
    expect(reading.behind).toBe(2)
    expect(reading.blocked).toBeNull()
    expect(releaseLine('Journeys', reading.release!)).toBe('Journeys 1.5.0 → 1.6.0')
    const done = await update(m.place(f))
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.changed.sort()).toEqual(['feature.txt', 'package.json'])
    expect(git(m.copy, 'describe', '--exact-match', '--tags', 'HEAD')).toBe('v1.6.0')
    const after = await read(m.place(f), false)
    expect(after.release).toMatchObject({ installed: 'v1.6.0', target: null })
    expect(releaseSaid(after.release!)).toBe('up to date · 1.6.0')
    expect(hasUpdate(after)).toBe(false)
  })

  test('several releases since the installed one: all their notes, newest first', async () => {
    const m = module()
    m.release('1.4.0')
    m.clone()
    const f = followerOf(m.origin)
    await f.follower.settle(m.place(f))
    m.release('1.5.0')
    m.release('1.5.1')
    m.release('1.6.0')
    const reading = await read(m.place(f))
    expect(reading.release?.notes).toEqual(['v1.6.0', 'v1.5.1', 'v1.5.0'])
    expect(releaseNotesTitle('Journeys', reading.release!.notes)).toBe("What's new in Journeys 1.5.0 → 1.6.0")
  })

  test('a newer release whose package.json needs a newer protocol is skipped', async () => {
    const m = module()
    m.release('1.0.0', '2.0.0')
    m.clone()
    const f = followerOf(m.origin, { have: '2.5.0' })
    await f.follower.settle(m.place(f))
    m.release('1.1.0', '2.4.0')
    m.release('1.2.0', '3.0.0')
    const reading = await read(m.place(f))
    expect(reading.release).toMatchObject({ newest: 'v1.1.0', target: 'v1.1.0', needsNewer: { tag: 'v1.2.0', protocol: '3.0.0' } })
    expect(needsNewerSaid(reading.release!)).toBe('1.2.0 needs a newer Kehikot (protocol 3.0 or later).')
  })

  test('each release named says which Kehikot it works with, from the app mapping', async () => {
    const m = module()
    m.release('1.0.0', '2.0.0')
    m.clone()
    const apps = [
      { app: '0.1.21', protocol: '1.7.0' },
      { app: '0.1.22', protocol: '2.0.0' },
      { app: '0.1.37', protocol: '2.6.0' },
      { app: '0.1.39', protocol: '2.10.0' },
    ]
    const f = followerOf(m.origin, { have: '2.10.0', apps: () => apps })
    await f.follower.settle(m.place(f))
    m.release('1.1.0', '2.6.0')
    m.release('1.2.0', '2.11.0')
    const reading = await read(m.place(f))
    const release = reading.release!
    expect(release).toMatchObject({ installed: 'v1.0.0', target: 'v1.1.0', needsNewer: { tag: 'v1.2.0', protocol: '2.11.0' } })
    expect(worksSaid(release, 'v1.0.0')).toBe('Works with Kehikot 0.1.22 and later')
    expect(worksSaid(release, releaseInView(release))).toBe('Works with Kehikot 0.1.37 and later')
    expect(needsNewerSaid(release, { app: '0.1.40' })).toBe('1.2.0 needs a Kehikot newer than 0.1.39 (protocol 2.11 or later); you have 0.1.40.')
    expect(releaseForAgents(release, { protocol: '2.10.0' })).toContain('v1.1.0: Works with Kehikot 0.1.37 and later.')
  })

  test('an entry protocol higher than the pin is the need it is said with', async () => {
    const m = module()
    m.release('1.0.0', '2.0.0')
    m.clone()
    const f = followerOf(m.origin, { have: '2.10.0', entry: '2.6.0', apps: () => [{ app: '0.1.37', protocol: '2.6.0' }] })
    await f.follower.settle(m.place(f))
    const reading = await read(m.place(f))
    expect(reading.release?.works?.['v1.0.0']).toMatchObject({ kind: 'from', need: '2.6.0', from: '0.1.37' })
  })

  test('without the app mapping the words fall back to the protocol', async () => {
    const m = module()
    m.release('1.0.0', '2.6.0')
    m.clone()
    const f = followerOf(m.origin, { have: '2.10.0', apps: () => null })
    await f.follower.settle(m.place(f))
    const reading = await read(m.place(f))
    /* The map is unknown, but this host (2.10) meets the need: it works with this Kehikot. */
    expect(worksSaid(reading.release!, 'v1.0.0')).toBe('Works with this Kehikot and later')
  })

  test('a host that reads no apps says nothing about them', async () => {
    const m = module()
    m.release('1.0.0', '2.0.0')
    m.clone()
    const f = followerOf(m.origin)
    await f.follower.settle(m.place(f))
    const reading = await read(m.place(f))
    expect(reading.release?.works).toBeUndefined()
  })

  test('a copy on main moves to a release that contains its commit', async () => {
    const m = module()
    m.clone()
    m.commit('b.txt', 'b\n', 'more')
    m.release('1.0.0')
    const f = followerOf(m.origin)
    const reading = await read(m.place(f))
    expect(reading.release).toMatchObject({ follows: 'release', installed: null, target: 'v1.0.0' })
    expect(releaseSaid(reading.release!)).toBe('main → 1.0.0')
    expect((await update(m.place(f))).ok).toBe(true)
    expect(git(m.copy, 'describe', '--exact-match', '--tags', 'HEAD')).toBe('v1.0.0')
  })

  test('a copy on main AHEAD of the newest release is never moved back, and moves at the next release', async () => {
    const m = module()
    m.release('1.6.0')
    m.commit('c.txt', 'c\n', 'merged after the release')
    m.clone()
    const f = followerOf(m.origin)
    const head = git(m.copy, 'rev-parse', 'HEAD')
    const reading = await read(m.place(f))
    expect(reading.release).toMatchObject({ follows: 'ahead', newest: 'v1.6.0', target: null })
    expect(releaseSaid(reading.release!)).toBe('running main ahead of 1.6.0')
    expect(hasUpdate(reading)).toBe(false)
    const refused = await update(m.place(f))
    expect(refused.ok).toBe(false)
    expect(git(m.copy, 'rev-parse', 'HEAD')).toBe(head)
    /* Nor is it fast-forwarded along main meanwhile. */
    m.commit('d.txt', 'd\n', 'more on main')
    expect(hasUpdate(await read(m.place(f)))).toBe(false)
    m.release('1.7.0')
    f.tick(ASK_AT_MOST_EVERY_MS + 1)
    const next = await read(m.place(f))
    expect(next.release).toMatchObject({ follows: 'release', target: 'v1.7.0' })
    expect((await update(m.place(f))).ok).toBe(true)
    expect(git(m.copy, 'describe', '--exact-match', '--tags', 'HEAD')).toBe('v1.7.0')
  })

  test('uncommitted changes block the move, as they block a fast-forward', async () => {
    const m = module()
    m.release('1.0.0')
    m.clone()
    const f = followerOf(m.origin)
    await f.follower.settle(m.place(f))
    m.release('1.1.0')
    writeFileSync(join(m.copy, 'package.json'), 'mine\n')
    const reading = await read(m.place(f))
    expect(reading.blocked).toContain('uncommitted')
    const done = await update(m.place(f))
    expect(done).toMatchObject({ ok: false, status: 409 })
  })

  test('releases that cannot be read move nothing the copy does not already have, and say why', async () => {
    const m = module()
    m.clone()
    m.release('1.0.0')
    const offline = followerOf(m.origin, { fail: 'Could not resolve host: github.com' })
    const reading = await read(m.place(offline))
    expect(reading.release?.error).toContain('Could not resolve host')
    expect(hasUpdate(reading)).toBe(false)
    expect(reading.blocked).toContain('could not be read')
    expect(git(m.copy, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
  })

  test('a private repository: its tags come through the person’s git, asked afresh at most once a minute', async () => {
    const m = module()
    m.release('1.0.0')
    m.clone()
    const f = followerOf(m.origin)
    await read(m.place(f))
    await read(m.place(f))
    expect(f.asked).toBe(2)
    expect(f.fresh).toBe(1)
    f.tick(ASK_AT_MOST_EVERY_MS + 1)
    await read(m.place(f))
    expect(f.fresh).toBe(2)
    /* A reading without a check asks nothing of the remote. */
    await read(m.place(f), false)
    expect(f.asked).toBe(3)
  })
})

describe('the Updates menu says', () => {
  const checkout = (release: ModuleRelease, behind = 2): Checkout => ({
    id: 'kehikot.journeys',
    name: 'Journeys',
    dir: '/x',
    branch: release.installed ? null : 'main',
    commit: 'abc1234',
    dirty: false,
    upstream: release.target,
    behind,
    ahead: 0,
    incoming: [],
    fetchFailed: null,
    blocked: release.target ? null : 'already up to date',
    release,
  })

  test('each of the four ways a module can be', () => {
    expect(releaseLine('Journeys', view())).toBe('Journeys 1.5.0 → 1.6.0')
    expect(releaseSaid(view({ installed: 'v1.6.0', target: null, notes: ['v1.6.0'] }))).toBe('up to date · 1.6.0')
    expect(releaseSaid(view({ follows: 'main', installed: null, newest: null, target: null }))).toBe('following main · no releases yet')
    expect(releaseSaid(view({ follows: 'ahead', installed: null, target: null }))).toBe('running main ahead of 1.6.0')
  })

  test('a row with a newer release is available and says it; the version shown is the release', () => {
    const row = moduleRow(checkout(view()), null, null)
    expect(row.state).toBe('available')
    expect(stateText(row)).toBe('1.5.0 → 1.6.0')
    expect(row.current).toBe('1.5.0')
    expect(row.version).toBe('1.6.0')
    const level = moduleRow(checkout(view({ installed: 'v1.6.0', target: null }), 0), null, null)
    expect(level.state).toBe('uptodate')
    expect(stateText(level)).toBe('Up to date · 1.6.0')
    const ahead = moduleRow(checkout(view({ follows: 'ahead', installed: null, target: null }), 0), null, null)
    expect(stateText(ahead)).toBe('Running main ahead of 1.6.0')
  })

  test('moving onto a release at the commit it is already on still counts as an update', () => {
    expect(waiting([checkout(view({ installed: null }), 0)])).toBe(1)
  })

  test('what an agent is told', () => {
    expect(releaseForAgents(view())).toContain('runs release v1.5.0; the newest release this host can run is v1.6.0')
    expect(releaseForAgents(view({ follows: 'main', installed: null, newest: null, target: null }))).toContain('no releases yet')
    expect(releaseForAgents(view({ follows: 'ahead', installed: null, target: null }))).toContain('main ahead of v1.6.0')
  })
})

describe('release notes of a private repository', () => {
  test('when GitHub will not show it to a stranger, the person’s gh is asked, and the answer is cached', async () => {
    const asked: string[] = []
    let clock = 1_000_000
    const desk = releaseNotesDesk({
      allowed: () => true,
      now: () => clock,
      fetch: (async () => new Response('{"message":"Not Found"}', { status: 404 })) as unknown as typeof fetch,
      gh: async (path) => {
        asked.push(path)
        return { tag_name: 'v1.6.0', name: 'Journeys 1.6.0', body: "### What's new\n- a thing\n\n<sub>Built from abc1234</sub>", draft: false }
      },
    })
    const got = await desk.release('Jalez/kehikko-journeys', 'v1.6.0')
    expect(got).toMatchObject({ ok: true, value: { tag: 'v1.6.0', name: 'Journeys 1.6.0' } })
    expect(asked).toEqual(['repos/Jalez/kehikko-journeys/releases/tags/v1.6.0'])
    await desk.release('Jalez/kehikko-journeys', 'v1.6.0')
    expect(asked).toHaveLength(1)
    clock += 31 * 60_000
    await desk.release('Jalez/kehikko-journeys', 'v1.6.0')
    expect(asked).toHaveLength(2)
  })

  test('without gh, a private repository says its notes are missing, as before', async () => {
    const desk = releaseNotesDesk({
      allowed: () => true,
      fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    })
    expect(await desk.release('Jalez/private', 'v1.0.0')).toMatchObject({ ok: false, status: 404 })
  })
})

describe('the container header', () => {
  const source = { dir: '/installed/kehikot.journeys', registered: true, branch: null, upstream: null, behind: 0, ahead: 0, dirty: false }

  test('a copy on a release is the plain case: quiet, and its version chip says the release', async () => {
    const { branchWord, offMain, releaseShown, sourceHint } = await import('../src/host/source.ts')
    const onRelease = { ...source, release: 'v1.6.0' }
    expect(offMain(onRelease)).toEqual([])
    expect(branchWord(onRelease)).toBe('release')
    expect(releaseShown(onRelease)).toBe('1.6.0')
    expect(sourceHint(onRelease)).toContain('at release v1.6.0')
    /* Detached anywhere else is still marked. */
    expect(offMain({ ...source, release: null })).toEqual(['on no branch (detached)'])
    expect(releaseShown({ ...source, branch: 'main', release: null })).toBeNull()
  })
})
