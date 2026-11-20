import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EXIT_BACKOFF_MS, MIN_RUN_MS, THEIRS_TO_RESTART_MS } from '../server/lifecycle.ts'

/**
 * Characterisation of the module supervisor in `server/server.ts`: what starts, watches,
 * restarts and stops module processes, seen from outside — a host started as the app starts it,
 * real module processes (`test/fixtures/supervisor/module.ts`), and only what a page, a press or
 * the host's own log can see. Nothing here reaches into the host: these tests pin what it DOES, so
 * the code can be moved out of `server.ts` and these still pass unchanged.
 *
 * One host for the whole file, and the tests run in order on it: each says what state it leaves.
 *
 *  - `kehikot.alpha`  on the open kehikko; started by the host.
 *  - `kehikot.beta`   registered, on no kehikko: never started by a sweep.
 *  - `kehikot.broken` on the open kehikko; its script exits at once, without answering.
 *  - `kehikot.theirs` on the open kehikko; running before the page opens, started by the test.
 *  - `kehikot.moved`  on no kehikko; a stranger has its port when Start is pressed.
 *  - `kehikot.twin`   on no kehikko; a copy of it runs from another folder when Start is pressed.
 *
 * Every module process is in its own process group (`start` spawns detached). The host is told
 * it is the app's (`KEHIKKO_RESTART_FILE`), so on `SIGTERM` it stops what it started; the test
 * stops by pid whatever it started itself, and anything left in the runs files, at the end.
 */

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-supervisor-')))
const at = (...parts: string[]) => join(ROOT, ...parts)
const MODULE = join(import.meta.dir, 'fixtures', 'supervisor', 'module.ts')
const IDS = ['kehikot.alpha', 'kehikot.beta', 'kehikot.broken', 'kehikot.theirs', 'kehikot.moved', 'kehikot.twin'] as const
type Id = (typeof IDS)[number]

let api = ''
let pageOrigin = ''
let host: ReturnType<typeof Bun.spawn> | null = null
let log = ''
const ports = new Map<Id, number>()
/** Processes this test started itself (not the host): stopped by pid at the end. */
const ours: ReturnType<typeof Bun.spawn>[] = []

/** A port nothing listens on, at this moment. */
function freePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = probe.port ?? 0
  probe.stop(true)
  return port
}

const runsFile = (id: Id) => at('runs', `${id}.log`)
/** Every run of a module's script so far: its pid and the PORT it was handed. */
function runs(id: Id): { pid: number; port: number }[] {
  if (!existsSync(runsFile(id))) return []
  return readFileSync(runsFile(id), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [pid, port] = line.split(' ')
      return { pid: Number(pid), port: Number(port) }
    })
}

/** A module folder with its `run.sh`, and its registration. */
function register(id: Id, broken = false): void {
  const dir = at('modules-src', id)
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'run.sh')
  writeFileSync(script, `#!/bin/sh\nexec bun "${MODULE}" "${id}" "${runsFile(id)}"${broken ? ' broken' : ''}\n`)
  chmodSync(script, 0o755)
  const port = freePort()
  ports.set(id, port)
  writeFileSync(at('registry', `${id}.json`), JSON.stringify({ id, url: `http://127.0.0.1:${port}`, dir }))
}

/** Run a module's process as somebody other than the host would: from `cwd`, on its port. */
function runOurselves(id: Id, cwd: string): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn(['bun', MODULE, id, runsFile(id)], { cwd, env: { ...process.env, PORT: String(ports.get(id)) }, stdout: 'ignore', stderr: 'ignore' })
  ours.push(child)
  return child
}

