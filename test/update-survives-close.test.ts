import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * An update is the server's: it runs to its end when the request that began it
 * is closed (the panel closed, the page reloaded), and only an explicit cancel
 * stops it. The request is aborted as soon as the first step is told, which is
 * before the merge — where the old code, tied to the request's signal, gave up.
 */

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-update-survives-')))
const at = (name: string) => join(ROOT, name)
let api = ''
let child: ReturnType<typeof Bun.spawn> | null = null

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}
const page = () => ({ origin: `http://127.0.0.1:${Number(new URL(api).port) + 1}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' })

/** A module checkout one commit behind its origin; returns what its HEAD should become. */
function behind(name: string): { dir: string; target: string } {
  const origin = at(`${name}-origin`)
  const dir = at(`${name}-copy`)
  mkdirSync(origin, { recursive: true })
  git(origin, 'init', '-q', '-b', 'main')
  writeFileSync(join(origin, 'a.txt'), '1')
  git(origin, 'add', '.')
  git(origin, 'commit', '-q', '-m', 'one')
  git(ROOT, 'clone', '-q', origin, dir)
  writeFileSync(join(origin, 'a.txt'), '2')
  git(origin, 'commit', '-q', '-am', 'two')
  git(dir, 'fetch', '-q')
  return { dir, target: git(origin, 'rev-parse', 'HEAD') }
}

const mod = behind('slow')
const other = behind('other')

beforeAll(async () => {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = probe.port ?? 0
  probe.stop(true)
  api = `http://127.0.0.1:${port}`
  for (const dir of ['project', 'modules', 'versions', 'installed', 'logs']) mkdirSync(at(dir), { recursive: true })
  writeFileSync(at('claude.json'), '{}')
  for (const [id, one] of [['kehikot.slow', mod], ['kehikot.other', other]] as const) {
    writeFileSync(join(at('modules'), `${id}.json`), JSON.stringify({ id, url: `http://127.0.0.1:${port + 50}`, dir: one.dir }))
  }
  child = Bun.spawn(['bun', 'run', join(import.meta.dir, '..', 'server', 'server.ts')], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      CLAUDE_CONFIG: at('claude.json'),
      KEHIKOT_FRAME_DB: at('frame.sqlite'),
      KEHIKOT_MODULES_DIR: at('modules'),
      KEHIKOT_VERSIONS_DIR: at('versions'),
      KEHIKOT_INSTALLS_DIR: at('installed'),
      KEHIKOT_OFFICIAL_CACHE: at('official-modules.json'),
      KEHIKOT_MY_MODULES: at('my-modules.json'),
      KEHIKOT_LOGS_DIR: at('logs'),
      KEHIKOT_SEED_PROJECT: at('project'),
      KEHIKOT_OFFICIAL_LIST: 'off',
      KEHIKOT_ORIGIN: '',
      KEHIKOT_ORIGINS: '',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${api}/host/health`)).ok) {
        /* A sweep reads the registrations the updates are looked up in. */
        await fetch(`${api}/host/modules`)
        return
      }
    } catch {
      /* Not up yet. */
    }
    await Bun.sleep(100)
  }
  throw new Error('the server did not come up')
}, 30000)

afterAll(async () => {
  child?.kill()
  await child?.exited
  rmSync(ROOT, { recursive: true, force: true })
})

const post = (path: string, body: unknown, signal?: AbortSignal) =>
  fetch(`${api}${path}`, { method: 'POST', headers: page(), body: JSON.stringify(body), signal })

/** Press an update, read its first line, and drop the connection. */
async function pressAndWalkAway(id: string): Promise<void> {
  const abort = new AbortController()
  const response = await post('/host/updates', { id }, abort.signal)
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  await reader.read()
  abort.abort()
  await reader.cancel().catch(() => {})
}

async function until(done: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await done()) return true
    await Bun.sleep(50)
  }
  return false
}

describe('an update outlives the request that started it', () => {
  test('aborting the request mid-update does not stop it: the checkout moves and the progress clears', async () => {
    await pressAndWalkAway('kehikot.slow')
    expect(await until(() => git(mod.dir, 'rev-parse', 'HEAD') === mod.target)).toBe(true)
    const read = await (await fetch(`${api}/host/updates`)).json()
    expect(await until(async () => Object.keys(((await (await fetch(`${api}/host/updates`)).json()) as any).progress).length === 0)).toBe(true)
    expect(read.checkouts.some((one: any) => one.id === 'kehikot.slow')).toBe(true)
  })

  test('an explicit cancel is the only stop: before the merge nothing is changed', async () => {
    const response = await post('/host/updates', { id: 'kehikot.other' })
    const reader = response.body!.getReader()
    await reader.read()
    const cancelled = await (await post('/host/updates/cancel', { id: 'kehikot.other' })).json()
    expect(cancelled.cancelled).toBe(true)
    const rest = await new Response(new ReadableStream({ async start(c) { for (;;) { const { done, value } = await reader.read(); if (done) break; c.enqueue(value) } c.close() } })).text()
    /* Either it was stopped before the merge (an error line, nothing changed) or the merge had already begun and ran on. */
    const moved = git(other.dir, 'rev-parse', 'HEAD') === other.target
    expect(moved ? rest.includes('"done"') : rest.includes('Cancelled')).toBe(true)
  })

  test('a cancel for nothing running says so', async () => {
    expect((await (await post('/host/updates/cancel', { id: 'kehikot.nothing' })).json()).cancelled).toBe(false)
  })
})
