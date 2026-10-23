import { PACKAGE_VERSION } from 'kehikot-module-protocol'

import { githubRepo } from './feedback.ts'
import { meetsProtocol } from './official.ts'
import type { Checkout, Place, ReleaseFollower } from './updates.ts'
import { remoteOf, run, type Runner, type Tags } from './versions.ts'
import {
  compareReleases,
  isRelease,
  releasesNewestFirst,
  type ModuleRelease,
} from '../src/host/moduleReleases.ts'
import { higherNeed, withRunningHost, worksWith, type AppProtocol, type WorksWith } from '../src/host/worksWith.ts'

/**
 * Installed modules run their RELEASES, not `main`.
 *
 * The app installs a module under the machine directory's `installed/<id>/`
 * (`installs.ts`). Such a copy is checked out at the newest release of its
 * repository — the newest `vX.Y.Z` tag, no pre-releases, whose protocol need
 * this host meets — and is moved to a newer release before it starts (`level`
 * in `server.ts`) or when a person presses Update. Never while it runs.
 *
 * ## How the releases are found
 *
 * `git ls-remote --tags` on the copy's own remote, through the person's git —
 * the credential helper `gh`/`glab` set up, or their ssh key — so a private
 * repository (one of "My modules") is read like a public one. Cached by
 * `TagLister` (`versions.ts`) and asked afresh at most once a minute, and only
 * when somebody checks: a reading without `fetch` (the header's source chip,
 * the re-read before an update) uses the tags already in the copy and asks
 * nothing of the network. Tags the copy does not have yet are fetched into it
 * (`git fetch --tags`), so the copy has every release it may move to.
 *
 * ## Which release
 *
 * The newest whose protocol need is met: the `kehikot-module-protocol` pin in
 * THAT TAG's `package.json` (read with `git show`, never run — the rule
 * `describeModule` in `myModules.ts` uses), and the list entry's own
 * `protocol`, which still applies. A newer release that needs a newer app is
 * skipped and said (`needsNewer`).
 *
 * ## Moving, and never moving back
 *
 * - A copy on release A moves to release B only when B is newer than A.
 * - A copy on `main` — every copy installed before releases — moves to the
 *   newest release when that release contains its commit (or is that commit).
 *   When the release is OLDER than the copy (`main` was ahead of the last
 *   release), the copy is held where it is — "running main ahead of 1.6.0" —
 *   and moves to the first release that contains it. It is not fast-forwarded
 *   along `main` meanwhile: that would only put it further ahead.
 * - A repository with no release yet: the copy follows `main` exactly as
 *   before — "following main · no releases yet".
 */

export interface FollowerDeps {
  /** git, with no terminal and no prompts. */
  run?: Runner
  /** The tags of a remote, cached. `TagLister`. */
  tags: { tags(url: string, fresh?: boolean): Promise<Tags> }
  /** The protocol package this host has. */
  have?: string
  /** The `protocol` of the list entry a module was installed from (official, or one of "My modules"), when it names one. */
  entryProtocol(id: string): string | undefined
  /**
   * Which protocol each Kehikot app shipped (`appProtocols.ts`), or null when
   * it is not known. Absent: releases say nothing about which Kehikot they
   * work with.
   */
  apps?(): readonly AppProtocol[] | null
  now?(): number
}

/** How often a check asks the remote for its tags afresh; between, `TagLister`'s answer stands. */
export const ASK_AT_MOST_EVERY_MS = 60_000
const FETCH_TIMEOUT_MS = 30_000

/** The protocol package a `package.json` pins: `…kehikko-protocol.git#v2.6.0`, `^2.6.0` and `2.6.0` all say 2.6.0. */
export function protocolPin(pkg: string | null): string | null {
  if (pkg === null) return null
  let dependency: unknown
  try {
    const read = JSON.parse(pkg) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }
    dependency = read.dependencies?.['kehikot-module-protocol'] ?? read.devDependencies?.['kehikot-module-protocol']
  } catch {
    return null
  }
  if (typeof dependency !== 'string') return null
  return /(\d{1,6}\.\d{1,6}\.\d{1,6})(?!.*\d+\.\d+\.\d+)/.exec(dependency)?.[1] ?? null
}

