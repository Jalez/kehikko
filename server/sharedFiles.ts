import { chmodSync, constants, copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { lstat, open, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { dlopen, FFIType, ptr } from 'bun:ffi'

/**
 * Keeping installed copies small on the disk, without changing a byte any of
 * them runs.
 *
 * ## What takes the room, and what does not
 *
 * An installed copy is a clone of its repository and a `bun install`: almost
 * all of it is `node_modules`, around 200 MB per copy as `du` or the Finder
 * count it. On APFS Bun installs a package by cloning the files of its package
 * cache (`clonefile`), so a copy's packages share their blocks with that cache
 * and with every other copy of the same package: counted 200 MB, but most of
 * it takes no extra room.
 *
 * That sharing wears off. When Bun replaces a package in its cache (a cache
 * that was cleared, a package fetched again), the copies installed from the old
 * file keep their blocks alone, and the next install of the same package
 * clones the new file. The bytes are identical; the room is paid twice. On the
 * machine this was written on that came to about three quarters of everything
 * the installed copies took on their own.
 *
 * ## What this does
 *
 *  - `reshare`: for each file of an installed copy's packages that shares
 *    nothing, when the package cache holds the same package at the same
 *    version and the cache's file is byte for byte the same, the copy's file
 *    is replaced by a clone of the cache's (written beside it, renamed over
 *    it, its mode kept). Nothing is fetched, no script runs, no file changes
 *    content; a file that differs in any byte is left as it is.
 *  - `dropDevCache`: Vite's pre-bundling cache (`node_modules/.vite`) in a copy
 *    that serves its build. Vite writes it again on its first start should
 *    the copy ever run from source.
 *
 * Both run only on copies this host installed (`installsDir`) and prepared
 * versions (`versionsDir`), never on a checkout somebody registered, and only
 * while the copy is not running (the caller's rule, `server.ts`).
 *
 * ## Where APFS sharing cannot be seen
 *
 * Whether a file shares its blocks is asked of the file system
 * (`getattrlist`, `ATTR_CMNEXT_PRIVATESIZE`). Off macOS, or when it cannot be
 * asked, `privateBytes` is null and nothing is reshared: without it every
 * file would have to be read to find the few that need it.
 */

/** How long a copy that was looked at is left alone, unless its commit moved. */
export const RESHARE_EVERY_MS = 7 * 24 * 60 * 60_000

/** Read this much of two files at a time when comparing them. */
const CHUNK = 1 << 20

/** One file's bytes that share nothing with any other file, or null when the file system cannot say. */
export type PrivateBytes = (path: string) => number | null

let asked: PrivateBytes | null | undefined

/**
 * The file system's own count of a file's unshared bytes, on macOS (APFS).
 * Null off macOS, when the call is not there, or for a file it cannot read.
 */
export function privateBytes(): PrivateBytes | null {
  if (asked !== undefined) return asked
  asked = null
  if (process.platform !== 'darwin') return asked
  try {
    const lib = dlopen('/usr/lib/libSystem.B.dylib', {
      getattrlist: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    })
    /* struct attrlist: bitmapcount, reserved, then five attribute groups; the
       fork group's ATTR_CMNEXT_PRIVATESIZE (0x8), with FSOPT_NOFOLLOW (0x1)
       and FSOPT_ATTR_CMN_EXTENDED (0x20). The answer is a length and an off_t. */
    const list = new Uint8Array(24)
    new DataView(list.buffer).setUint16(0, 5, true)
    new DataView(list.buffer).setUint32(20, 0x8, true)
    const out = new Uint8Array(12)
    const view = new DataView(out.buffer)
    const call: PrivateBytes = (path) => {
      const name = Buffer.from(`${path}\0`)
      const done = lib.symbols.getattrlist(ptr(name), ptr(list), ptr(out), 12, 0x1 | 0x20)
      return done === 0 ? Number(view.getBigInt64(4, true)) : null
    }
    /* Asked once of something that is surely there before it is trusted. */
    if (call(process.execPath) === null) return asked
    asked = call
  } catch {
    asked = null
  }
  return asked
}

/** What one pass over one copy came to. */
export interface Reshared {
  /** Files now sharing their blocks with the package cache. */
  files: number
  /** The room they gave back. */
  bytes: number
  /** Every package file's size as counted, and how much of it is the copy's own after the pass. */
  counted: number
  own: number
}

export interface ReshareOptions {
  /** The package cache: `bun pm cache`. */
  cache: string
  privateBytes: PrivateBytes
  /** Count what would be given back, and change nothing. */
  dryRun?: boolean
  /** Let the rest of the process run now and then. */
  yieldEvery?: number
}

const pause = () => new Promise<void>((done) => setImmediate(done))

/** The package directories under a `node_modules`, nested ones included, each once. */
async function packagesUnder(modules: string): Promise<string[]> {
  const out: string[] = []
  const pending = [modules]
  while (pending.length) {
    const at = pending.pop()!
    const found: string[] = []
    for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const path = join(at, entry.name)
      if (entry.name.startsWith('@')) {
        for (const inner of await readdir(path, { withFileTypes: true }).catch(() => [])) {
          if (inner.isDirectory()) found.push(join(path, inner.name))
        }
      } else found.push(path)
    }
    for (const pkg of found) {
      out.push(pkg)
      const nested = join(pkg, 'node_modules')
      if (existsSync(nested)) pending.push(nested)
    }
  }
  return out
}

/** A package's own files, relative to it: its nested `node_modules` and links left out. */
async function filesOf(root: string, at = '', out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(join(root, at), { withFileTypes: true }).catch(() => [])) {
    const rel = at ? join(at, entry.name) : entry.name
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') await filesOf(root, rel, out)
    } else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** The package cache's folder for a package, by Bun's naming (`name@version@@@1`); null when it has none. */
export function cachedPackage(cache: string, pkg: string): string | null {
  let manifest: { name?: unknown; version?: unknown }
  try {
    manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return null
  if (manifest.name.includes('..') || manifest.version.includes('/')) return null
  const dir = join(cache, `${manifest.name}@${manifest.version}@@@1`)
  return existsSync(dir) ? dir : null
}

/** Whether two files hold exactly the same bytes. */
export async function sameBytes(a: string, b: string, size = Number.POSITIVE_INFINITY): Promise<boolean> {
  if (size <= CHUNK) {
    const [x, y] = await Promise.all([readFile(a), readFile(b)])
    return x.equals(y)
  }
  const [one, two] = await Promise.all([open(a, 'r'), open(b, 'r')])
  try {
    const [x, y] = [Buffer.allocUnsafe(CHUNK), Buffer.allocUnsafe(CHUNK)]
    for (;;) {
      const [r1, r2] = await Promise.all([one.read(x, 0, CHUNK, null), two.read(y, 0, CHUNK, null)])
      if (r1.bytesRead !== r2.bytesRead) return false
      if (r1.bytesRead === 0) return true
      if (!x.subarray(0, r1.bytesRead).equals(y.subarray(0, r2.bytesRead))) return false
    }
  } finally {
    await Promise.all([one.close(), two.close()])
  }
}

/**
 * Replace the files of a copy's packages that share nothing with clones of
 * the package cache's identical files. See the top of this file.
 */
export async function reshare(copy: string, options: ReshareOptions): Promise<Reshared> {
  const done: Reshared = { files: 0, bytes: 0, counted: 0, own: 0 }
  const every = options.yieldEvery ?? 200
  let seen = 0
  for (const pkg of await packagesUnder(join(copy, 'node_modules'))) {
    const cached = cachedPackage(options.cache, pkg)
    for (const rel of await filesOf(pkg)) {
      if (++seen % every === 0) await pause()
      const file = join(pkg, rel)
      const info = await lstat(file).catch(() => null)
      if (!info?.isFile()) continue
      const counted = info.blocks * 512
      done.counted += counted
      const own = options.privateBytes(file)
      if (own === null || own === 0) continue
      const source = cached ? join(cached, rel) : null
      const twin = source ? await lstat(source).catch(() => null) : null
      if (!source || !twin?.isFile() || twin.size !== info.size || !(await sameBytes(file, source, info.size).catch(() => false))) {
        done.own += own
        continue
      }
      if (!options.dryRun && !cloneOver(source, file, info.mode)) {
        done.own += own
        continue
      }
      done.files += 1
      done.bytes += own
    }
  }
  return done
}

/** Clone `source` beside `file` and rename it over `file`, its mode kept. False when the file system will not clone. */
function cloneOver(source: string, file: string, mode: number): boolean {
  const beside = `${file}.kehikot-share-${process.pid}`
  try {
    copyFileSync(source, beside, constants.COPYFILE_FICLONE_FORCE)
    chmodSync(beside, mode & 0o7777)
    renameSync(beside, file)
    return true
  } catch {
    rmSync(beside, { force: true })
    return false
  }
}

/** Vite's pre-bundling cache in a copy: its size, removed unless `dryRun`. Zero when there is none. */
export async function dropDevCache(copy: string, privateBytes: PrivateBytes | null, dryRun = false): Promise<number> {
  const dir = join(copy, 'node_modules', '.vite')
  if (!existsSync(dir)) return 0
  let bytes = 0
  for (const rel of await filesOf(dir)) {
    const file = join(dir, rel)
    const own = privateBytes?.(file)
    bytes += own ?? ((await lstat(file).catch(() => null))?.blocks ?? 0) * 512
  }
  if (!dryRun) await rm(dir, { recursive: true, force: true })
  return bytes
}

/** What the passes have given back, kept beside the installed copies (`.shared.json`). */
export interface SharedRecord {
  /** When a pass last finished. */
  at: number | null
  /** Room given back by resharing package files, all passes together. */
  reshared: number
  /** Room given back by removing caches a built copy does not use. */
  caches: number
  /** Room given back by removing versions nobody pins. */
  versions: number
  /** Per copy: when it was last looked at, at which commit, and its package files counted and its own. */
  copies: Record<string, { at: number; head: string | null; counted: number; own: number }>
}

export const RECORD_FILE = '.shared.json'

export function emptyRecord(): SharedRecord {
  return { at: null, reshared: 0, caches: 0, versions: 0, copies: {} }
}

export function readRecord(root: string): SharedRecord {
  try {
    const read = JSON.parse(readFileSync(join(root, RECORD_FILE), 'utf8')) as Partial<SharedRecord>
    return {
      at: typeof read.at === 'number' ? read.at : null,
      reshared: Number(read.reshared) || 0,
      caches: Number(read.caches) || 0,
      versions: Number(read.versions) || 0,
      copies: read.copies && typeof read.copies === 'object' ? read.copies : {},
    }
  } catch {
    return emptyRecord()
  }
}

export function writeRecord(root: string, record: SharedRecord): void {
  if (!existsSync(root) || !statSync(root).isDirectory()) return
  const file = join(root, RECORD_FILE)
  const tmp = `${file}.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(tmp, file)
}

/** Whether a copy is due a look: never looked at, its commit moved, or the last look is older than `RESHARE_EVERY_MS`. */
export function due(record: SharedRecord, dir: string, head: string | null, now: number): boolean {
  const last = record.copies[dir]
  return !last || last.head !== head || now - last.at >= RESHARE_EVERY_MS
}

/** What a copy is, for one pass. */
export interface PassCopy {
  dir: string
  head: string | null
  /** Serves its build, so Vite's cache in it is not used. */
  built: boolean
}

export interface PassDeps {
  /** Where the record is kept: the installed copies' folder. */
  root: string
  cache: string | null
  privateBytes: PrivateBytes | null
  /** Asked before each copy: true leaves it for the next pass (it is running, or wanted). */
  busy(dir: string): boolean
  now?: () => number
  log?(line: string): void
}

/** One pass over the copies that are due: reshare, drop a built copy's Vite cache, record it. */
export async function slimPass(copies: readonly PassCopy[], deps: PassDeps): Promise<{ reshared: number; caches: number }> {
  const now = deps.now ?? Date.now
  const record = readRecord(deps.root)
  let reshared = 0
  let caches = 0
  for (const copy of copies) {
    if (!due(record, copy.dir, copy.head, now()) || deps.busy(copy.dir)) continue
    let counted = 0
    let own = 0
    if (deps.cache && deps.privateBytes) {
      const done = await reshare(copy.dir, { cache: deps.cache, privateBytes: deps.privateBytes }).catch(() => null)
      if (done) {
        reshared += done.bytes
        counted = done.counted
        own = done.own
      }
    }
    /* Checked again: the copy may have started while it was looked at. */
    if (copy.built && !deps.busy(copy.dir)) caches += await dropDevCache(copy.dir, deps.privateBytes).catch(() => 0)
    record.copies[copy.dir] = { at: now(), head: copy.head, counted, own }
  }
  for (const dir of Object.keys(record.copies)) if (!existsSync(dir)) delete record.copies[dir]
  record.reshared += reshared
  record.caches += caches
  record.at = now()
  writeRecord(deps.root, record)
  if (reshared || caches) deps.log?.(`kehikko: gave back ${Math.round((reshared + caches) / 1e6)} MB of disk by sharing identical package files and removing unused caches`)
  return { reshared, caches }
}

/** Add what pruning versions gave back to the record. */
export function recordVersions(root: string, bytes: number): void {
  if (!bytes) return
  const record = readRecord(root)
  record.versions += bytes
  writeRecord(root, record)
}

/**
 * Where the package cache is, as the host's own Bun says (`bun pm cache`),
 * asked inside a copy (it answers only inside a package); null when it cannot
 * say or it is not there.
 */
export async function packageCache(
  run: (argv: readonly string[], options?: { cwd?: string; env?: Record<string, string> }) => Promise<{ ok: true; out: string } | { ok: false }>,
  own: { bun: string; env: Record<string, string> },
  inside: string,
): Promise<string | null> {
  const said = await run([own.bun, 'pm', 'cache'], { cwd: inside, env: own.env }).catch(() => null)
  const dir = said && said.ok ? said.out.trim().split('\n').pop()?.trim() : null
  return dir && existsSync(dir) ? dir : null
}

/** The room a folder takes on its own: what shares nothing, where that can be asked, and every block counted where it cannot. */
export async function ownBytes(dir: string, privateBytes: PrivateBytes | null): Promise<number> {
  let bytes = 0
  let seen = 0
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      if (++seen % 500 === 0) await pause()
      const path = join(at, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) bytes += privateBytes?.(path) ?? ((await lstat(path).catch(() => null))?.blocks ?? 0) * 512
    }
  }
  await walk(dir)
  return bytes
}
