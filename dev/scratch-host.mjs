/*
 * A scratch host for a browser drive: the host's API and Vite on free ports,
 * every `KEHIKOT_*` location and `HOME` in a temporary directory, two
 * projects with two kehikot each (project-a with two epics), and three
 * stand-in modules (`test/fixtures/standin/`). Nothing of the person's
 * machine is read or written, and every process started here is stopped by
 * its pid when the drive ends (`stop`, also on exit).
 *
 *     const page = await bootHost('my-drive')   // the page's URL
 *
 * `KEEP=1` keeps the directory, with every process's log in it.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOST = join(dirname(fileURLToPath(import.meta.url)), '..')
const KEEP = process.env.KEEP === '1'
const BUN = process.env.BUN ?? 'bun'

/*
 * Ports, claimed so that two drives started in the same moment — on one machine, in two runs —
 * never share one.
 *
 * Asking the system for a free port (listen on 0, close) and handing it to a child that binds it
 * later leaves a gap, and the system fills it: macOS hands out its ephemeral ports in order, so a
 * second drive probing a moment later is given the port the first was about to use for its page
 * (the API's plus one), and every connection a browser opens takes one from the same range. A
 * scratch host then timed out waiting for a page that another process held.
 *
 * So a port is taken from below every system's ephemeral range (Linux starts at 32768, macOS at
 * 49152), and claimed by creating a file named for it, exclusively, in one directory every drive
 * on this machine shares — whatever its TMPDIR (`KEHIKOT_SCRATCH_PORTS`, or `/tmp/kehikko-scratch-ports`;
 * `dev/bee-browser-tests.sh` keeps it under `~/kehikko-ci/`). The file holds the claiming process's pid; a
 * claim whose process is gone is stale and taken over. A claimed port must also be free to bind.
 * The claims are dropped in `stop`.
 */
const PORTS_DIR = process.env.KEHIKOT_SCRATCH_PORTS ?? '/tmp/kehikko-scratch-ports'
const PORTS_FROM = 20000
const PORTS_SPAN = 10000
const claimed = []
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
function claim(port) {
  const file = join(PORTS_DIR, String(port))
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' })
      claimed.push(file)
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const holder = Number(readFileSync(file, 'utf8')) || 0
      if (holder && alive(holder)) return false
      rmSync(file, { force: true })
    }
  }
  return false
}
const portFree = (port) =>
  new Promise((done) => {
    const server = createServer()
    server.unref()
    server.on('error', () => done(false))
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
  })
/** `count` ports in a row, claimed and free. */
async function claimPorts(count) {
  mkdirSync(PORTS_DIR, { recursive: true })
  for (let tries = 0; tries < 200; tries += 1) {
    const first = PORTS_FROM + Math.floor(Math.random() * (PORTS_SPAN - count))
    const got = []
    for (let port = first; port < first + count; port += 1) {
      if (!claim(port)) break
      got.push(port)
    }
    if (got.length === count) {
      const free = await Promise.all(got.map(portFree))
      if (free.every(Boolean)) return first
    }
    for (const port of got) release(port)
  }
  throw new Error(`no ${count} free ports in a row between ${PORTS_FROM} and ${PORTS_FROM + PORTS_SPAN}`)
}
function release(port) {
  const file = join(PORTS_DIR, String(port))
  const at = claimed.indexOf(file)
  if (at >= 0) claimed.splice(at, 1)
  rmSync(file, { force: true })
}
const freePort = () => claimPorts(1)
/* The page is the API's port plus one (`server.ts`), so both are claimed together. */
const pairOfPorts = () => claimPorts(2)

let ROOT = ''
const at = (path) => join(ROOT, path)
const children = []
export function stop() {
  for (const child of children) {
    try {
      process.kill(child.pid, 'SIGTERM')
    } catch {}
  }
  children.length = 0
  for (const file of claimed.splice(0)) rmSync(file, { force: true })
  if (ROOT && !KEEP) rmSync(ROOT, { recursive: true, force: true })
  else if (ROOT) console.log(`scratch host kept at ${ROOT}`)
  ROOT = ''
}
process.on('exit', stop)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130))

