import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { PACKAGE_VERSION } from 'kehikot-module-protocol'
import { BUNDLE_LIMITS, bundleArchiveName, checksumOf, readBundleInfo, sizeOf, unpackBundle, type BundleInfo } from 'kehikot-module-protocol/bundle'

import type { Job } from './jobSteps.ts'
import { meetsProtocol } from './official.ts'
import { notesBetween, pickNewest, protocolPin, worksOf } from './moduleReleases.ts'
import type { Checkout, Place } from './updates.ts'
import type { Tags } from './versions.ts'
import { compareReleases, isRelease, releasesNewestFirst, type ModuleRelease } from '../src/host/moduleReleases.ts'
import type { AppProtocol } from '../src/host/worksWith.ts'

/**
 * Installed modules as ready-built bundles: downloaded, checked, unpacked and
 * swapped in, with no clone, no `bun install` and no build on this computer.
 * The format and every check are the protocol's (`kehikot-module-protocol/bundle`,
 * its docs/bundles.md); this file is where a bundle comes from and where it goes.
 *
 * ## Why, from the person's side
 *
 * A module installed from git is a checkout and its own `node_modules`: tens of
 * thousands of files each, which endpoint security scans, and an install or an
 * update that runs `bun install` and a page build here — slow, and down while it
 * runs. A bundle is what the module's CI already built and started once: a
 * megabyte, tens of files, downloaded while the old version keeps running. What
 * the person waits for is a restart.
 *
 * ## Where a bundle comes from
 *
 * Only `https://github.com/<repo>/releases/download/<tag>/<id>-<version>.tar.gz`
 * and its `.sha256`, where `<repo>` is the official list's (or the person's own
 * list's) entry for the module, read on this side by id — never a request's.
 * HTTPS only, every redirect included. A release with no `.sha256` has no
 * bundle, and the module is installed from git as before.
 *
 * ## Where it goes: one stable folder, the previous version beside it
 *
 *     installed/<id>/              the version that runs (a bundle, or a git checkout)
 *     installed/.previous/<id>/    the one before, kept for rolling back
 *     installed/.incoming/<id>-…/  a download being checked and unpacked
 *
 * The running version stays at `installed/<id>/`, the same path a git install
 * used, and is never a versioned path. That is deliberate: agent modules write
 * their own folder into the person's configuration (a session hook, a status
 * line script), and a path that named a version would stop working two updates
 * later. A swap is two renames on one disk; a rollback is the same two back.
 * After a version answers, only one previous is kept; a previous that was a git
 * checkout (the move to bundles) is removed then, with its `node_modules`, and
 * what that freed is said.
 */

export const INCOMING = '.incoming'
export const PREVIOUS = '.previous'

const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/
const ID = /^[a-z0-9][a-z0-9.-]{1,62}[a-z0-9]$/
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const SMALL_TIMEOUT_MS = 20_000
/** A tag's protocol pin is read at most this often per tag that failed to read. */
const NEED_RETRY_MS = 10 * 60_000
/** How many of a module's newest releases are asked about, for what it can be pinned to. */
const PINNABLE = 30
/** How many of those are asked at once. */
const ASKS_AT_ONCE = 6

/** Where a module's releases are: its id and the GitHub repository its list entry names. */
export interface Source {
  id: string
  repo: string
}

export interface BundleDeps {
  /** `installsDir()`. */
  root: string
  /** The repository an installed module's list entry names, by id; null when it is on no list, or not on GitHub. */
  repoOf(id: string): string | null
  /** The tags of a remote, cached (`TagLister`). */
  tags?: { tags(url: string, fresh?: boolean): Promise<Tags> }
  /** The protocol package this host has. */
  have?: string
  /** The `protocol` of the module's list entry, when it names one. */
  entryProtocol?(id: string): string | undefined
  apps?(): readonly AppProtocol[] | null
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  /** This machine, as a bundle names one. Default `platformHere()`. */
  platform?: string
  log?(line: string): void
  now?(): number
}