/** The `version` a `package.json` says, as a release tag (`1.6.0` → `v1.6.0`), or null. */
function packageRelease(pkg: string | null): string | null {
  if (pkg === null) return null
  try {
    const version = (JSON.parse(pkg) as { version?: unknown }).version
    return typeof version === 'string' && isRelease(`v${version}`) ? `v${version}` : null
  } catch {
    return null
  }
}

/**
 * The newest release this host can run, newest first through `releases`, and
 * the newest one it cannot — stopping at `floor` (the installed release), below
 * which nothing is ever chosen.
 */
export function pickNewest(
  releases: readonly string[],
  needOf: (tag: string) => string | null,
  options: { have?: string; entry?: string; floor?: string | null } = {},
): { newest: string | null; needsNewer: { tag: string; protocol: string } | null } {
  let needsNewer: { tag: string; protocol: string } | null = null
  for (const tag of releases) {
    if (options.floor && compareReleases(tag, options.floor) < 0) break
    if (!meetsProtocol(options.entry, options.have)) {
      needsNewer ??= { tag, protocol: options.entry! }
      continue
    }
    const need = needOf(tag)
    if (need !== null && !meetsProtocol(need, options.have)) {
      needsNewer ??= { tag, protocol: need }
      continue
    }
    return { newest: tag, needsNewer }
  }
  return { newest: null, needsNewer }
}

/**
 * Which Kehikot each of `tags` works with: its need is the higher of its own
 * `package.json` pin and the list entry's `protocol`. A release with neither
 * has no entry.
 */
export function worksOf(
  tags: readonly (string | null | undefined)[],
  needOf: (tag: string) => string | null,
  entry: string | undefined,
  apps: readonly AppProtocol[] | null,
  /** The protocol the running host pins: a release it meets never "needs a newer Kehikot", whatever the app tags say. */
  host?: string,
): Record<string, WorksWith> {
  const works: Record<string, WorksWith> = {}
  for (const tag of tags) {
    if (!tag || Object.hasOwn(works, tag)) continue
    const need = higherNeed(needOf(tag), entry)
    if (need) works[tag] = withRunningHost(worksWith(need, apps), { protocol: host })
  }
  return works
}

/** The releases whose notes an update shows: after `from` (exclusive) up to `to`, newest first. */
export function notesBetween(releases: readonly string[], from: string | null, to: string): string[] {
  return releasesNewestFirst(releases).filter(
    (tag) => compareReleases(tag, to) <= 0 && (from === null || compareReleases(tag, from) > 0),
  )
}

