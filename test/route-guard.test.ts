import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PROJECT_ID } from 'kehikot-module-protocol'

import { PAGE_ONLY } from '../server/guard.ts'

/**
 * The rule in `server/guard.ts`, at the running server, one route family at a
 * time: a request shaped as this host's page sends it is acted on, one shaped
 * as a program sends it is acted on, and one shaped any other way is refused
 * with nothing changed — the database, the project's files, the agent's
 * configuration and the restart file are read before and after.
 *
 * Everything is scratch (`test/setup.ts` already points every machine location
 * away from the real one; this file gives the server its own on top). No press
 * here runs `claude`, `git` or `gh`: every body sent to a route that would is
 * one the route itself refuses before running anything, so a guard that let it
 * through would fail the test without anything having been run.
 */

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-route-guard-')))
const at = (name: string) => join(ROOT, name)

let port = 0
let api = ''
let page = ''
let child: ReturnType<typeof Bun.spawn> | null = null

type Shape = Record<string, string>
/** As the host's own page sends it. */
const fromPage = (): Shape => ({ origin: page, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'content-type': 'application/json' })
/** As a program with no browser in it sends it. */
const fromProgram = (): Shape => ({ 'content-type': 'application/json' })
/** Every shape that is neither. */
const others = (): Record<string, Shape> => ({
  'another site, text/plain': {
    origin: 'https://other.example',
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'no-cors',
    'content-type': 'text/plain;charset=UTF-8',
  },
  'another site, JSON': { origin: 'https://other.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
  'another page on this machine, text/plain': {
    origin: `http://127.0.0.1:${port + 7}`,
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'no-cors',
    'content-type': 'text/plain;charset=UTF-8',
  },
  'another page on this machine, JSON': { origin: `http://127.0.0.1:${port + 7}`, 'sec-fetch-site': 'same-site', 'content-type': 'application/json' },
  'the API’s own port as an origin': { origin: api, 'content-type': 'application/json' },
  'an opaque origin, form-encoded': { origin: 'null', 'content-type': 'application/x-www-form-urlencoded' },
  'a browser stating no origin': { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
})

async function send(method: string, path: string, body: unknown, headers: Shape): Promise<{ status: number; body: any; headers: Headers }> {
  const bare = body === undefined
  const sent = { ...headers }
  if (bare) delete sent['content-type']
  const response = await fetch(`${api}${path}`, { method, headers: sent, ...(bare ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    /* Not JSON: the text is the answer. */
  }
  return { status: response.status, body: parsed, headers: response.headers }
}

/** One request with a `Host` of our choosing, which `fetch` would not send. */
function withHost(host: string, path: string, method = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers: { host } }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on('error', reject)
    request.end()
  })
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(`${name}/`, ...files(full).map((inner) => `${name}/${inner}`))
    else out.push(`${name} ${readFileSync(full, 'utf8')}`)
  }
  return out
}

/** Everything a request here could have changed, read by a program. */
async function state(): Promise<string> {
  const canvases = await send('GET', '/host/canvases', undefined, {})
  const inbox = await send('GET', `/host/inbox?project=${canvases.body.projects[0].id}`, undefined, {})
  return JSON.stringify({
    inbox: inbox.body,
    projects: canvases.body.projects,
    canvases: canvases.body.canvases,
    subjects: canvases.body.subjects,
    project: files(at('project')),
    other: files(at('other')),
    modules: files(at('modules')),
    agent: readFileSync(at('claude.json'), 'utf8'),
    restart: existsSync(at('restart')),
  })
}