const pageHeaders = () => ({ origin: pageOrigin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' })
const press = (path: string, body: unknown) =>
  fetch(`${api}${path}`, { method: 'POST', headers: pageHeaders(), body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }))

async function answers(id: Id, port = ports.get(id)!): Promise<boolean> {
  try {
    const got = await fetch(`http://127.0.0.1:${port}/.well-known/kehikot-module.json`, { signal: AbortSignal.timeout(500) })
    return got.ok && ((await got.json()) as { id?: string }).id === id
  } catch {
    return false
  }
}

async function until(done: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await done()) return true
    await Bun.sleep(100)
  }
  return false
}

/** The modules as the page reads them. */
async function modules(): Promise<{ id: string; condition: string; stopped?: boolean; line?: string }[]> {
  const read = (await fetch(`${api}/host/modules?fresh=1`).then((r) => r.json())) as { presences: { id: string; condition: string; stopped?: boolean; line?: string }[] }
  return read.presences
}

let kehikko = 0
/** The page says it has the kehikko open: what the host sweeps and acts on. */
const open = () => press('/host/open', { page: 'the-page', kehikko })

beforeAll(async () => {
  for (const dir of ['project', 'registry', 'versions', 'installed', 'logs', 'runs', 'modules-src', 'elsewhere']) mkdirSync(at(dir), { recursive: true })
  writeFileSync(at('claude.json'), '{}')
  register('kehikot.alpha')
  register('kehikot.beta')
  register('kehikot.broken', true)
  register('kehikot.theirs')
  register('kehikot.moved')
  register('kehikot.twin')

  const port = freePort()
  api = `http://127.0.0.1:${port}`
  pageOrigin = `http://127.0.0.1:${port + 1}`
  host = Bun.spawn(['bun', 'run', join(import.meta.dir, '..', 'server', 'server.ts')], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      CLAUDE_CONFIG: at('claude.json'),
      KEHIKOT_FRAME_DB: at('frame.sqlite'),
      KEHIKOT_MODULES_DIR: at('registry'),
      KEHIKOT_VERSIONS_DIR: at('versions'),
      KEHIKOT_INSTALLS_DIR: at('installed'),
      KEHIKOT_OFFICIAL_CACHE: at('official-modules.json'),
      KEHIKOT_MY_MODULES: at('my-modules.json'),
      KEHIKOT_LOGS_DIR: at('logs'),
      KEHIKOT_SEED_PROJECT: at('project'),
      KEHIKOT_OFFICIAL_LIST: 'off',
      KEHIKOT_MODULE_ADDRESSES: '0',
      KEHIKKO_RESTART_FILE: at('restart'),
      KEHIKOT_ORIGIN: '',
      KEHIKOT_ORIGINS: '',
    },
    stdout: 'pipe',
    stderr: 'ignore',
  })
  /* The host's log, as it is written: what it says it did. */
  void (async () => {
    const decoder = new TextDecoder()
    const reader = (host!.stdout as ReadableStream<Uint8Array>).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      log += decoder.decode(value)
    }
  })()
  if (!(await until(async () => (await fetch(`${api}/host/health`).catch(() => null))?.ok === true, 20000))) throw new Error('the host did not come up')

  /* The seeded project's kehikko, with alpha, broken and theirs on it. */
  const listed = (await fetch(`${api}/host/canvases`).then((r) => r.json())) as { canvases: { id: number }[] }
  kehikko = listed.canvases[0]!.id
  const placements = ['kehikot.alpha', 'kehikot.broken', 'kehikot.theirs'].map((i, n) => ({ i, x: n * 4, y: 0, w: 4, h: 4 }))
  const patched = await fetch(`${api}/host/canvases/${kehikko}`, { method: 'PATCH', headers: pageHeaders(), body: JSON.stringify({ placements }) })
  if (!patched.ok) throw new Error(`placing the modules: ${patched.status}`)

  /* Theirs is already running when the page opens: somebody else started it. */
  runOurselves('kehikot.theirs', at('elsewhere'))
  if (!(await until(() => answers('kehikot.theirs'), 10000))) throw new Error('theirs did not come up')
}, 40000)

