import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bundleArchiveName, bundleRunScript, checksumLine, sha256, writeTarGz, type BundleInfo, type TarFile } from 'kehikot-module-protocol/bundle'

import { installDesk } from '../server/installs.ts'
import { Job } from '../server/jobSteps.ts'
import { bundleDesk, INCOMING, isBundle, PREVIOUS, type BundleDeps } from '../server/moduleBundles.ts'
import type { Official } from '../server/official.ts'
import { readCheckout, update, type Place } from '../server/updates.ts'
import type { Runner } from '../server/versions.ts'
import { barExplained, overallFraction, stepCounter } from '../src/host/jobSteps.ts'

/*
 * Installed modules as ready-built bundles, against a fake GitHub: the
 * download, every check before anything is written, the swap that keeps the
 * old version running until the restart, the rollback, and the move off a git
 * checkout that frees its node_modules.
 */

const REPO = 'Jalez/kehikko-sample'
const ID = 'kehikot.sample'
const sample: Official = { id: ID, name: 'Sample', repo: REPO, port: 7999, summary: 'A sample.', tags: [] }

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const fresh = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kehikot-bundles-')))
  scratch.push(dir)
  return dir
}

const text = (value: string) => new TextEncoder().encode(value)

function archiveOf(version: string, extra: TarFile[] = []): Uint8Array {
  const base = { id: ID, version, commit: version.replaceAll('.', '').padEnd(40, 'a'), entry: 'serve.ts' }
  const files: TarFile[] = [
    { path: 'serve.ts', data: text(`console.log(${JSON.stringify(version)})`) },
    { path: 'run.sh', data: text(bundleRunScript(base)), executable: true },
    { path: 'notes/1.0.0.md', data: text('Kind: feature\n- first') },
    ...extra,
  ]
  const info: BundleInfo = {
    format: 'kehikot.bundle',
    formatVersion: 1,
    ...base,
    protocol: '2.102.0',
    builtAt: '2026-11-18T00:00:00.000Z',
    bun: '1.4.0',
    platforms: null,
    native: [],
    files: Object.fromEntries(files.map((file) => [file.path, { sha256: sha256(file.data), size: file.data.length, ...(file.executable ? { executable: true } : {}) }])),
  }
  return writeTarGz([...files, { path: 'bundle.json', data: text(JSON.stringify(info)) }])
}

/** A fake github.com: releases with bundles, a redirect to the file host as GitHub does, raw package.json files. */
function github(releases: Record<string, { archive?: Uint8Array; sha?: string; protocol?: string }>, options: { insecure?: boolean } = {}) {
  const asked: string[] = []
  const get = async (url: string, _init?: RequestInit): Promise<Response> => {
    asked.push(url)
    const download = /^https:\/\/github\.com\/Jalez\/kehikko-sample\/releases\/download\/(v[\d.]+)\/(.+)$/.exec(url)
    if (download) {
      const [, tag, file] = download
      const release = releases[tag!]
      const name = bundleArchiveName(ID, tag!.slice(1))
      if (!release?.archive) return new Response('Not Found', { status: 404 })
      const to = `${options.insecure ? 'http' : 'https'}://objects.example.test/${tag}/${file}`
      if (file === name || file === `${name}.sha256`) return new Response(null, { status: 302, headers: { location: to } })
      return new Response('Not Found', { status: 404 })
    }
    const object = /^https:\/\/objects\.example\.test\/(v[\d.]+)\/(.+)$/.exec(url)
    if (object) {
      const release = releases[object[1]!]!
      const name = bundleArchiveName(ID, object[1]!.slice(1))
      if (object[2] === `${name}.sha256`) return new Response(release.sha ?? checksumLine(release.archive!, name))
      return new Response(release.archive! as Uint8Array<ArrayBuffer>, { headers: { 'content-length': String(release.archive!.length) } })
    }
    const raw = /^https:\/\/raw\.githubusercontent\.com\/Jalez\/kehikko-sample\/(v[\d.]+)\/package\.json$/.exec(url)
    if (raw) {
      const release = releases[raw[1]!]
      if (!release) return new Response('404', { status: 404 })
      return new Response(JSON.stringify({ version: raw[1]!.slice(1), dependencies: { 'kehikot-module-protocol': `git+https://x#v${release.protocol ?? '2.102.0'}` } }))
    }
    return new Response('unexpected', { status: 500 })
  }
  const tags = { tags: async () => ({ ok: true as const, tags: Object.keys(releases), at: 0 }) }
  return { get, tags, asked }
}