export function releaseFollower(deps: FollowerDeps): ReleaseFollower {
  const runner = deps.run ?? run
  const now = deps.now ?? Date.now
  const have = deps.have ?? PACKAGE_VERSION
  /* A tag's protocol pin, per checkout and tag commit: a release does not change. */
  const pins = new Map<string, string | null>()
  const askedAt = new Map<string, number>()

  const git = async (dir: string, args: string[], timeoutMs?: number) =>
    runner(['git', '-C', dir, ...args], timeoutMs ? { timeoutMs } : undefined)
  const out = async (dir: string, args: string[]) => {
    const ran = await git(dir, args)
    return ran.ok ? ran.out : null
  }

  async function needOfAll(dir: string, tags: readonly string[]): Promise<Map<string, string | null>> {
    const needs = new Map<string, string | null>()
    for (const tag of tags) {
      const commit = await out(dir, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`])
      if (!commit) continue
      const key = `${dir}\u0000${commit}`
      if (!pins.has(key)) pins.set(key, protocolPin(await out(dir, ['show', `${commit}:package.json`])))
      needs.set(tag, pins.get(key) ?? null)
    }
    return needs
  }

  async function overlay(place: Place, checkout: Checkout, fetch: boolean): Promise<Checkout> {
    const dir = checkout.dir
    const remote = await remoteOf(dir, runner)
    const repo = remote ? githubRepo(remote) : null
    let error: string | null = null

    /* The releases the remote has, when somebody is checking; otherwise the copy's own tags. */
    const local = releasesNewestFirst(((await out(dir, ['tag', '--list', 'v*'])) ?? '').split('\n').filter(Boolean))
    let releases = local
    if (fetch && remote) {
      const fresh = now() - (askedAt.get(remote) ?? 0) > ASK_AT_MOST_EVERY_MS
      const got = await deps.tags.tags(remote, fresh)
      if (fresh) askedAt.set(remote, now())
      if (!got.ok) error = got.why
      else {
        const remoteReleases = releasesNewestFirst(got.tags)
        if (remoteReleases.some((tag) => !local.includes(tag))) {
          const fetched = await git(dir, ['fetch', '--quiet', '--tags', 'origin'], FETCH_TIMEOUT_MS)
          if (!fetched.ok) error = fetched.why
        }
        const here = new Set(
          releasesNewestFirst(((await out(dir, ['tag', '--list', 'v*'])) ?? '').split('\n').filter(Boolean)),
        )
        releases = remoteReleases.filter((tag) => here.has(tag))
      }
    }

    const head = await out(dir, ['rev-parse', 'HEAD'])
    const atHead = releasesNewestFirst(((await out(dir, ['tag', '--points-at', 'HEAD'])) ?? '').split('\n').filter(Boolean))
    const installed = checkout.branch === null ? (atHead[0] ?? null) : null

    const base: ModuleRelease = {
      follows: 'main',
      installed,
      newest: null,
      target: null,
      notes: [],
      needsNewer: null,
      repo,
      error,
    }
    if (releases.length === 0) {
      if (error) {
        /* Nothing is known about its releases: nothing moves until it is. */
        return {
          ...checkout,
          release: { ...base, follows: installed ? 'release' : 'main' },
          behind: 0,
          ahead: 0,
          incoming: [],
          fetchFailed: error,
          blocked: `its releases could not be read: ${error}`,
        }
      }
      /* No release yet: it follows main, as every installed copy did before. */
      return { ...checkout, release: base }
    }

    const needs = await needOfAll(dir, releases)
    const picked = pickNewest(releases, (tag) => needs.get(tag) ?? null, {
      have,
      entry: deps.entryProtocol(place.id),
      floor: installed,
    })
    const newest = picked.newest
    let follows: ModuleRelease['follows'] = 'release'
    let target: string | null = null
    let from = installed

    const entry = deps.entryProtocol(place.id)
    /* Which Kehikot the releases named here work with, when the apps are known to this host at all. */
    const say = async (release: ModuleRelease): Promise<ModuleRelease> => {
      if (!deps.apps) return release
      const named = [release.installed, release.newest, release.target, ...release.notes, release.needsNewer?.tag]
      const missing = named.filter((tag): tag is string => !!tag && !needs.has(tag))
      if (missing.length) for (const [tag, need] of await needOfAll(dir, missing)) needs.set(tag, need)
      const works = worksOf(named, (tag) => needs.get(tag) ?? null, entry, deps.apps(), have)
      return Object.keys(works).length ? { ...release, works } : release
    }

    if (installed) {
      if (newest && compareReleases(newest, installed) > 0) target = newest
    } else if (!newest) {
      /* It has releases, and this host can run none of them: it stays as it
         is, on main, and says what it would need. */
      return { ...checkout, release: await say({ ...base, needsNewer: picked.needsNewer }) }
    } else {
      const tagCommit = await out(dir, ['rev-parse', '--verify', '--quiet', `refs/tags/${newest}^{commit}`])
      const ancestor = async (a: string, b: string) => (await git(dir, ['merge-base', '--is-ancestor', a, b])).ok
      const headPkg = await out(dir, ['show', 'HEAD:package.json'])
      from = packageRelease(headPkg)
      if (!tagCommit || !head) target = newest
      else if (tagCommit === head || (await ancestor(head, tagCommit))) target = newest
      else if (await ancestor(tagCommit, head)) follows = 'ahead'
      else {
        /* Neither contains the other: the version its package.json says decides. */
        follows = from && compareReleases(from, newest) > 0 ? 'ahead' : 'release'
        if (follows === 'release') target = newest
      }
    }

    const release: ModuleRelease = await say({
      ...base,
      follows,
      newest,
      target,
      /* From main, the floor is the version its package.json says; without one,
         only the release it moves to. */
      notes: target
        ? from && compareReleases(from, target) < 0
          ? notesBetween(releases, from, target)
          : [target]
        : installed
          ? [installed]
          : [],
      needsNewer: picked.needsNewer,
    })

    if (!target) {
      return {
        ...checkout,
        release,
        upstream: installed ?? checkout.upstream,
        behind: 0,
        ahead: 0,
        incoming: [],
        fetchFailed: error ?? checkout.fetchFailed,
        blocked:
          follows === 'ahead' && newest
            ? `it runs main ahead of ${newest}, and moves to the first release after it`
            : 'already up to date',
      }
    }

    const counted = await out(dir, ['rev-list', '--count', `HEAD..refs/tags/${target}`])
    const log = await out(dir, ['log', '-n10', '--format=%h%x09%s', `HEAD..refs/tags/${target}`])
    return {
      ...checkout,
      release,
      upstream: target,
      behind: Number(counted) || 0,
      ahead: 0,
      incoming: log
        ? log.split('\n').map((line) => {
            const [hash, ...rest] = line.split('\t')
            return { hash: hash ?? '', subject: rest.join('\t') }
          })
        : [],
      fetchFailed: error ?? checkout.fetchFailed,
      blocked: checkout.dirty && !checkout.staleLock ? 'there are uncommitted changes; commit or stash them first' : null,
    }
  }

  /**
   * A copy that has just been cloned: checked out at the newest release this
   * host can run, before its dependencies are installed. A fresh clone is on
   * the tip of `main`, which is usually ahead of the last release — so the
   * hold `overlay` applies to a copy that was already running `main` does not
   * apply here: nobody was running anything yet. No release: it stays on
   * `main`, and `tag` is null.
   */
  async function settle(place: Place): Promise<{ ok: true; tag: string | null } | { ok: false; why: string }> {
    const dir = place.dir
    const releases = releasesNewestFirst(((await out(dir, ['tag', '--list', 'v*'])) ?? '').split('\n').filter(Boolean))
    if (releases.length === 0) return { ok: true, tag: null }
    const needs = await needOfAll(dir, releases)
    const { newest } = pickNewest(releases, (tag) => needs.get(tag) ?? null, { have, entry: deps.entryProtocol(place.id) })
    if (!newest) return { ok: true, tag: null }
    const moved = await git(dir, ['checkout', '--quiet', '--detach', `refs/tags/${newest}`])
    return moved.ok ? { ok: true, tag: newest } : { ok: false, why: `could not check out ${newest}: ${moved.why}` }
  }

  async function local(place: Place): Promise<string[]> {
    return releasesNewestFirst(((await out(place.dir, ['tag', '--list', 'v*'])) ?? '').split('\n').filter(Boolean))
  }

  async function worksFor(place: Place, tags: readonly string[]): Promise<Record<string, WorksWith>> {
    if (!deps.apps) return {}
    const needs = await needOfAll(place.dir, tags)
    return worksOf(tags, (tag) => needs.get(tag) ?? null, deps.entryProtocol(place.id), deps.apps(), have)
  }

  return { overlay, settle, local, worksFor }
}
