import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bundleRunScript, sha256, writeTarGz, type BundleInfo, type TarFile } from 'kehikot-module-protocol/bundle'

import { createCanvas, editCanvas, open as openDb } from '../server/canvases.ts'
import { Pins } from '../server/pins.ts'
import { addProject } from '../server/projects.ts'
import { unpackBundle } from 'kehikot-module-protocol/bundle'
import { BundleMaterialiser, FactsStore, SourceMaterialiser, type Source } from '../server/versionRuns.ts'

/*
 * Pinning a container to an older version of a module that was installed as a ready-built bundle:
 * the picker lists the releases that carry a bundle (there is no git checkout to read tags from),
 * and a pinned version is fetched, checked and run from its own bundle beside the current one.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikot-bundle-versions-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let made = 0
const scratch = (name: string) => {
  const dir = join(root, `${name}-${(made += 1)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const ID = 'kehikot.sample'
const text = (value: string) => new TextEncoder().encode(value)

function archiveOf(version: string): Uint8Array {
  const base = { id: ID, version, commit: version.replaceAll('.', '').padEnd(40, 'a'), entry: 'serve.ts' }
  const files: TarFile[] = [
    { path: 'serve.ts', data: text(`console.log(${JSON.stringify(version)})`) },
    { path: 'run.sh', data: text(bundleRunScript(base)), executable: true },
  ]
  const info: BundleInfo = {
    format: 'kehikot.bundle', formatVersion: 1, ...base, protocol: '2.102.0', builtAt: '2026-11-18T00:00:00.000Z', bun: '1.4.0', platforms: null, native: [],
    files: Object.fromEntries(files.map((file) => [file.path, { sha256: sha256(file.data), size: file.data.length, ...(file.executable ? { executable: true } : {}) }])),
  }
  return writeTarGz([...files, { path: 'bundle.json', data: text(JSON.stringify(info)) }])
}

/** `stage` as the bundle desk does it, from archives held here: checked and unpacked under `into`. */
function stager(have: Record<string, Uint8Array>) {
  const asked: string[] = []
  const stage = async (id: string, tag: string, into: string) => {
    asked.push(`${id}@${tag}`)
    const archive = have[tag]
    if (!archive) return { ok: false as const, why: `${tag} has no ready-built bundle.`, none: true }
    mkdirSync(into, { recursive: true })
    const out = unpackBundle(archive, join(into, `${id}-${tag}`), { sha256: sha256(archive), id, version: tag.slice(1) })
    return out.ok ? { ok: true as const, dir: out.dir } : { ok: false as const, why: out.why }
  }
  return { stage, asked }
}

const bundledSource = (): Source => ({ id: ID, name: 'Sample', dir: scratch('installed'), remote: null, bundled: true })

describe('a version fetched from its bundle', () => {
  test('is unpacked under the versions directory, marked ready, and has a script a host can run', async () => {
    const versions = scratch('versions')
    const got = stager({ 'v1.0.0': archiveOf('1.0.0') })
    const materialiser = new BundleMaterialiser(versions, new SourceMaterialiser(versions), got.stage)
    const steps: string[] = []
    const prepared = await materialiser.prepare(bundledSource(), 'v1.0.0', (step) => steps.push(step))
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.tree.dir).toBe(join(versions, ID, 'v1.0.0'))
    expect(statSync(prepared.tree.script).mode & 0o111).not.toBe(0)
    expect(readFileSync(join(prepared.tree.dir, 'serve.ts'), 'utf8')).toContain('1.0.0')
    expect(existsSync(join(versions, ID, 'v1.0.0.ready'))).toBe(true)
    expect(existsSync(join(versions, ID, '.incoming'))).toBe(false)
    expect(steps).toEqual(['fetching'])
    expect(materialiser.prepared(ID, 'v1.0.0')).not.toBeNull()
    /* Prepared once is not fetched again. */
    await materialiser.prepare(bundledSource(), 'v1.0.0', () => {})
    expect(got.asked).toEqual([`${ID}@v1.0.0`])
  })

  test('a release with no bundle, for a module with no checkout, is said and nothing is left', async () => {
    const versions = scratch('versions')
    const materialiser = new BundleMaterialiser(versions, new SourceMaterialiser(versions), stager({}).stage)
    const prepared = await materialiser.prepare(bundledSource(), 'v0.9.0', () => {})
    expect(prepared).toEqual({ ok: false, why: 'v0.9.0 has no ready-built bundle.' })
    expect(materialiser.prepared(ID, 'v0.9.0')).toBeNull()
    expect(existsSync(join(versions, ID, 'v0.9.0'))).toBe(false)
  })

  test('a module installed from git is prepared from git, never from a bundle', async () => {
    const versions = scratch('versions')
    const got = stager({ 'v1.0.0': archiveOf('1.0.0') })
    const ran: string[][] = []
    const source = new SourceMaterialiser(versions, async (argv) => {
      ran.push([...argv])
      return { ok: false, why: 'no network' }
    })
    const materialiser = new BundleMaterialiser(versions, source, got.stage)
    const prepared = await materialiser.prepare({ id: ID, name: 'Sample', dir: scratch('git'), remote: 'https://x/y.git' }, 'v1.0.0', () => {})
    expect(prepared.ok).toBe(false)
    expect(got.asked).toEqual([])
    expect(ran[0]?.[0]).toBe('git')
  })

  test('a path outside the versions directory cannot be asked for', async () => {
    const versions = scratch('versions')
    const got = stager({})
    const materialiser = new BundleMaterialiser(versions, new SourceMaterialiser(versions), got.stage)
    expect((await materialiser.prepare(bundledSource(), '../../etc', () => {})).ok).toBe(false)
    expect(got.asked).toEqual([])
  })
})

