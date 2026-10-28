import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import type { Startable } from '../server/launch.ts'
import { buildBun, withOwnBun } from '../server/moduleBuilds.ts'
import { readCheckout, update } from '../server/updates.ts'
import { SourceMaterialiser } from '../server/versionRuns.ts'

/*
 * Installed copies are installed and started with the host's own Bun, never
 * the `bun` on the person's PATH: the modules' lockfiles are written by it, and
 * another Bun may read one as needing changes and fail a frozen install.
 */

const root = mkdtempSync(join(tmpdir(), 'kehikot-own-bun-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A program that records that it ran, and succeeds or fails as asked. */
function fakeBun(name: string, code: number) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const called = join(dir, 'called')
  const file = join(dir, 'bun')
  writeFileSync(file, `#!/bin/sh\necho "$@" >> "${called}"\nmkdir -p node_modules\nexit ${code}\n`)
  chmodSync(file, 0o755)
  return { dir, file, called }
}

const OWN = { bun: '/host/own-bun', env: { BUN_BE_BUN: '1', PATH: '/shim:/usr/bin' } }
const ready: Startable = { ok: true, run: { dir: '/m', script: '/m/run.sh', port: 1, url: 'http://127.0.0.1:1', command: '/m/run.sh' } }

describe('a module start', () => {
  test('an installed copy has the own-Bun shim first on its PATH', () => {
    const got = withOwnBun(ready, true, () => OWN)
    expect(got.ok && got.run.env).toEqual(OWN.env)
  })
  test('names in KEHIKOT_HOST_PATH exactly the folders it put first on the PATH', () => {
    const host = join(root, 'Kehikot.app', 'kehikko-host')
    mkdirSync(join(root, 'Kehikot.app'), { recursive: true })
    writeFileSync(host, '#!/bin/sh\n')
    const got = withOwnBun(ready, true, () => buildBun(host, '/usr/bin:/bin'))
    const env = got.ok ? got.run.env! : {}
    const named = env.KEHIKOT_HOST_PATH!.split(delimiter)
    expect(named).toHaveLength(1)
    expect(env.PATH).toBe([...named, '/usr/bin', '/bin'].join(delimiter))
    expect(env.BUN_BE_BUN).toBe('1')
    expect(realpathSync(join(named[0]!, 'bun'))).toBe(realpathSync(host))
    rmSync(named[0]!, { recursive: true, force: true })
  })
  test('a checkout is left as it is', () => {
    expect(withOwnBun(ready, false, () => OWN)).toBe(ready)
  })
  test('a refusal stays a refusal', () => {
    const no: Startable = { ok: false, why: 'nope' }
    expect(withOwnBun(no, true, () => OWN)).toBe(no)
  })
})

describe('the install an update runs', () => {
  async function pair(installed: boolean) {
    const path = fakeBun(`path-${Math.random()}`, 1)
    const own = fakeBun(`own-${Math.random()}`, 0)
    const dir = mkdtempSync(join(root, 'copy-'))
    const git = (...args: string[]) => Bun.spawnSync(['git', '-C', dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
    const origin = join(dir, '..', `${dir.split('/').pop()}-origin.git`)
    Bun.spawnSync(['git', 'init', '--quiet', '--bare', '-b', 'main', origin])
    Bun.spawnSync(['git', 'clone', '--quiet', origin, dir])
    git('switch', '--quiet', '-c', 'main')
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n')
    writeFileSync(join(dir, 'bun.lock'), 'one\n')
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' }
    const sh = (...args: string[]) => Bun.spawnSync(['git', '-C', dir, ...args], { env })
    sh('add', '.')
    sh('commit', '--quiet', '-m', 'one')
    sh('push', '--quiet', '-u', 'origin', 'main')
    const other = `${dir}-other`
    Bun.spawnSync(['git', 'clone', '--quiet', origin, other])
    writeFileSync(join(other, 'bun.lock'), 'two\n')
    Bun.spawnSync(['git', '-C', other, 'commit', '--quiet', '-am', 'two'], { env })
    Bun.spawnSync(['git', '-C', other, 'push', '--quiet'], { env })
    const place = { id: 'm', name: 'm', dir, ...(installed ? { build: async () => ({ kind: 'skipped' as const }) } : {}) }
    return { path, own, place, dir }
  }

  test('an installed copy runs the own Bun, frozen, and the PATH bun is never called', async () => {
    const { path, own, place, dir } = await pair(true)
    const before = process.env.PATH
    process.env.PATH = `${path.dir}:${before}`
    try {
      await readCheckout(place as never, true)
      const done = await update(place as never, undefined, { bun: () => ({ bun: own.file, env: {} }) })
      expect(done).toMatchObject({ ok: true })
      expect(readFileSync(own.called, 'utf8').trim()).toBe('install --frozen-lockfile')
      expect(existsSync(path.called)).toBe(false)
      expect(existsSync(join(dir, 'node_modules', '.kehikot-installed'))).toBe(true)
    } finally {
      process.env.PATH = before
    }
  })

  test('a checkout keeps the PATH bun', async () => {
    const { path, own, place } = await pair(false)
    const before = process.env.PATH
    process.env.PATH = `${path.dir}:${before}`
    try {
      await readCheckout(place as never, true)
      await update(place as never, undefined, { bun: () => ({ bun: own.file, env: {} }) })
      expect(readFileSync(path.called, 'utf8').trim()).toBe('install')
      expect(existsSync(own.called)).toBe(false)
    } finally {
      process.env.PATH = before
    }
  })
})

describe('a pinned version\'s install', () => {
  test('uses the own Bun and its env', async () => {
    const calls: { argv: readonly string[]; env?: Record<string, string> }[] = []
    const base = mkdtempSync(join(root, 'pins-'))
    const materialiser = new SourceMaterialiser(
      base,
      async (argv, options) => {
        calls.push({ argv, env: options?.env })
        if (argv[0] === 'git' && argv.includes('add')) {
          const tree = argv[argv.indexOf('--force') + 1]!
          mkdirSync(tree, { recursive: true })
          writeFileSync(join(tree, 'package.json'), '{}')
          writeFileSync(join(tree, 'bun.lock'), '')
          writeFileSync(join(tree, 'run.sh'), '#!/bin/sh\n')
          chmodSync(join(tree, 'run.sh'), 0o755)
        }
        return { ok: true, out: '' }
      },
      () => OWN,
    )
    await materialiser.prepare({ id: 'kehikot.x', name: 'x', dir: base, remote: 'https://github.com/a/b.git' }, 'v1.0.0', () => {}).catch(() => null)
    const install = calls.find((call) => call.argv[1] === 'install')
    expect(install?.argv).toEqual(['/host/own-bun', 'install', '--frozen-lockfile'])
    expect(install?.env).toEqual(OWN.env)
    expect(calls.some((call) => call.argv[0] === 'bun')).toBe(false)
  })
})