function desk(root: string, gh: ReturnType<typeof github>, more: Partial<BundleDeps> = {}) {
  return bundleDesk({ root, repoOf: (id) => (id === ID ? REPO : null), tags: gh.tags, fetch: gh.get, have: '2.102.0', ...more })
}

function job(): Job {
  return new Job(ID, 'Sample', 'update', Date.now, () => {}, () => {})
}

describe('finding and staging a bundle', () => {
  test('a release with no .sha256 has no bundle, and nothing else is asked', async () => {
    const gh = github({ 'v1.0.0': {} })
    const found = await desk(fresh(), gh).find({ id: ID, repo: REPO }, 'v1.0.0')
    expect(found.ok).toBe(false)
    expect(!found.ok && found.none).toBe(true)
    expect(gh.asked).toEqual([`https://github.com/${REPO}/releases/download/v1.0.0/kehikot.sample-1.0.0.tar.gz.sha256`])
  })

  test('a bundle is downloaded with its bytes counted, checked, and unpacked under .incoming', async () => {
    const root = fresh()
    const gh = github({ 'v1.0.0': { archive: archiveOf('1.0.0') } })
    const j = job()
    const staged = await desk(root, gh).stage({ id: ID, repo: REPO }, 'v1.0.0', j)
    expect(staged.ok).toBe(true)
    if (!staged.ok) return
    expect(staged.dir.startsWith(join(root, INCOMING))).toBe(true)
    expect(isBundle(staged.dir)).toBe(true)
    expect(readFileSync(join(staged.dir, 'serve.ts'), 'utf8')).toBe('console.log("1.0.0")')
    const said = j.said()
    expect(said.bundle).toBe(true)
    expect(said.step).toBe('unpacking')
    expect(said.steps.some((one) => one.step === 'cloning')).toBe(true)
  })

  test('a sha256 that does not match, a tampered archive, or another module is refused, and nothing is left', async () => {
    const root = fresh()
    const wrong = github({ 'v1.0.0': { archive: archiveOf('1.0.0'), sha: `${'0'.repeat(64)}  x` } })
    const no = await desk(root, wrong).stage({ id: ID, repo: REPO }, 'v1.0.0')
    expect(no.ok).toBe(false)
    expect(!no.ok && no.why).toMatch(/sha256/)
    const other = github({ 'v1.0.0': { archive: archiveOf('1.0.1') } })
    expect((await desk(root, other).stage({ id: ID, repo: REPO }, 'v1.0.0')).ok).toBe(false)
    expect(existsSync(join(root, INCOMING)) ? readdirSync(join(root, INCOMING)) : []).toEqual([])
  })

  test('a redirect to anything but HTTPS is never followed', async () => {
    const gh = github({ 'v1.0.0': { archive: archiveOf('1.0.0') } }, { insecure: true })
    const staged = await desk(fresh(), gh).stage({ id: ID, repo: REPO }, 'v1.0.0')
    expect(staged.ok).toBe(false)
    expect(gh.asked.some((url) => url.startsWith('http://'))).toBe(false)
  })

  test('only the list’s repository is ever asked, and only for a release tag', async () => {
    const gh = github({})
    const d = desk(fresh(), gh)
    expect(d.sourceOf('kehikot.unknown')).toBeNull()
    expect((await d.find({ id: ID, repo: REPO }, 'main')).ok).toBe(false)
    expect((await d.find({ id: ID, repo: '../evil' }, 'v1.0.0')).ok).toBe(false)
    expect(gh.asked).toEqual([])
  })
})