export type Found = { ok: true; tag: string; url: string; sha256: string } | { ok: false; none: boolean; why: string }
export type Staged = { ok: true; dir: string; info: BundleInfo; bytes: number } | { ok: false; why: string; none?: boolean }

/** What a swap left behind, to settle or roll back. */
export interface Swapped {
  id: string
  /** The version now at `installed/<id>/`. */
  to: string
  /** What was there before, now under `.previous/`, or null when nothing was. */
  previous: { dir: string; bundle: string | null } | null
}

/** Whether `dir` holds an unpacked bundle. */
export function isBundle(dir: string): boolean {
  return readBundleInfo(dir) !== null
}

/** The release a bundle in `dir` is, `v1.6.0`, or null. */
export function bundleRelease(dir: string): string | null {
  const info = readBundleInfo(dir)
  return info ? `v${info.version}` : null
}

/** An address is fetched only over HTTPS, every hop: a redirect to anything else is refused. */
async function getHttps(get: NonNullable<BundleDeps['fetch']>, url: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  let at = url
  for (let hop = 0; hop < 6; hop++) {
    if (!at.startsWith('https://')) throw new Error(`${at.split('?')[0]} is not HTTPS, so it was not fetched.`)
    const response = await get(at, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) })
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      at = new URL(response.headers.get('location')!, at).href
      await response.body?.cancel()
      continue
    }
    return response
  }
  throw new Error(`${url} redirected too many times.`)
}