afterAll(async () => {
  host?.kill('SIGTERM')
  await host?.exited
  for (const child of ours) child.kill('SIGKILL')
  /* Anything still running that a module script started, by its pid. */
  for (const id of IDS) for (const run of runs(id)) {
    try {
      process.kill(run.pid, 'SIGKILL')
    } catch {
      /* Gone already. */
    }
  }
  rmSync(ROOT, { recursive: true, force: true })
})

describe('the supervisor, from outside', () => {
  test('a page opening a kehikko starts what is on it, and nothing else', async () => {
    expect((await open()).body.ok).toBe(true)
    expect(await until(() => answers('kehikot.alpha'), 15000)).toBe(true)
    /* Started once, by the host, on its registered port. */
    expect(runs('kehikot.alpha')).toHaveLength(1)
    expect(runs('kehikot.alpha')[0]!.port).toBe(ports.get('kehikot.alpha')!)
    expect(log).toContain('kehikko: started kehikot.alpha at')
    /* Registered, on no kehikko: not started. */
    expect(runs('kehikot.beta')).toHaveLength(0)
    /* Somebody else's, answering: left alone (the one run is the test's own). */
    expect(runs('kehikot.theirs')).toHaveLength(1)
    expect(log).not.toContain('started kehikot.theirs')
    /* Ours, answering, in the page's reading (once the host has read it since it came up). */
    expect(await until(async () => (await modules()).find((one) => one.id === 'kehikot.alpha')?.condition === 'ready', 10000)).toBe(true)
  }, 30000)

  test('a module whose script ends without answering is said to have failed, and is not started again', async () => {
    expect(await until(() => log.includes('kehikko: kehikot.broken stopped again (exit code 3) without answering'), 15000)).toBe(true)
    expect(runs('kehikot.broken')).toHaveLength(1)
    /* More looks, more reports of the open kehikko: still one run. */
    await open()
    await modules()
    await Bun.sleep(1500)
    await open()
    expect(runs('kehikot.broken')).toHaveLength(1)
    const broken = (await modules()).find((one) => one.id === 'kehikot.broken')
    expect(broken?.condition).toBe('silent')
    expect(broken?.line ?? '').toContain('exit code 3')
  }, 30000)

  test('somebody else’s module that goes is theirs to bring back first; after that the host starts it', async () => {
    const theirs = ours.find((child) => runs('kehikot.theirs')[0]?.pid === child.pid)!
    theirs.kill('SIGKILL')
    await theirs.exited
    const went = Date.now()
    /* The host hears it go (its tether drops) and waits for its owner. */
    await Bun.sleep(THEIRS_TO_RESTART_MS / 2)
    expect(runs('kehikot.theirs')).toHaveLength(1)
    /* Then the ordinary rule: on the open kehikko, nothing answering, so started. */
    expect(await until(() => runs('kehikot.theirs').length === 2, THEIRS_TO_RESTART_MS + 15000)).toBe(true)
    expect(Date.now() - went).toBeGreaterThanOrEqual(THEIRS_TO_RESTART_MS - 1000)
    expect(await until(() => answers('kehikot.theirs'), 15000)).toBe(true)
    expect(log).toContain('started kehikot.theirs')
  }, 40000)

  test('a module that ran and ended is started again: at once the first time, after a wait the next', async () => {
    /* It has to have run past MIN_RUN_MS, or its end is a failed start (above). */
    const first = runs('kehikot.alpha').length
    await Bun.sleep(MIN_RUN_MS + 500)
    await fetch(`http://127.0.0.1:${ports.get('kehikot.alpha')}/die`, { method: 'POST' })
    expect(await until(() => runs('kehikot.alpha').length === first + 1, 10000)).toBe(true)
    expect(log).toContain('kehikko: kehikot.alpha is no longer running — the process the host started ended')
    expect(await until(() => answers('kehikot.alpha'), 15000)).toBe(true)

    /* The second end within the window waits EXIT_BACKOFF_MS[1] before the next start. */
    await Bun.sleep(MIN_RUN_MS + 500)
    await fetch(`http://127.0.0.1:${ports.get('kehikot.alpha')}/die`, { method: 'POST' })
    expect(await until(() => log.includes(`kehikko: kehikot.alpha is no longer running — started again in ${EXIT_BACKOFF_MS[1]! / 1000} s`), 10000)).toBe(true)
    const ended = Date.now()
    /* Meanwhile nothing starts it, whatever the page says. */
    await open()
    await Bun.sleep(EXIT_BACKOFF_MS[1]! / 2)
    await open()
    expect(runs('kehikot.alpha')).toHaveLength(first + 1)
    expect(await until(() => runs('kehikot.alpha').length === first + 2, EXIT_BACKOFF_MS[1]! + 10000)).toBe(true)
    expect(Date.now() - ended).toBeGreaterThanOrEqual(EXIT_BACKOFF_MS[1]! - 1000)
    expect(await until(() => answers('kehikot.alpha'), 15000)).toBe(true)
  }, 60000)

  test('a module the person stopped is not started again by the host, until they press Start', async () => {
    const before = runs('kehikot.alpha').length
    const stopped = await press('/host/stop-module', { module: 'kehikot.alpha' })
    expect(stopped.body.ok).toBe(true)
    expect(await until(async () => !(await answers('kehikot.alpha')), 10000)).toBe(true)
    /* Still on the open kehikko, and the page keeps saying so. */
    await open()
    await Bun.sleep(2000)
    await open()
    expect(runs('kehikot.alpha')).toHaveLength(before)
    const alpha = (await modules()).find((one) => one.id === 'kehikot.alpha')
    expect(alpha?.stopped).toBe(true)
    expect(alpha?.line).toContain('stays stopped until you press Start')

    /* The press: started again, and the host's own rules apply to it from here. */
    const started = await press('/host/start', { module: 'kehikot.alpha' })
    expect(started.body.ok).toBe(true)
    expect(runs('kehikot.alpha')).toHaveLength(before + 1)
    expect(await answers('kehikot.alpha')).toBe(true)
  }, 40000)

  test('Start, with a stranger on the module’s port: the module is moved to another port, and the stranger is left alone', async () => {
    const taken = ports.get('kehikot.moved')!
    const stranger = Bun.serve({ hostname: '127.0.0.1', port: taken, fetch: () => new Response('not a module') })
    try {
      const started = await press('/host/start', { module: 'kehikot.moved' })
      expect(started.body.ok).toBe(true)
      expect(String(started.body.moved ?? '')).not.toBe('')
      /* Its registration names the new port, and it runs there. */
      const now = JSON.parse(readFileSync(at('registry', 'kehikot.moved.json'), 'utf8')) as { url: string }
      const port = Number(new URL(now.url).port)
      expect(port).not.toBe(taken)
      expect(runs('kehikot.moved').at(-1)?.port).toBe(port)
      expect(await answers('kehikot.moved', port)).toBe(true)
      /* The stranger still has its port. */
      expect(await (await fetch(`http://127.0.0.1:${taken}/`)).text()).toBe('not a module')
    } finally {
      stranger.stop(true)
    }
  }, 40000)

  test('Start, with a copy of the module running from another folder: refused, and the copy is left running', async () => {
    const copy = runOurselves('kehikot.twin', at('elsewhere'))
    expect(await until(() => answers('kehikot.twin'), 10000)).toBe(true)
    const started = await press('/host/start', { module: 'kehikot.twin' })
    expect(started.body.ok).toBe(false)
    expect(String(started.body.why ?? '')).not.toBe('')
    /* Nothing of the host's ran, and the copy still answers. */
    expect(runs('kehikot.twin')).toHaveLength(1)
    expect(runs('kehikot.twin')[0]!.pid).toBe(copy.pid)
    expect(await answers('kehikot.twin')).toBe(true)
  }, 30000)
})