describe('swapping, rolling back and settling', () => {
  test('a swap keeps the previous version beside it; a rollback puts it back', async () => {
    const root = fresh()
    const gh = github({ 'v1.0.0': { archive: archiveOf('1.0.0') }, 'v1.1.0': { archive: archiveOf('1.1.0') } })
    const d = desk(root, gh)
    const first = await d.stage({ id: ID, repo: REPO }, 'v1.0.0')
    if (!first.ok) throw new Error(first.why)
    d.swap(ID, first.dir)
    const second = await d.stage({ id: ID, repo: REPO }, 'v1.1.0')
    if (!second.ok) throw new Error(second.why)
    const swapped = d.swap(ID, second.dir)
    expect(swapped.to).toBe('v1.1.0')
    expect(swapped.previous?.bundle).toBe('v1.0.0')
    expect(readFileSync(join(root, ID, 'serve.ts'), 'utf8')).toBe('console.log("1.1.0")')
    expect(d.rollback(ID)).toBe(true)
    expect(readFileSync(join(root, ID, 'serve.ts'), 'utf8')).toBe('console.log("1.0.0")')
    expect(existsSync(join(root, PREVIOUS, ID))).toBe(false)
    expect(d.rollback(ID)).toBe(false)
  })

  test('moving off a git checkout removes it, node_modules and all, once the bundle answers, and says what it freed', async () => {
    const root = fresh()
    const checkout = join(root, ID)
    mkdirSync(join(checkout, '.git'), { recursive: true })
    mkdirSync(join(checkout, 'node_modules', 'react'), { recursive: true })
    writeFileSync(join(checkout, 'node_modules', 'react', 'index.js'), 'x'.repeat(50_000))
    const gh = github({ 'v1.1.0': { archive: archiveOf('1.1.0') } })
    const d = desk(root, gh)
    const staged = await d.stage({ id: ID, repo: REPO }, 'v1.1.0')
    if (!staged.ok) throw new Error(staged.why)
    const swapped = d.swap(ID, staged.dir)
    expect(swapped.previous?.bundle).toBeNull()
    expect(existsSync(join(root, PREVIOUS, ID, 'node_modules'))).toBe(true)
    const settled = d.settle(ID)
    expect(settled.freed?.bytes).toBeGreaterThanOrEqual(50_000)
    expect(existsSync(join(root, PREVIOUS, ID))).toBe(false)
    expect(isBundle(join(root, ID))).toBe(true)
  })

  test('settling keeps one previous bundle for the next rollback', async () => {
    const root = fresh()
    const gh = github({ 'v1.0.0': { archive: archiveOf('1.0.0') }, 'v1.1.0': { archive: archiveOf('1.1.0') } })
    const d = desk(root, gh)
    for (const tag of ['v1.0.0', 'v1.1.0']) {
      const staged = await d.stage({ id: ID, repo: REPO }, tag)
      if (!staged.ok) throw new Error(staged.why)
      d.swap(ID, staged.dir)
    }
    expect(d.settle(ID).freed).toBeNull()
    expect(isBundle(join(root, PREVIOUS, ID))).toBe(true)
  })
})

describe('reading and updating an installed bundle', () => {
  const placeIn = (root: string, gh: ReturnType<typeof github>, have = '2.102.0'): Place => ({ id: ID, name: 'Sample', dir: join(root, ID), bundles: desk(root, gh, { have }) })

  async function installed(root: string, gh: ReturnType<typeof github>, tag: string) {
    const d = desk(root, gh)
    const staged = await d.stage({ id: ID, repo: REPO }, tag)
    if (!staged.ok) throw new Error(staged.why)
    d.swap(ID, staged.dir)
  }

  test('it reads as a release with no git: the one it is, and the newest this host can run', async () => {
    const root = fresh()
    const gh = github({ 'v1.0.0': { archive: archiveOf('1.0.0') }, 'v1.1.0': { archive: archiveOf('1.1.0') }, 'v1.2.0': { archive: archiveOf('1.2.0'), protocol: '2.200.0' } })
    await installed(root, gh, 'v1.0.0')
    const reading = await readCheckout(placeIn(root, gh), true)
    if ('error' in reading) throw new Error(reading.error)
    expect(reading.release?.installed).toBe('v1.0.0')
    expect(reading.release?.target).toBe('v1.1.0')
    expect(reading.release?.needsNewer).toEqual({ tag: 'v1.2.0', protocol: '2.200.0' })
    expect(reading.release?.notes).toEqual(['v1.1.0'])
    expect(reading.blocked).toBeNull()
  })

  test('an update downloads and checks BEFORE the module is stopped, then swaps', async () => {
    const root = fresh()
    const gh = github({ 'v1.0.0': { archive: archiveOf('1.0.0') }, 'v1.1.0': { archive: archiveOf('1.1.0') } })
    await installed(root, gh, 'v1.0.0')
    const order: string[] = []
    const place: Place = {
      id: ID,
      name: 'Sample',
      dir: join(root, ID),
      bundles: bundleDesk({ root, repoOf: () => REPO, tags: gh.tags, have: '2.102.0', fetch: async (url, init) => {
        if (url.endsWith('.tar.gz')) order.push('downloaded')
        return gh.get(url, init)
      } }),
    }
    await readCheckout(place, true)
    const done = await update(place, undefined, {
      merged: (changed) => {
        order.push('stopped')
        expect(changed).toContain('run.sh')
        expect(readFileSync(join(root, ID, 'serve.ts'), 'utf8')).toBe('console.log("1.0.0")')
      },
    })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(order[0]).toBe('downloaded')
    expect(order).toContain('stopped')
    expect(done.swapped?.from).toBe('v1.0.0')
    expect(done.swapped?.to).toBe('v1.1.0')
    expect(readFileSync(join(root, ID, 'serve.ts'), 'utf8')).toBe('console.log("1.1.0")')
  })

  test('a bundle that fails its checks is not swapped in, and the running version is untouched', async () => {
    const root = fresh()
    const gh = github({ 'v1.0.0': { archive: archiveOf('1.0.0') }, 'v1.1.0': { archive: archiveOf('1.1.0'), sha: `${'1'.repeat(64)}  x` } })
    await installed(root, gh, 'v1.0.0')
    let stopped = false
    const place = placeIn(root, gh)
    await readCheckout(place, true)
    const done = await update(place, undefined, { merged: () => void (stopped = true) })
    expect(done.ok).toBe(false)
    expect(stopped).toBe(false)
    expect(readFileSync(join(root, ID, 'serve.ts'), 'utf8')).toBe('console.log("1.0.0")')
  })
})