/** How a size is said: "1.2 MB", "820 MB", "5.9 GB". */
export function sizeSaid(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} kB`
}

export function bundleDesk(deps: BundleDeps) {
  const get = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init))
  const have = deps.have ?? PACKAGE_VERSION
  const log = deps.log ?? (() => {})
  const now = deps.now ?? Date.now
  const needs = new Map<string, { need: string | null; at: number; ok: boolean }>()
  const releasesOf = new Map<string, string[]>()
  const carries = new Map<string, { has: boolean; at: number }>()

  const incoming = join(deps.root, INCOMING)
  const previous = join(deps.root, PREVIOUS)

  function sourceOf(id: string): Source | null {
    const repo = deps.repoOf(id)
    return repo && REPO.test(repo) && ID.test(id) ? { id, repo } : null
  }

  /** Where a release's file is published. Built from the list's repository and a tag that is a release; nothing else. */
  function assetUrl(source: Source, tag: string, file: string): string {
    return `https://github.com/${source.repo}/releases/download/${tag}/${file}`
  }

  /** Whether `tag` of the module has a bundle, and its published sha256. One small download; nothing else is asked. */
  async function find(source: Source, tag: string, signal?: AbortSignal): Promise<Found> {
    if (!isRelease(tag) || !REPO.test(source.repo) || !ID.test(source.id)) return { ok: false, none: true, why: `${tag} is not a release of ${source.repo}.` }
    const name = bundleArchiveName(source.id, tag.slice(1))
    const url = assetUrl(source, tag, name)
    try {
      const response = await getHttps(get, `${url}.sha256`, SMALL_TIMEOUT_MS, signal)
      if (response.status === 404) {
        await response.body?.cancel()
        return { ok: false, none: true, why: `${source.repo} ${tag} has no ready-built bundle.` }
      }
      if (!response.ok) {
        await response.body?.cancel()
        return { ok: false, none: false, why: `${source.repo} ${tag}'s bundle could not be asked for: ${response.status}.` }
      }
      const text = (await response.text()).slice(0, 1024)
      const sha256 = checksumOf(text)
      if (!sha256) return { ok: false, none: false, why: `${name}.sha256 on ${source.repo} ${tag} says no sha256.` }
      return { ok: true, tag, url, sha256 }
    } catch (error) {
      return { ok: false, none: false, why: `${source.repo} ${tag}'s bundle could not be asked for: ${(error as Error).message}` }
    }
  }

  /** The archive, its bytes counted into the job's step as they arrive and held to the cap. */
  async function download(url: string, job?: Job | null, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await getHttps(get, url, DOWNLOAD_TIMEOUT_MS, signal)
    if (!response.ok || !response.body) throw new Error(`The bundle could not be downloaded: ${response.status}.`)
    const said = Number(response.headers.get('content-length') ?? '')
    const total = Number.isFinite(said) && said > 0 ? said : null
    if (total !== null && total > BUNDLE_LIMITS.archiveBytes) throw new Error(`The bundle is ${sizeSaid(total)}, over the ${sizeSaid(BUNDLE_LIMITS.archiveBytes)} a bundle may be.`)
    const chunks: Uint8Array[] = []
    let got = 0
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.length
      if (got > BUNDLE_LIMITS.archiveBytes) {
        await reader.cancel()
        throw new Error(`The bundle is over the ${sizeSaid(BUNDLE_LIMITS.archiveBytes)} a bundle may be.`)
      }
      chunks.push(value)
      job?.received(got, total)
    }
    const out = new Uint8Array(got)
    let at = 0
    for (const chunk of chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  }

  /**
   * Download `tag`'s bundle and unpack it under `.incoming/`, every check made
   * first (`unpackBundle`). Nothing that runs is touched: this is what happens
   * while the old version keeps answering.
   */
  async function stage(source: Source, tag: string, job?: Job | null, signal?: AbortSignal, into?: string): Promise<Staged> {
    const found = await find(source, tag, signal)
    if (!found.ok) return { ok: false, why: found.why, none: found.none }
    job?.say('cloning', tag)
    let archive: Uint8Array
    try {
      archive = await download(found.url, job, signal)
    } catch (error) {
      return { ok: false, why: (error as Error).message }
    }
    job?.say('unpacking', tag)
    /* An install or an update unpacks beside the installed copy; a version pinned beside it unpacks where it will run (`into`). */
    const landing = into ?? incoming
    mkdirSync(landing, { recursive: true })
    const dir = join(landing, `${source.id}-${tag.slice(1)}-${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`)
    const unpacked = unpackBundle(archive, dir, { sha256: found.sha256, id: source.id, version: tag.slice(1), ...(deps.platform ? { platform: deps.platform } : {}) })
    if (!unpacked.ok) {
      log(`kehikko: ${source.id}: the bundle of ${tag} was refused: ${unpacked.why}`)
      return { ok: false, why: `${source.repo} ${tag}'s bundle was not installed: ${unpacked.why}` }
    }
    return { ok: true, dir: unpacked.dir, info: unpacked.info, bytes: archive.length }
  }

  /**
   * Put a staged bundle at `installed/<id>/`: what was there moves to
   * `.previous/<id>/` (an older previous is removed first). The module must not
   * be running. Two renames on one disk.
   */
  function swap(id: string, staged: string): Swapped {
    const current = join(deps.root, id)
    const kept = join(previous, id)
    mkdirSync(previous, { recursive: true })
    let was: Swapped['previous'] = null
    if (existsSync(current)) {
      rmSync(kept, { recursive: true, force: true })
      const release = bundleRelease(current)
      renameSync(current, kept)
      was = { dir: kept, bundle: release }
    }
    try {
      renameSync(staged, current)
    } catch (error) {
      if (was) renameSync(kept, current)
      throw error
    }
    return { id, to: bundleRelease(current) ?? '', previous: was }
  }

  /**
   * The new version did not answer: put the previous one back at
   * `installed/<id>/` and remove the one that failed. False when there is no
   * previous to go back to. The module must not be running.
   */
  function rollback(id: string): boolean {
    const current = join(deps.root, id)
    const kept = join(previous, id)
    if (!existsSync(kept)) return false
    const failed = join(incoming, `${id}-failed-${now().toString(36)}`)
    mkdirSync(incoming, { recursive: true })
    if (existsSync(current)) renameSync(current, failed)
    renameSync(kept, current)
    rmSync(failed, { recursive: true, force: true })
    return true
  }

  /**
   * The new version answers: keep one previous, unless it was a git checkout —
   * that one, and its `node_modules`, is what moving to bundles was for, and
   * goes now. Says what it freed.
   */
  function settle(id: string): { freed: { files: number; bytes: number } | null } {
    const kept = join(previous, id)
    let freed: { files: number; bytes: number } | null = null
    if (existsSync(kept) && !isBundle(kept)) {
      freed = sizeOf(kept)
      rmSync(kept, { recursive: true, force: true })
      log(`kehikko: ${id} runs from a bundle now; its git checkout was removed, freeing ${sizeSaid(freed.bytes)} in ${freed.files} files`)
    }
    sweepIncoming(id)
    return { freed }
  }

  /** Downloads of this module left by an attempt that did not finish. */
  function sweepIncoming(id: string): void {
    let names: string[] = []
    try {
      names = readdirSync(incoming)
    } catch {
      return
    }
    for (const name of names) if (name.startsWith(`${id}-`)) rmSync(join(incoming, name), { recursive: true, force: true })
  }

  /** A tag's protocol need: its package.json's pin, read once from GitHub's raw files (HTTPS) and kept. */
  async function needOf(source: Source, tag: string): Promise<string | null> {
    const key = `${source.repo}\u0000${tag}`
    const known = needs.get(key)
    if (known && (known.ok || now() - known.at < NEED_RETRY_MS)) return known.need
    try {
      const response = await getHttps(get, `https://raw.githubusercontent.com/${source.repo}/${tag}/package.json`, SMALL_TIMEOUT_MS)
      if (!response.ok) {
        await response.body?.cancel()
        needs.set(key, { need: null, at: now(), ok: response.status === 404 })
        return null
      }
      const need = protocolPin((await response.text()).slice(0, 256 * 1024))
      needs.set(key, { need, at: now(), ok: true })
      return need
    } catch {
      needs.set(key, { need: null, at: now(), ok: false })
      return null
    }
  }

  /**
   * The newest release this host can run, with the newest it cannot, from
   * `releases` (newest first) down to `floor`: each need read only as far as
   * the first release that runs.
   */
  async function pick(source: Source, releases: readonly string[], floor: string | null) {
    const entry = deps.entryProtocol?.(source.id)
    const read = new Map<string, string | null>()
    if (meetsProtocol(entry, have)) {
      for (const tag of releases) {
        if (floor && compareReleases(tag, floor) < 0) break
        const need = await needOf(source, tag)
        read.set(tag, need)
        if (need === null || meetsProtocol(need, have)) break
      }
    }
    const needOfRead = (tag: string) => read.get(tag) ?? null
    return { ...pickNewest(releases, needOfRead, { have, entry, floor }), needOf: needOfRead, entry }
  }

  /** The releases on the module's repository, newest first; the last list known when `fetch` is false. */
  async function releases(source: Source, fetch: boolean, fresh = true): Promise<{ releases: string[]; error: string | null }> {
    const url = `https://github.com/${source.repo}.git`
    if (!fetch || !deps.tags) return { releases: releasesOf.get(url) ?? [], error: null }
    const got = await deps.tags.tags(url, fresh)
    if (!got.ok) return { releases: releasesOf.get(url) ?? [], error: got.why }
    const list = releasesNewestFirst(got.tags)
    releasesOf.set(url, list)
    return { releases: list, error: null }
  }

  /**
   * An installed bundle read as an update reads a checkout: the release it is,
   * the newest this host can run, and the one an update moves it to. No git.
   */
  async function read(place: Place, fetch: boolean | 'compare'): Promise<Checkout> {
    const info = readBundleInfo(place.dir)!
    const installed = `v${info.version}`
    const source = sourceOf(place.id)
    const base: ModuleRelease = { follows: 'release', installed, newest: installed, target: null, notes: [installed], needsNewer: null, repo: source?.repo ?? null, error: null }
    const checkout: Checkout = {
      id: place.id,
      name: place.name,
      dir: place.dir,
      branch: null,
      commit: info.commit,
      dirty: false,
      upstream: null,
      behind: 0,
      ahead: 0,
      incoming: [],
      fetchFailed: null,
      blocked: 'already up to date',
      release: base,
    }
    if (!source) return { ...checkout, release: { ...base, error: 'it is on no module list, so where its releases are is not known' } }
    const listed = await releases(source, fetch !== false)
    const all = listed.releases.includes(installed) ? listed.releases : releasesNewestFirst([...listed.releases, installed])
    const picked = await pick(source, all, installed)
    const newest = picked.newest ?? installed
    const target = compareReleases(newest, installed) > 0 ? newest : null
    const notes = target ? notesBetween(all, installed, target) : [installed]
    const apps = deps.apps?.() ?? null
    const works = apps ? worksOf([installed, newest, target, ...notes, picked.needsNewer?.tag], picked.needOf, picked.entry, apps, have) : undefined
    const release: ModuleRelease = { ...base, newest, target, notes: notes.length ? notes : [installed], needsNewer: picked.needsNewer, error: listed.error, ...(works ? { works } : {}) }
    return {
      ...checkout,
      upstream: target,
      behind: target ? 1 : 0,
      fetchFailed: listed.error,
      blocked: target ? null : 'already up to date',
      release,
    }
  }

  /**
   * The release a fresh install should be: the newest this host can run, from
   * the repository's tags. Null when it has none (it is then installed from
   * git, on `main`, as before).
   */
  async function newestFor(source: Source): Promise<{ tag: string | null; needsNewer: { tag: string; protocol: string } | null; error: string | null }> {
    const listed = await releases(source, true)
    if (listed.error && listed.releases.length === 0) return { tag: null, needsNewer: null, error: listed.error }
    const picked = await pick(source, listed.releases, null)
    return { tag: picked.newest, needsNewer: picked.needsNewer, error: null }
  }

  /**
   * The releases of a module that carry a ready-built bundle, newest first: what a container can be
   * pinned to when the module has no git checkout (it was installed as a bundle). From the module's
   * GitHub releases, read as `releases` reads them, each one asked for its `.sha256` — one small
   * request, kept: a release that has a bundle always does, one that has none is asked again later
   * (a release publishes its bundle in the same run, so a miss is usually an old release). Only the
   * newest `PINNABLE` are asked about.
   */
  async function bundled(source: Source, fresh: boolean): Promise<{ tags: string[]; error: string | null }> {
    const listed = await releases(source, true, fresh)
    if (listed.error && listed.releases.length === 0) return { tags: [], error: listed.error }
    const considered = listed.releases.slice(0, PINNABLE)
    const answers = new Map<string, boolean>()
    let next = 0
    const worker = async () => {
      for (; next < considered.length; ) {
        const tag = considered[next++]!
        const key = `${source.repo}\u0000${tag}`
        const known = carries.get(key)
        if (known && !fresh && (known.has || now() - known.at < NEED_RETRY_MS)) {
          answers.set(tag, known.has)
          continue
        }
        const found = await find(source, tag)
        /* A failure that was not "there is none" is not remembered as one. */
        if (found.ok || found.none) carries.set(key, { has: found.ok, at: now() })
        answers.set(tag, found.ok)
      }
    }
    await Promise.all(Array.from({ length: Math.min(ASKS_AT_ONCE, considered.length) }, worker))
    return { tags: considered.filter((tag) => answers.get(tag) === true), error: listed.error }
  }

  /** The disk a folder holds: what a person is told moving to bundles freed. */
  function measure(dir: string): { files: number; bytes: number } {
    return existsSync(dir) && statSync(dir).isDirectory() ? sizeOf(dir) : { files: 0, bytes: 0 }
  }

  return { sourceOf, find, stage, swap, rollback, settle, read, newestFor, bundled, measure, sweepIncoming }
}

export type BundleDesk = ReturnType<typeof bundleDesk>