beforeAll(async () => {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  port = probe.port ?? 0
  probe.stop(true)
  api = `http://127.0.0.1:${port}`
  /* In development the page is on the next port up. */
  page = `http://127.0.0.1:${port + 1}`

  for (const dir of ['project', 'other', 'modules', 'versions', 'installed', 'logs']) mkdirSync(at(dir), { recursive: true })
  /* The agent already knows this host's door, so a `connect` press is refused before anything is run. */
  writeFileSync(at('claude.json'), JSON.stringify({ mcpServers: { kehikko: { type: 'http', url: `${api}/mcp` } } }, null, 2))

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
      KEHIKOT_LOGS_DIR: at('logs'),
      KEHIKOT_SEED_PROJECT: at('project'),
      KEHIKOT_OFFICIAL_LIST: 'off',
      KEHIKKO_RESTART_FILE: at('restart'),
      KEHIKOT_ORIGIN: '',
      KEHIKOT_ORIGINS: '',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })

  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${api}/host/health`)).ok) return
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

describe('the running server and where a request came from', () => {
  test('every route family: refused from anywhere else with nothing changed, answered from the page', async () => {
    /* Set the scene as a program: a project (seeded), a second kehikko, an epic. */
    const first = await send('GET', '/host/canvases', undefined, {})
    const project: number = first.body.projects[0].id
    const kehikko: number = first.body.canvases[0].id
    const made = await send('POST', '/host/canvases', { name: 'second', project }, fromProgram())
    expect(made.status).toBe(201)
    const second: number = made.body.canvas.id
    expect((await send('POST', '/host/epics', { project, slug: 'one', title: 'One' }, fromProgram())).status).toBe(201)

    /**
     * One of each family. Where a route would run a program outside this host
     * (`/host/agent`, `/host/updates`, `/host/start`, `/host/feedback`, the
     * official list), the body names something the route refuses by itself.
     */
    const families: Array<{ method: string; path: string; body?: unknown }> = [
      { method: 'POST', path: '/host/canvases', body: { name: 'unwanted', project } },
      { method: 'PATCH', path: `/host/canvases/${kehikko}`, body: { name: 'renamed', placements: [] } },
      { method: 'DELETE', path: `/host/canvases/${second}` },
      { method: 'POST', path: '/host/projects', body: { path: at('other'), name: 'other' } },
      { method: 'PATCH', path: '/host/projects', body: { id: project, shared: true } },
      { method: 'DELETE', path: '/host/projects', body: { id: project } },
      { method: 'PATCH', path: '/host/subject', body: { project, epic: 'one' } },
      { method: 'POST', path: '/host/epics', body: { project, slug: 'two', title: 'Two' } },
      { method: 'PATCH', path: '/host/epics', body: { project, slug: 'one', title: 'Renamed' } },
      { method: 'DELETE', path: '/host/epics', body: { project, slug: 'one' } },
      { method: 'POST', path: '/host/parts', body: { project, epic: 'one', add: { name: 'Unwanted' } } },
      { method: 'POST', path: '/host/tracker/refresh', body: { project: 999999 } },
      { method: 'POST', path: '/host/versions', body: { module: 'kehikot.nothing', kehikko, version: null } },
      { method: 'POST', path: '/host/call', body: { module: 'kehikot.nothing', method: 'state.set', params: {} } },
      { method: 'POST', path: '/host/updates', body: { id: 'nothing' } },
      { method: 'POST', path: '/host/restart' },
      { method: 'POST', path: '/host/start', body: { module: 'kehikot.nothing' } },
      { method: 'POST', path: '/host/restart-anyway', body: { module: 'kehikot.nothing', press: 'arm' } },
      { method: 'POST', path: '/host/agent', body: { module: 'kehikko', press: 'connect' } },
      { method: 'POST', path: '/host/open', body: { page: 'somebody', kehikko } },
      { method: 'POST', path: '/host/headers', body: { page: 'somebody', kehikko, headers: {} } },
      { method: 'POST', path: '/host/pressed', body: { page: 'somebody', id: 'nothing', ok: true, why: '' } },
      { method: 'POST', path: '/host/inbox/report', body: { project, module: 'kehikot.nothing', name: 'Nothing', items: [{ id: 'a', state: 'attention', label: 'Unwanted' }] } },
      { method: 'POST', path: '/host/inbox/notice', body: { project, module: 'kehikot.nothing', name: 'Nothing', line: { epic: 'one', message: 'Unwanted', level: 'done' } } },
      { method: 'POST', path: '/host/inbox/act', body: { project, do: 'forget' } },
      { method: 'POST', path: '/host/inbox/migrate', body: { project, seen: {}, told: {} } },
      { method: 'POST', path: '/host/trackers', body: { project: 1, edit: { kind: 'remotes', on: false } } },
      { method: 'POST', path: '/host/storage', body: {} },
      { method: 'POST', path: '/host/feedback', body: {} },
      { method: 'POST', path: '/host/official/install', body: { module: 'kehikot.nothing' } },
      { method: 'POST', path: '/host/official/propose', body: { module: 'kehikot.nothing' } },
      { method: 'POST', path: '/host/no-such-route', body: {} },
      { method: 'POST', path: '/mcp', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_epic', arguments: { project, title: 'From elsewhere' } } } },
      { method: 'PUT', path: '/', body: {} },
    ]

    const before = await state()

    /* 1. From anywhere else: refused, and nothing is different afterwards. */
    for (const family of families) {
      for (const [name, shape] of Object.entries(others())) {
        const answered = await send(family.method, family.path, family.body, shape)
        expect(answered.status, `${family.method} ${family.path} from ${name}`).toBe(403)
        expect(answered.body.ok).toBe(false)
        expect(answered.body.why).toContain('Nothing was done.')
        expect(answered.headers.get('access-control-allow-origin')).toBeNull()
      }
      /* A program that does not say JSON is refused too, when it sends a body. */
      if (family.body !== undefined) {
        const plain = await send(family.method, family.path, family.body, { 'content-type': 'text/plain' })
        expect(plain.status, `${family.method} ${family.path} as text/plain`).toBe(PAGE_ONLY.includes(family.path) ? 403 : 415)
      }
      /* And the routes that are the page's alone answer no program at all. */
      if (PAGE_ONLY.includes(family.path)) {
        expect((await send(family.method, family.path, family.body, fromProgram())).status, `${family.path} from a program`).toBe(403)
      }
    }
    expect(await state()).toBe(before)

    /* 2. From the page: each reaches its route. `/mcp` is not the page's. */
    const pressed = async (method: string, path: string, body?: unknown) => {
      const answered = await send(method, path, body, fromPage())
      expect([403, 415], `${method} ${path} from the page answered ${answered.status}`).not.toContain(answered.status)
      expect(answered.headers.get('access-control-allow-origin')).toBeNull()
      return answered
    }

    expect((await pressed('POST', '/host/canvases', { name: 'third', project })).status).toBe(201)
    expect((await pressed('PATCH', `/host/canvases/${kehikko}`, { name: 'renamed' })).body.canvas.name).toBe('renamed')
    expect((await pressed('DELETE', `/host/canvases/${second}`)).body.deleted).toBe(second)

    const added = await pressed('POST', '/host/projects', { path: at('other'), name: 'other' })
    expect(added.status).toBe(201)
    /* Not a repository, so sharing is the route's own refusal — which is the route having been reached. */
    expect((await pressed('PATCH', '/host/projects', { id: added.body.project.id, shared: false })).status).toBe(409)
    expect((await pressed('DELETE', '/host/projects', { id: added.body.project.id })).status).toBe(200)

    expect((await pressed('POST', '/host/epics', { project, slug: 'two', title: 'Two' })).status).toBe(201)
    /* The storage overview answers the page, measured and read-only. */
    const measured = await pressed('POST', '/host/storage', {})
    expect(measured.status).toBe(200)
    expect(Array.isArray(measured.body.projects)).toBe(true)
    expect(Array.isArray(measured.body.machine.parts)).toBe(true)
    expect((await pressed('PATCH', '/host/epics', { project, slug: 'two', title: 'Second' })).body.epic.title).toBe('Second')
    expect((await pressed('PATCH', '/host/subject', { project, epic: 'two' })).body.subject.epic).toBe('two')
    /* The picker's edit of an epic's parts: the protocol's result, and the row as it now reads. */
    const part = await pressed('POST', '/host/parts', { project, epic: 'two', add: { name: 'A first part' } })
    expect(part.body.result).toMatchObject({ outcome: 'changed', id: 'a-first-part', parts: [{ id: 'a-first-part', name: 'A first part' }] })
    expect(part.body.epic.parts).toEqual([{ id: 'a-first-part', heading: 'A first part', refs: [], steps: 0 }])
    expect((await pressed('POST', '/host/parts', { project, epic: 'two', remove: { id: 'nope' } })).body.result.outcome).toBe('no-such-part')
    expect((await pressed('POST', '/host/parts', { project, epic: 'no-such-epic', add: { name: 'A' } })).body.result.outcome).toBe('declined')
    expect((await pressed('POST', '/host/parts', { project, epic: 'two' })).status).toBe(400)
    expect((await send('GET', `/host/epics?project=${project}`, undefined, {})).body.epics.find((e: { slug: string }) => e.slug === 'two').parts).toHaveLength(1)
    expect((await pressed('DELETE', '/host/epics', { project, slug: 'two' })).body.deleted).toBe('two')

    expect((await pressed('POST', '/host/tracker/refresh', { project: 999999 })).status).toBe(404)
    expect((await pressed('POST', '/host/versions', { module: 'kehikot.nothing', kehikko, version: null })).status).not.toBe(500)
    expect((await pressed('POST', '/host/call', { module: 'kehikot.nothing', method: 'state.set', params: {} })).body.ok).toBe(false)
    expect((await pressed('POST', '/host/updates', { id: 'nothing' })).status).toBe(404)
    expect((await pressed('POST', '/host/start', { module: 'kehikot.nothing' })).status).toBe(409)
    expect((await pressed('POST', '/host/restart-anyway', { module: 'kehikot.nothing', press: 'arm' })).status).toBe(409)
    expect((await pressed('POST', '/host/agent', { module: 'kehikko', press: 'connect' })).status).toBe(409)
    expect((await pressed('POST', '/host/open', { page: 'somebody', kehikko })).body.ok).toBe(true)
    expect((await pressed('POST', '/host/headers', { page: 'somebody', kehikko, headers: {} })).body.ok).toBe(true)
    /* No press is waiting on that id, which is the route's own answer. */
    await pressed('POST', '/host/pressed', { page: 'somebody', id: 'nothing', ok: true, why: '' })
    /* The inbox: a list is kept, a line is kept, and a person's act is the page's alone. */
    const reported = await pressed('POST', '/host/inbox/report', {
      project,
      module: 'kehikot.nothing',
      name: 'Nothing',
      items: [{ id: 'a', state: 'attention', label: 'Wants an answer', priority: 'urgent', group: 'g', refs: ['gh#1'] }],
    })
    expect(reported.body).toMatchObject({ ok: true, open: [{ id: 'a', priority: 'urgent', group: 'g', refs: ['gh#1'] }] })
    expect((await pressed('POST', '/host/inbox/report', { project, module: 'kehikot.nothing', items: [{ id: 'a' }] })).status).toBe(400)
    expect((await pressed('POST', '/host/inbox/notice', { project, module: 'kehikot.nothing', name: 'Nothing', line: { epic: 'one', message: 'Said once', level: 'done' } })).body.ok).toBe(true)
    expect((await pressed('POST', '/host/inbox/act', { project, do: 'dismiss', keys: [{ module: 'kehikot.nothing', id: 'a' }] })).body.changed).toBe(1)
    expect((await pressed('POST', '/host/inbox/migrate', { project, seen: {}, told: {} })).body.ok).toBe(true)
    expect((await send('GET', `/host/inbox/log?project=${project}&scope=everywhere`, undefined, {})).body.rows).toHaveLength(1)
    expect((await pressed('POST', '/host/feedback', {})).status).toBe(400)
    expect((await pressed('POST', '/host/official/install', { module: 'kehikot.nothing' })).status).toBeGreaterThanOrEqual(400)
    expect((await pressed('POST', '/host/official/propose', { module: 'kehikot.nothing' })).status).toBeGreaterThanOrEqual(400)
    expect((await pressed('POST', '/host/no-such-route', {})).status).toBe(404)

    /* The restart, last: the one press with no body, and it writes the file the shell watches. */
    expect(existsSync(at('restart'))).toBe(false)
    expect((await pressed('POST', '/host/restart')).body.ok).toBe(true)
    expect(existsSync(at('restart'))).toBe(true)

    /* And what the page changed is what is there now. */
    const after = await send('GET', '/host/canvases', undefined, {})
    expect(after.body.canvases.map((one: { name: string }) => one.name).sort()).toEqual(['renamed', 'third'])
    expect(after.body.projects.map((one: { id: number }) => one.id)).toEqual([project])
    expect(readFileSync(at('claude.json'), 'utf8')).toBe(JSON.parse(before).agent)
  }, 60000)

  test('programs with no browser in them are answered', async () => {
    /* The desktop shell's question, as it sends it: HTTP with a Host and nothing else. */
    expect(await withHost(`127.0.0.1:${port}`, '/host/health')).toBe(200)
    expect(await withHost(`localhost:${port}`, '/host/health')).toBe(200)
    /* Another copy of this host asking who is on the port (`claim.ts`). */
    expect((await send('GET', '/host/hello', undefined, {})).body.kehikko).toBe(true)

    /* An agent at the door: JSON and no Origin. */
    const listed = await send('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, fromProgram())
    expect(listed.status).toBe(200)
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toContain('read_canvas')
    /* And this host asking its own door, through `/host/tools`. */
    const tools = await send('GET', '/host/tools?module=kehikko', undefined, {})
    expect(tools.body.tools.ok).toBe(true)

    /* A script changing something, as `dev/` and this suite do. */
    const canvases = await send('GET', '/host/canvases', undefined, {})
    const made = await send('POST', '/host/canvases', { name: 'by a script', project: canvases.body.projects[0].id }, fromProgram())
    expect(made.status).toBe(201)
    expect((await send('DELETE', `/host/canvases/${made.body.canvas.id}`, undefined, {})).status).toBe(200)

    /* The one route that is a press and nothing else stays the page's alone. */
    const anyway = await send('POST', '/host/restart-anyway', { module: 'kehikot.nothing', press: 'arm' }, fromProgram())
    expect(anyway.status).toBe(403)
  })

  test('the door at /mcp answers no page, this host’s own included', async () => {
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    for (const [name, shape] of Object.entries({ ...others(), 'this host’s page': fromPage() })) {
      const answered = await send('POST', '/mcp', call, shape)
      expect(answered.status, name).toBe(403)
      expect(answered.body.result).toBeUndefined()
    }
    expect((await send('POST', '/mcp', call, { 'content-type': 'text/plain' })).status).toBe(415)
  })

  test('a GET under /host/ is answered to the page and to a program, and to no other page', async () => {
    const sameOrigin = { 'sec-fetch-site': 'same-origin' }
    for (const path of ['/host/modules', '/host/canvases', '/host/projects', '/host/updates', '/host/official', '/host/hello']) {
      expect((await send('GET', path, undefined, sameOrigin)).status, path).toBe(200)
      expect((await send('GET', path, undefined, {})).status, path).toBe(200)
      for (const shape of [
        { 'sec-fetch-site': 'cross-site' },
        { 'sec-fetch-site': 'same-site' },
        { origin: 'https://other.example' },
        { origin: `http://127.0.0.1:${port + 7}`, 'sec-fetch-site': 'same-site' },
      ] as Shape[]) {
        const answered = await send('GET', path, undefined, shape)
        expect(answered.status, `${path} ${JSON.stringify(shape)}`).toBe(403)
        expect(answered.headers.get('access-control-allow-origin')).toBeNull()
      }
    }
    /* Asking first, as a browser does before sending JSON elsewhere, is given no leave. */
    const asked = await fetch(`${api}/host/epics`, {
      method: 'OPTIONS',
      headers: { origin: 'https://other.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    })
    expect(asked.status).toBe(403)
    expect(asked.headers.get('access-control-allow-origin')).toBeNull()
    expect(asked.headers.get('access-control-allow-methods')).toBeNull()
  })

  test('a request naming another address is refused whatever it asks for', async () => {
    for (const host of ['other.example', `other.example:${port}`, `other.localhost:${port}`, '127.0.0.1:1']) {
      expect(await withHost(host, '/host/health'), host).toBe(403)
      expect(await withHost(host, '/host/modules'), host).toBe(403)
      expect(await withHost(host, '/'), host).toBe(403)
      expect(await withHost(host, '/host/restart', 'POST'), host).toBe(403)
    }
    /* The page's port is this host's too: the development page server passes `Host` through. */
    expect(await withHost(`127.0.0.1:${port + 1}`, '/host/health')).toBe(200)
  })
})

