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
import { mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOST = join(dirname(fileURLToPath(import.meta.url)), '..')
const KEEP = process.env.KEEP === '1'
const BUN = process.env.BUN ?? 'bun'

/* Every port handed out, so the next one asked for is a different one: a port
   is free until something listens on it, and nothing has yet. */
const taken = new Set()
const freePort = async () => {
  for (;;) {
    const port = await anyPort()
    if (!taken.has(port) && !taken.has(port - 1)) return taken.add(port), port
  }
}
const anyPort = () =>
  new Promise((done, fail) => {
    const server = createServer()
    server.unref()
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
const portFree = (port) =>
  new Promise((done) => {
    const server = createServer()
    server.unref()
    server.on('error', () => done(false))
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
  })
/* The page is the API's port plus one (`server.ts`), so both must be free. */
async function pairOfPorts() {
  for (let tries = 0; tries < 50; tries += 1) {
    const api = await freePort()
    if (!taken.has(api + 1) && (await portFree(api + 1))) return taken.add(api + 1), api
  }
  throw new Error('no two free ports in a row')
}

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

  const answers = async (url) => {
    for (let tries = 0; tries < 300; tries += 1) {
      try {
        if ((await fetch(url)).ok) return
      } catch {}
      await new Promise((done) => setTimeout(done, 100))
    }
    throw new Error(`nothing answered at ${url}; logs in ${ROOT} (KEEP=1 keeps them)`)
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