describe('installing', () => {
  test('a release with a bundle is installed from it: no clone, no bun install, no build', async () => {
    const base = fresh()
    const root = join(base, 'installed')
    const registry = join(base, 'modules')
    const gh = github({ 'v1.0.0': { archive: archiveOf('1.0.0') } })
    const ran: string[][] = []
    const run: Runner = async (argv) => {
      ran.push([...argv])
      return { ok: false, why: 'nothing should run' }
    }
    let built = false
    const installs = installDesk({
      list: [sample],
      run,
      root,
      registry,
      registered: async () => (existsSync(registry) ? readdirSync(registry).map((name) => ({ id: name.replace(/\.json$/, ''), port: null })) : []),
      build: async () => void (built = true),
      bundles: desk(root, gh),
    })
    expect((await installs.install(ID)).ok).toBe(true)
    for (let i = 0; i < 200 && !existsSync(join(registry, `${ID}.json`)); i++) await new Promise((done) => setTimeout(done, 5))
    const registration = JSON.parse(readFileSync(join(registry, `${ID}.json`), 'utf8'))
    expect(registration.dir).toBe(join(root, ID))
    expect(isBundle(join(root, ID))).toBe(true)
    expect(ran).toEqual([])
    expect(built).toBe(false)
  })

  test('a release with no bundle goes the git path, as before', async () => {
    const base = fresh()
    const root = join(base, 'installed')
    const gh = github({ 'v1.0.0': {} })
    const ran: string[] = []
    const run: Runner = async (argv) => {
      ran.push(argv.join(' '))
      return { ok: false, why: 'offline' }
    }
    const installs = installDesk({ list: [sample], run, root, registry: join(base, 'modules'), registered: async () => [], bundles: desk(root, gh) })
    await installs.install(ID)
    for (let i = 0; i < 200 && !ran.some((line) => line.includes('clone')); i++) await new Promise((done) => setTimeout(done, 5))
    expect(ran.some((line) => line.startsWith('git clone'))).toBe(true)
  })
})

describe('the steps a person sees', () => {
  test('a bundle job counts real bytes, and is a short sequence', () => {
    const j = job()
    j.to('cloning', 'v1.1.0')
    j.received(512, 1024)
    const said = j.said()
    expect(said.fraction).toBe(0.5)
    expect(said.bytes).toBe(512)
    expect(stepCounter(said)).toEqual({ at: 1, of: 4 })
    expect(overallFraction(said)).toBeGreaterThan(0)
    expect(barExplained(said)).toMatch(/ready-built/)
  })
})

describe('versions of a module installed as a bundle', () => {
  test('lists only the releases that carry a bundle, newest first, and remembers what it was told', async () => {
    const gh = github({ 'v1.0.0': {}, 'v1.1.0': { archive: archiveOf('1.1.0') }, 'v1.2.0': { archive: archiveOf('1.2.0') }, 'v1.3.0': {} })
    const bundles = desk(fresh(), gh)
    const source = { id: ID, repo: REPO }
    const first = await bundles.bundled(source, false)
    expect(first).toEqual({ tags: ['v1.2.0', 'v1.1.0'], error: null })
    const asks = gh.asked.length
    expect((await bundles.bundled(source, false)).tags).toEqual(['v1.2.0', 'v1.1.0'])
    /* The ones with a bundle are known for good; the ones with none are asked again only after a while. */
    expect(gh.asked.length).toBe(asks)
  })

  test('says why when the releases cannot be read, and lists none', async () => {
    const gh = github({})
    const bundles = bundleDesk({ root: fresh(), repoOf: () => REPO, fetch: gh.get, have: '2.102.0', tags: { tags: async () => ({ ok: false as const, why: 'offline', at: 0 }) } })
    expect(await bundles.bundled({ id: ID, repo: REPO }, true)).toEqual({ tags: [], error: 'offline' })
  })
})
