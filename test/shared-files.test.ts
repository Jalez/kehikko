import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  cachedPackage,
  dropDevCache,
  due,
  emptyRecord,
  ownBytes,
  privateBytes,
  readRecord,
  recordVersions,
  reshare,
  RESHARE_EVERY_MS,
  sameBytes,
  slimPass,
  writeRecord,
} from '../server/sharedFiles.ts'
import { measure } from '../server/storage.ts'
import { PRUNE_AFTER_MS, SourceMaterialiser } from '../server/versionRuns.ts'
import { savedSaid } from '../src/host/storage.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-shared-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let made = 0
const scratch = (name: string) => {
  const dir = join(root, `${name}-${(made += 1)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const big = (seed: number) => Buffer.alloc(256 * 1024, seed)

/** A package cache holding `left-pad@1.0.0`, and a copy whose `node_modules` has the same package written out on its own. */
function world() {
  const cache = scratch('cache')
  const copy = scratch('copy')
  const cached = join(cache, 'left-pad@1.0.0@@@1')
  const installed = join(copy, 'node_modules', 'left-pad')
  for (const dir of [cached, installed]) {
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.0.0' }))
    writeFileSync(join(dir, 'lib', 'big.bin'), big(7))
    writeFileSync(join(dir, 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
  }
  /* The same name, different bytes: never replaced. */
  writeFileSync(join(cached, 'lib', 'other.bin'), big(1))
  writeFileSync(join(installed, 'lib', 'other.bin'), big(2))
  /* A package the cache does not hold. */
  mkdirSync(join(copy, 'node_modules', '@scope', 'mine'), { recursive: true })
  writeFileSync(join(copy, 'node_modules', '@scope', 'mine', 'package.json'), JSON.stringify({ name: '@scope/mine', version: '2.0.0' }))
  writeFileSync(join(copy, 'node_modules', '@scope', 'mine', 'data.bin'), big(3))
  return { cache, copy, installed }
}

/* Clones are an APFS thing: the resharing itself is asked of the file system on macOS only. */
const apfs = privateBytes() !== null

describe('resharing package files with the package cache', () => {
  test('finds the cache’s folder for a package by name and version, and nothing for one it does not hold', () => {
    const { cache, copy, installed } = world()
    expect(cachedPackage(cache, installed)).toBe(join(cache, 'left-pad@1.0.0@@@1'))
    expect(cachedPackage(cache, join(copy, 'node_modules', '@scope', 'mine'))).toBeNull()
    expect(cachedPackage(cache, join(copy, 'nothing'))).toBeNull()
  })

  test('compares bytes, not names', async () => {
    const { cache, installed } = world()
    expect(await sameBytes(join(installed, 'lib', 'big.bin'), join(cache, 'left-pad@1.0.0@@@1', 'lib', 'big.bin'))).toBe(true)
    expect(await sameBytes(join(installed, 'lib', 'other.bin'), join(cache, 'left-pad@1.0.0@@@1', 'lib', 'other.bin'))).toBe(false)
  })

  test('without a way to see sharing, nothing is touched', async () => {
    const { cache, copy } = world()
    const done = await reshare(copy, { cache, privateBytes: () => null })
    expect(done).toMatchObject({ files: 0, bytes: 0 })
  })

  test('nested packages are looked at, each once', async () => {
    const { cache, copy, installed } = world()
    /* left-pad depends on its own copy of inner, which depends on deeper. */
    for (const [dir, name] of [
      [join(installed, 'node_modules', 'inner'), 'inner'],
      [join(installed, 'node_modules', 'inner', 'node_modules', 'deeper'), 'deeper'],
      [join(cache, 'inner@1.0.0@@@1'), 'inner'],
      [join(cache, 'deeper@1.0.0@@@1'), 'deeper'],
    ] as const) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
      writeFileSync(join(dir, 'x.bin'), big(9))
    }
    const counted = await reshare(copy, { cache, privateBytes: (path) => statSync(path).size, dryRun: true })
    /* big.bin, cli.js, package.json of left-pad; package.json and x.bin of inner and deeper. */
    expect(counted.files).toBe(7)
  })

  test.skipIf(!apfs)('identical files become clones of the cache’s, content and mode kept; a dry run changes nothing', async () => {
    const own = privateBytes()!
    const { cache, copy, installed } = world()
    const file = join(installed, 'lib', 'big.bin')
    const cli = join(installed, 'cli.js')
    expect(own(file)).toBeGreaterThan(0)

    const dry = await reshare(copy, { cache, privateBytes: own, dryRun: true })
    expect(dry.files).toBe(3)
    expect(dry.bytes).toBeGreaterThan(256 * 1024 - 1)
    expect(own(file)).toBeGreaterThan(0)

    const done = await reshare(copy, { cache, privateBytes: own })
    expect(done.files).toBe(3)
    expect(done.bytes).toBe(dry.bytes)
    expect(own(file)).toBe(0)
    expect(readFileSync(file).equals(big(7))).toBe(true)
    expect(statSync(cli).mode & 0o777).toBe(0o755)
    /* Different bytes, and a package the cache lacks, stay the copy's own. */
    expect(own(join(installed, 'lib', 'other.bin'))).toBeGreaterThan(0)
    expect(readFileSync(join(installed, 'lib', 'other.bin')).equals(big(2))).toBe(true)
    expect(own(join(copy, 'node_modules', '@scope', 'mine', 'data.bin'))).toBeGreaterThan(0)
    expect(done.own).toBeGreaterThanOrEqual(2 * 256 * 1024)

    /* Nothing left to do the second time. */
    expect((await reshare(copy, { cache, privateBytes: own })).files).toBe(0)
  })
})

describe('Vite’s cache in a copy', () => {
  test('is removed and its size said; a dry run only says', async () => {
    const copy = scratch('vite')
    mkdirSync(join(copy, 'node_modules', '.vite', 'deps'), { recursive: true })
    writeFileSync(join(copy, 'node_modules', '.vite', 'deps', 'react.js'), big(4))
    expect(await dropDevCache(copy, null, true)).toBeGreaterThan(0)
    expect(existsSync(join(copy, 'node_modules', '.vite'))).toBe(true)
    expect(await dropDevCache(copy, null)).toBeGreaterThan(0)
    expect(existsSync(join(copy, 'node_modules', '.vite'))).toBe(false)
    expect(await dropDevCache(copy, null)).toBe(0)
  })
})

describe('one pass, and what it keeps', () => {
  test('a copy is looked at once a week or when its commit moves; busy copies wait; Vite’s cache goes only from a built copy', async () => {
    const installs = scratch('installed')
    const built = join(installs, 'kehikot.built')
    const source = join(installs, 'kehikot.source')
    const busy = join(installs, 'kehikot.busy')
    for (const dir of [built, source, busy]) {
      mkdirSync(join(dir, 'node_modules', '.vite'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', '.vite', 'x.js'), big(5))
    }
    let now = 1_000_000
    const copies = [
      { dir: built, head: 'a', built: true },
      { dir: source, head: 'b', built: false },
      { dir: busy, head: 'c', built: true },
    ]
    const first = await slimPass(copies, { root: installs, cache: null, privateBytes: null, busy: (dir) => dir === busy, now: () => now })
    expect(first.caches).toBeGreaterThan(0)
    expect(existsSync(join(built, 'node_modules', '.vite'))).toBe(false)
    expect(existsSync(join(source, 'node_modules', '.vite'))).toBe(true)
    expect(existsSync(join(busy, 'node_modules', '.vite'))).toBe(true)

    const record = readRecord(installs)
    expect(record.at).toBe(now)
    expect(Object.keys(record.copies).sort()).toEqual([built, source].sort())
    expect(record.caches).toBe(first.caches)

    expect(due(record, built, 'a', now + 1)).toBe(false)
    expect(due(record, built, 'a2', now + 1)).toBe(true)
    expect(due(record, built, 'a', now + RESHARE_EVERY_MS)).toBe(true)
    expect(due(record, busy, 'c', now + 1)).toBe(true)

    /* The busy one, free now, is looked at; the others are not due. */
    now += 10
    mkdirSync(join(built, 'node_modules', '.vite'), { recursive: true })
    writeFileSync(join(built, 'node_modules', '.vite', 'x.js'), big(5))
    await slimPass(copies, { root: installs, cache: null, privateBytes: null, busy: () => false, now: () => now })
    expect(existsSync(join(busy, 'node_modules', '.vite'))).toBe(false)
    expect(existsSync(join(built, 'node_modules', '.vite'))).toBe(true)

    /* A copy that is gone is forgotten. */
    rmSync(source, { recursive: true })
    await slimPass(copies, { root: installs, cache: null, privateBytes: null, busy: () => false, now: () => now })
    expect(readRecord(installs).copies[source]).toBeUndefined()
  })

  test('a broken record reads as an empty one, and versions add to it', () => {
    const installs = scratch('record')
    writeFileSync(join(installs, '.shared.json'), '{nope')
    expect(readRecord(installs)).toEqual(emptyRecord())
    writeRecord(installs, { ...emptyRecord(), at: 5 })
    recordVersions(installs, 1234)
    expect(readRecord(installs)).toMatchObject({ at: 5, versions: 1234 })
  })

  test('the Storage view says it once a pass has run, and the report carries it', async () => {
    expect(savedSaid(undefined)).toBeNull()
    expect(savedSaid({ at: null, counted: 1, own: 0, given: 0 })).toBeNull()
    const said = savedSaid({ at: 1, counted: 5_000_000_000, own: 1_000_000_000, given: 700_000_000 })
    expect(said).toContain('5 GB')
    expect(said).toContain('1 GB')
    expect(said).toContain('700 MB')

    const machine = scratch('machine')
    const installed = join(machine, 'installed')
    mkdirSync(installed)
    writeRecord(installed, { at: 9, reshared: 10, caches: 20, versions: 30, copies: { [join(installed, 'x')]: { at: 9, head: 'h', counted: 100, own: 40 } } })
    const at = { machine, frame: join(machine, 'frame.sqlite'), registry: join(machine, 'modules'), officialList: join(machine, 'o.json'), versions: join(machine, 'versions'), installed, browserProfile: join(machine, 'b'), logs: join(machine, 'logs') }
    const report = await measure([], [], { at })
    expect(report.machine.saved).toEqual({ at: 9, counted: 100, own: 40, given: 60 })
  })
})

describe('pruning versions nobody pins', () => {
  const sh = (dir: string, ...args: string[]) => {
    const done = Bun.spawnSync(['git', '-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdout: 'pipe', stderr: 'pipe' })
    if (done.exitCode !== 0) throw new Error(done.stderr.toString())
    return done.stdout.toString().trim()
  }

  async function prepared(tags: string[]) {
    const checkout = scratch('checkout')
    sh(checkout, 'init', '-q', '-b', 'main')
    writeFileSync(join(checkout, 'run.sh'), '#!/bin/sh\necho one\n', { mode: 0o755 })
    sh(checkout, 'add', 'run.sh')
    sh(checkout, 'commit', '-qm', 'one')
    for (const tag of tags) sh(checkout, 'tag', tag)
    const versions = scratch('versions')
    const materialiser = new SourceMaterialiser(versions)
    for (const tag of tags) {
      expect(await materialiser.prepare({ id: 'kehikot.scratch', name: 'Scratch', dir: checkout, remote: checkout }, tag, () => {})).toMatchObject({ ok: true })
    }
    return { versions, materialiser, home: join(versions, 'kehikot.scratch') }
  }

  test('an unpinned version is marked, kept through the grace period, then removed; the mirror stays and pinning it again prepares it', async () => {
    const { materialiser, home } = await prepared(['v1.0.0', 'v1.1.0'])
    const t0 = 1_000_000_000
    const pinned = new Set(['kehikot.scratch@v1.1.0'])
    expect(await materialiser.prune(pinned, new Set(), { now: t0 })).toBe(0)
    expect(existsSync(join(home, 'v1.0.0.unpinned'))).toBe(true)
    expect(existsSync(join(home, 'v1.1.0.unpinned'))).toBe(false)

    expect(await materialiser.prune(pinned, new Set(), { now: t0 + PRUNE_AFTER_MS - 1 })).toBe(0)
    expect(materialiser.prepared('kehikot.scratch', 'v1.0.0')).not.toBeNull()

    const freed = await materialiser.prune(pinned, new Set(), { now: t0 + PRUNE_AFTER_MS, measure: (dir) => ownBytes(dir, null) })
    expect(freed).toBeGreaterThan(0)
    expect(existsSync(join(home, 'v1.0.0'))).toBe(false)
    expect(existsSync(join(home, 'v1.0.0.ready'))).toBe(false)
    expect(existsSync(join(home, 'v1.0.0.unpinned'))).toBe(false)
    expect(materialiser.prepared('kehikot.scratch', 'v1.0.0')).toBeNull()
    expect(materialiser.prepared('kehikot.scratch', 'v1.1.0')).not.toBeNull()
    expect(existsSync(join(home, 'repo.git', 'HEAD'))).toBe(true)
    expect(sh(join(home, 'repo.git'), 'worktree', 'list')).not.toContain('v1.0.0')
  })

  test('a pin that comes back takes the mark off, and a running version is never removed', async () => {
    const { materialiser, home } = await prepared(['v2.0.0'])
    const t0 = 2_000_000_000
    await materialiser.prune(new Set(), new Set(), { now: t0 })
    expect(existsSync(join(home, 'v2.0.0.unpinned'))).toBe(true)
    await materialiser.prune(new Set(['kehikot.scratch@v2.0.0']), new Set(), { now: t0 + 1 })
    expect(existsSync(join(home, 'v2.0.0.unpinned'))).toBe(false)

    await materialiser.prune(new Set(), new Set(), { now: t0 + 2 })
    await materialiser.prune(new Set(), new Set(['kehikot.scratch@v2.0.0']), { now: t0 + 2 + PRUNE_AFTER_MS })
    expect(materialiser.prepared('kehikot.scratch', 'v2.0.0')).not.toBeNull()
  })
})

describe('where the package cache is', () => {
  test('asked of the host’s own Bun inside a copy, and only a folder that is there is taken', async () => {
    const { packageCache } = await import('../server/sharedFiles.ts')
    const there = scratch('cache-there')
    const asked: { argv: readonly string[]; cwd?: string }[] = []
    const own = { bun: '/the/bun', env: { BUN_BE_BUN: '1' } }
    const said = await packageCache(async (argv, options) => (asked.push({ argv, ...(options?.cwd ? { cwd: options.cwd } : {}) }), { ok: true, out: there }), own, '/a/copy')
    expect(said).toBe(there)
    expect(asked).toEqual([{ argv: ['/the/bun', 'pm', 'cache'], cwd: '/a/copy' }])
    expect(await packageCache(async () => ({ ok: true, out: join(there, 'nope') }), own, '/a/copy')).toBeNull()
    expect(await packageCache(async () => ({ ok: false }), own, '/a/copy')).toBeNull()
  })
})