describe('whether a folder is a project the person added', () => {
  const ask = (path: string | null, headers: Shape = {}) =>
    send('GET', `/host/is-project${path === null ? '' : `?path=${encodeURIComponent(path)}`}`, undefined, headers)

  test('a program is told yes for a project, by any spelling of its folder, and no for anything else in one word', async () => {
    /* Yes comes with the project's id (protocol 2.3.0). */
    const yes = { ok: true, project: true, id: expect.stringMatching(PROJECT_ID) }
    expect((await ask(at('project'))).body).toEqual(yes)
    expect((await ask(`${at('project')}/`)).body).toEqual(yes)
    expect((await ask(join(at('other'), '..', 'project'))).body).toEqual(yes)
    /* A folder that is there and is not a project, one inside a project, one that is not there, and no path at all. */
    for (const not of [at('other'), join(at('project'), '.kehikot'), at('nothing-here'), 'project', '', null]) {
      expect((await ask(not)).body, String(not)).toEqual({ ok: true, project: false })
    }
  })

  test('and never the list: the answer is that one word', async () => {
    expect(Object.keys((await ask(at('project'))).body).sort()).toEqual(['id', 'ok', 'project'])
  })

  test('the host’s own page may ask; another page — a module’s — may not', async () => {
    expect((await ask(at('project'), { origin: page })).body.project).toBe(true)
    for (const [name, shape] of Object.entries(others())) {
      expect((await ask(at('project'), shape)).status, name).toBe(403)
    }
  })
})