/* What the last `bootHost` started, for a drive that needs more than the page's URL. */
export const scratch = { api: 0, page: 0, root: '', modules: [] }

/**
 * `env` is added to every process's environment. `traffic: true` makes the third stand-in (Gamma) a reader of the host's record of traffic, as
 * the Monitor is: it declares `traffic:read` and answers `GET /traffic?since=<seq>` with
 * `traffic.read` (`test/fixtures/standin/server.ts`).
 */
export async function bootHost(name = 'kehikko-drive', { traffic = false, env: more = {} } = {}) {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), `${name}-`)))
  for (const dir of ['home', 'project-a', 'project-b', 'modules', 'versions', 'installed', 'logs', 'claude']) mkdirSync(at(dir), { recursive: true })
  writeFileSync(at('project-a/README.md'), 'a\n')
  writeFileSync(at('project-b/README.md'), 'b\n')
  /* `SIDECAR=<path>`: the desktop app's own compiled host (`bun run
     build:sidecar`), which serves its page itself, on its own port — the
     build the app runs, rather than the page through Vite. */
  const sidecar = process.env.SIDECAR ?? null
  const api = await pairOfPorts()
  const page = sidecar ? api : api + 1
  const origins = [`http://127.0.0.1:${page}`, `http://localhost:${page}`, `http://127.0.0.1:${api}`, `http://localhost:${api}`]
  /* Nothing this shell says about where a host is goes through: a scratch module told the real
     app's origins (`KEHIKOT_ORIGINS`, on 4170) once talked to it. Every location is set below. */
  const inherited = { ...process.env }
  for (const key of ['PORT', 'HOST_PORT', 'KEHIKOT_ORIGIN', 'KEHIKOT_ORIGINS', 'KEHIKKO_RESTART_FILE', 'KEHIKKO_PORT', 'KEHIKKO_API_PORT', 'KEHIKKO_HOST_DIR']) delete inherited[key]
  const env = {
    ...inherited,
    KEHIKOT_ORIGIN: origins.join(' '),
    KEHIKOT_ORIGINS: origins.join(' '),
    HOME: at('home'),
    PORT: String(api),
    HOST_PORT: String(api),
    CLAUDE_CONFIG: at('home/.claude.json'),
    CLAUDE_CONFIG_DIR: at('claude'),
    KEHIKOT_FRAME_DB: at('frame.sqlite'),
    KEHIKOT_MODULES_DIR: at('modules'),
    KEHIKOT_VERSIONS_DIR: at('versions'),
    KEHIKOT_INSTALLS_DIR: at('installed'),
    KEHIKOT_OFFICIAL_CACHE: at('official-modules.json'),
    KEHIKOT_LOGS_DIR: at('logs'),
    KEHIKOT_OFFICIAL_LIST: 'off',
    KEHIKOT_SEED_PROJECT: at('project-a'),
    KEHIKKO_RESTART_FILE: at('restart'),
    ...more,
  }
  const run = (cmd, args, log, extra = {}) => {
    const out = openSync(at(log), 'a')
    const child = spawn(cmd, args, { cwd: HOST, env: { ...env, ...extra }, stdio: ['ignore', out, out] })
    child.log = log
    children.push(child)
    return child
  }
  const modules = []
  for (const [id, name] of [
    ['kehikot.alpha', 'Alpha'],
    ['kehikot.beta', 'Beta'],
    ['kehikot.gamma', 'Gamma'],
  ]) {
    const port = await freePort()
    modules.push({ id, name, port })
    writeFileSync(at(`modules/${id}.json`), JSON.stringify({ url: `http://127.0.0.1:${port}`, keep: true }))
    const reads = traffic && id === 'kehikot.gamma'
    run(BUN, [join(HOST, 'test/fixtures/standin/server.ts'), id, name, String(port), origins.join(' ')], `${name}.log`, reads ? { STANDIN_TRAFFIC: `http://127.0.0.1:${api}` } : {})
  }
  Object.assign(scratch, { api, page, root: ROOT, modules })
  if (sidecar) run(sidecar, [], 'api.log')
  else {
    run(BUN, ['run', 'server/server.ts'], 'api.log')
    run(join(HOST, 'node_modules/.bin/vite'), ['--port', String(page), '--strictPort', '--host', '127.0.0.1'], 'vite.log')
  }

  /* Until it answers; a process that ended first is named with what it said, rather than waited
     on. The ceiling is for a machine under load, not a pace. */
  const answers = async (url) => {
    const until = Date.now() + 90_000
    while (Date.now() < until) {
      const ended = children.find((child) => child.exitCode !== null || child.signalCode !== null)
      if (ended) {
        const said = readFileSync(at(ended.log), 'utf8').trim().split('\n').slice(-15).join('\n')
        throw new Error(`${ended.log.replace(/\.log$/, '')} ended (${ended.exitCode ?? ended.signalCode}) before ${url} answered:\n${said}`)
      }
      try {
        if ((await fetch(url)).ok) return
      } catch {}
      await new Promise((done) => setTimeout(done, 100))
    }
    throw new Error(`nothing answered at ${url} in 90 s; logs in ${ROOT} (KEEP=1 keeps them)`)
  }
  await answers(`http://127.0.0.1:${api}/host/health`)
  for (const { port } of modules) await answers(`http://127.0.0.1:${port}/healthz`)
  await answers(`http://127.0.0.1:${page}/`)

  const send = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${api}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${page}` },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
    return response.json()
  }
  const first = await (await fetch(`http://127.0.0.1:${api}/host/canvases`)).json()
  const a = first.projects[0].id
  const b = (await send('POST', '/host/projects', { path: at('project-b') })).project.id
  const wide = [
    { i: 'kehikot.alpha', x: 0, y: 0, w: 6, h: 14 },
    { i: 'kehikot.beta', x: 6, y: 0, w: 6, h: 14 },
    { i: 'kehikot.gamma', x: 0, y: 14, w: 12, h: 14 },
  ]
  const tall = [
    { i: 'kehikot.alpha', x: 0, y: 0, w: 4, h: 28 },
    { i: 'kehikot.beta', x: 4, y: 0, w: 4, h: 28 },
    { i: 'kehikot.gamma', x: 8, y: 0, w: 4, h: 28 },
  ]
  /* The kehikko a fresh project opens on holds the three as well, so the
     first load is a canvas of pages and not an empty one. */
  for (const canvas of first.canvases.filter((one) => one.project === a)) await send('PATCH', `/host/canvases/${canvas.id}`, { name: 'Wide', placements: wide })
  await send('POST', '/host/canvases', { name: 'Tall', project: a, placements: tall })
  await send('POST', '/host/canvases', { name: 'Tall', project: b, placements: wide })
  /* And the one project-b was given when it was added, if it was given one. */
  const again = await (await fetch(`http://127.0.0.1:${api}/host/canvases`)).json()
  const own = again.canvases.filter((one) => one.project === b && one.name !== 'Tall')
  for (const canvas of own) await send('PATCH', `/host/canvases/${canvas.id}`, { name: 'Wide', placements: tall })
  if (own.length === 0) await send('POST', '/host/canvases', { name: 'Wide', project: b, placements: tall })
  /* Two epics in project-a, and the project on the first. */
  await send('POST', '/host/epics', { project: a, slug: 'methods', title: 'Methods' })
  await send('POST', '/host/epics', { project: a, slug: 'results', title: 'Results' })
  await send('PATCH', '/host/subject', { project: a, epic: 'methods' })
  return `http://127.0.0.1:${page}/`
}