describe('the picker for a module installed as a bundle', () => {
  function world(tags: string[], bundled: boolean) {
    const dir = scratch('project')
    const db: Database = openDb(':memory:')
    const added = addProject(db, dir, undefined, false)
    if (!added.ok) throw new Error(added.why)
    const canvas = createCanvas(db, 'one', added.project.id)
    editCanvas(db, canvas.id, { placements: [{ i: ID, x: 0, y: 0, w: 4, h: 10 }] })
    const versions = scratch('facts')
    const asked: string[] = []
    const pins = new Pins({
      db,
      runs: { get: () => null, ensure: () => ({ state: 'preparing' }), retry: () => ({ state: 'preparing' }) } as never,
      facts: new FactsStore(versions),
      tags: { tags: async () => ({ ok: false, why: 'the checkout has no remote', at: 0 }) } as never,
      materialiser: new SourceMaterialiser(versions),
      /* A bundle's folder is not a git checkout: every git question fails. */
      runner: async () => ({ ok: false, why: 'not a git repository' }),
      registration: async (id) => (id === ID ? { id, url: 'http://127.0.0.1:7999', dir: '/installed/sample', file: 'x' } : null),
      latest: () => null,
      look: async () => ({}) as never,
      wake: () => {},
      keep: () => {},
      bundled: async (id, fresh) => {
        asked.push(`${id} ${fresh}`)
        return bundled ? { repo: 'Jalez/kehikko-sample', tags, error: null } : null
      },
    })
    return { canvas, pins, asked }
  }

  test('lists the releases that carry bundles, though the folder has no git remote, and pins one', async () => {
    const { canvas, pins } = world(['v1.2.0', 'v1.1.0'], true)
    const listed = await pins.list(ID, canvas.id)
    if ('why' in listed) throw new Error(listed.why)
    expect(listed.versions.map((one) => one.tag)).toEqual(['v1.2.0', 'v1.1.0'])
    expect(listed.repo).toBe('Jalez/kehikko-sample')
    expect(listed.error).toBeNull()
    expect(await pins.pin(canvas.id, ID, 'v1.1.0')).toMatchObject({ ok: true })
    expect(await pins.pin(canvas.id, ID, 'v0.5.0')).toMatchObject({ ok: false, why: expect.stringContaining('v1.2.0, v1.1.0') })
  })

  test('a module with no earlier bundle says so instead of an error', async () => {
    const { canvas, pins } = world([], true)
    const listed = await pins.list(ID, canvas.id)
    if ('why' in listed) throw new Error(listed.why)
    expect(listed.versions).toEqual([])
    expect(listed.hint).toContain('no earlier ready-built release')
  })

  test('a module that is not a bundle keeps reading its checkout', async () => {
    const { canvas, pins } = world(['v1.2.0'], false)
    const listed = await pins.list(ID, canvas.id)
    if ('why' in listed) throw new Error(listed.why)
    expect(listed.hint).toContain('no remote')
  })
})
