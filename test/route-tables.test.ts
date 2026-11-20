import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ADOPT_ROUTES } from '../server/adoptRoutes.ts'
import { canvasDesk } from '../server/canvasRoutes.ts'
import { createCanvas, open } from '../server/canvases.ts'
import { PAGE_ONLY } from '../server/guard.ts'
import { mcpDesk } from '../server/mcpRoutes.ts'
import { ROUTE_TABLES } from '../server/routeTables.ts'
import { pageOnlyPaths, routes } from '../server/routes.ts'
import { settingsRouteDesk } from '../server/settingsRoutes.ts'

/*
 * A desk's routes are a table (`server/routes.ts`): each declares its method,
 * its path, and whether only this host's page may write to it. `PAGE_ONLY` in
 * `guard.ts` is built from those declarations, so a route moved into a table
 * keeps the guard it had, and one added to a table says in one place who may
 * write to it.
 */

const TABLES = ROUTE_TABLES
const specs = Object.entries(TABLES).flatMap(([table, routes]) => Object.entries(routes).map(([name, spec]) => ({ table, name, ...spec })))

const ok = (what: string) => () => new Response(what)
const ask = (method: string, path: string) => {
  const request = new Request(`http://127.0.0.1${path}`, { method })
  return [request, new URL(request.url)] as const
}

describe('routes', () => {
  const desk = routes(
    { read: { method: 'GET', path: '/host/x' }, write: { method: 'POST', path: '/host/x', pageOnly: true } },
    { read: ok('read'), write: ok('write') },
  )

  test('answers the route a request names by its exact method and path', async () => {
    expect(await (await desk.route(...ask('GET', '/host/x')))!.text()).toBe('read')
    expect(await (await desk.route(...ask('POST', '/host/x')))!.text()).toBe('write')
  })

  test('and nothing else: another method, a trailing slash, a longer path', async () => {
    expect(await desk.route(...ask('HEAD', '/host/x'))).toBeNull()
    expect(await desk.route(...ask('DELETE', '/host/x'))).toBeNull()
    expect(await desk.route(...ask('GET', '/host/x/'))).toBeNull()
    expect(await desk.route(...ask('GET', '/host/x/y'))).toBeNull()
  })

  test('two routes on one method and path are refused at once', () => {
    expect(() => routes({ a: { method: 'GET', path: '/host/x' }, b: { method: 'GET', path: '/host/x' } }, { a: ok('a'), b: ok('b') })).toThrow('Two routes answer GET /host/x.')
  })

  test('a GET is never page-only: the guard holds writes only', () => {
    expect(() => routes({ a: { method: 'GET', path: '/host/x', pageOnly: true } }, { a: ok('a') })).toThrow(/GET/)
  })

  test('a handler that answers null leaves the request to the routes after it', async () => {
    const passing = routes({ a: { method: 'GET', path: '/host/x' } }, { a: () => null })
    expect(await passing.route(...ask('GET', '/host/x'))).toBeNull()
  })

  test('pageOnlyPaths lists each declared page-only path once', () => {
    expect(pageOnlyPaths({ a: { method: 'POST', path: '/host/x', pageOnly: true }, b: { method: 'PATCH', path: '/host/x', pageOnly: true }, c: { method: 'POST', path: '/host/y' } })).toEqual(['/host/x'])
  })
})

describe('the canvases desk: one kehikko by the id in its path', () => {
  const db = open(':memory:')
  const desk = canvasDesk({ db, official: { layouts: () => [] } })
  const send = (method: string, path: string, body?: unknown) => {
    const request = new Request(`http://127.0.0.1${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
    return desk.route(request, new URL(request.url))
  }

  test('a PATCH renames it, a DELETE removes it, and the last one is kept', async () => {
    const one = createCanvas(db, 'one', null)
    const two = createCanvas(db, 'two', null)
    const renamed = await send('PATCH', `/host/canvases/${one.id}`, { name: 'first' })
    expect(((await renamed!.json()) as { canvas: { name: string } }).canvas.name).toBe('first')
    expect((await send('DELETE', `/host/canvases/${two.id}`))!.status).toBe(200)
    expect((await send('DELETE', `/host/canvases/${one.id}`))!.status).toBe(409)
    expect((await send('PATCH', '/host/canvases/999999', { name: 'x' }))!.status).toBe(404)
  })

  test('another method, or a path that is not a plain id, is not answered here', async () => {
    expect(await send('GET', '/host/canvases/1')).toBeNull()
    expect(await send('PATCH', '/host/canvases/1e3', { name: 'x' })).toBeNull()
    expect(await send('PATCH', '/host/canvases/', { name: 'x' })).toBeNull()
  })
})

describe('the settings desk: every POST under /host/module-settings, as before', () => {
  const read: string[] = []
  const desk = settingsRouteDesk({
    db: open(':memory:'),
    storage: { read: async () => ({}) as never },
    settingsListed: async () => [],
    moduleSettings: {
      read: async (module) => (read.push(module), { ok: true }) as never,
      file: async () => ({}) as never,
      set: async () => ({}) as never,
      vouch: () => ({ ok: true, person: false }),
    },
    personGrants: { saw: () => {} },
    setupDeps: {} as never,
    agentSync: { poke: () => {} },
  })
  const post = (path: string, body: unknown) => {
    const request = new Request(`http://127.0.0.1${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    return desk.route(request, new URL(request.url))
  }

  test('the four routes are answered', async () => {
    expect((await post('/host/module-settings', { module: 'kehikot.notes' }))!.status).toBe(200)
    expect(read).toEqual(['kehikot.notes'])
  })

  test('any other path under it is read for a module, and then left to the routes after it', async () => {
    expect((await post('/host/module-settings/other', {}))!.status).toBe(400)
    expect(await post('/host/module-settings/other', { module: 'kehikot.notes' })).toBeNull()
  })
})

describe('the MCP desk: POST /mcp, and a 405 for any other method there', () => {
  const asked: unknown[] = []
  const desk = mcpDesk({
    mcp: (async (rpc: unknown) => (asked.push(rpc), { status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } })) as never,
    door: async () => ({}) as never,
    about: { name: 'kehikko', version: '0.0.0' },
  })
  const send = (method: string, path: string, body?: unknown) => {
    const request = new Request(`http://127.0.0.1${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
    return desk.route(request, new URL(request.url))
  }

  test('a call is handed to the door, and anything that is not one is refused', async () => {
    expect((await send('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }))!.status).toBe(200)
    expect(asked).toHaveLength(1)
    expect((await send('POST', '/mcp', { nothing: true }))!.status).toBe(400)
    expect((await send('GET', '/mcp'))!.status).toBe(405)
    expect(await send('POST', '/mcp/other', {})).toBeNull()
  })
})

describe('PAGE_ONLY and the route tables say the same', () => {
  test('every route a table declares page-only is in PAGE_ONLY', () => {
    for (const spec of specs.filter((one) => one.pageOnly)) expect(PAGE_ONLY).toContain(spec.path)
  })

  test('and every write a table declares on a path in PAGE_ONLY says so itself', () => {
    const unsaid = specs.filter((one) => one.method !== 'GET' && PAGE_ONLY.includes(one.path) && !one.pageOnly)
    expect(unsaid).toEqual([])
  })

  test('the page-only paths are exactly the ones they were, all of them from the desks', () => {
    /* Byte for byte what `PAGE_ONLY` held as a literal list before the tables: 65 paths. */
    expect([...PAGE_ONLY].sort()).toEqual(
      [
        '/host/arranging', '/host/base-branch', '/host/connections', '/host/development', '/host/headers',
        '/host/inbox/act', '/host/inbox/adopt', '/host/inbox/adoption', '/host/inbox/afters', '/host/inbox/answer',
        '/host/inbox/migrate', '/host/inbox/notice', '/host/inbox/report', '/host/inbox/retrack', '/host/inbox/task',
        '/host/inbox/undo', '/host/inbox/untrack', '/host/inbox/untracked', '/host/inbox/use', '/host/kehikko-settings',
        '/host/kehikko-skills', '/host/kehikot/copy', '/host/layouts', '/host/log', '/host/logs/open',
        '/host/messages/clear', '/host/messages/mute', '/host/messages/say', '/host/mine/add', '/host/mine/adopt',
        '/host/mine/check', '/host/mine/install', '/host/mine/remove', '/host/module-addresses/check', '/host/module-settings',
        '/host/module-settings/file', '/host/module-settings/list', '/host/module-settings/set', '/host/onboarding', '/host/pinned-places',
        '/host/pressed', '/host/projects/followed', '/host/projects/locate', '/host/restart-anyway', '/host/restart-module',
        '/host/restart/now', '/host/restart/queue', '/host/settings', '/host/skills', '/host/sounds',
        '/host/sounds/remove', '/host/sounds/rename', '/host/startup', '/host/steps/cancel', '/host/stop-module',
        '/host/storage', '/host/tracker/refresh', '/host/trackers', '/host/uninstall', '/host/unused-folders',
        '/host/updates/cancel', '/host/updates/step-back', '/host/visits', '/host/whats-new', '/host/whats-new/mentions',
      ].sort(),
    )
    expect([...PAGE_ONLY].sort()).toEqual([...new Set([...pageOnlyPaths(...Object.values(TABLES)), ...ADOPT_ROUTES])].sort())
    /* Answered to programs too, as before. */
    for (const path of ['/host/updates', '/host/restart', '/host/canvases', '/host/projects', '/host/subject', '/host/epics', '/host/spaces', '/host/parts', '/host/modules', '/host/versions', '/host/start', '/host/call', '/host/tools', '/host/agent', '/host/hello', '/host/health', '/host/quiet', '/host/open', '/host/watch', '/mcp', '/host/inbox', '/host/messages', '/host/mine', '/host/server-ask']) expect(PAGE_ONLY).not.toContain(path)
  })

  test('guard.ts spells no path: the list is gone', () => {
    const guard = readFileSync(join(import.meta.dir, '..', 'server', 'guard.ts'), 'utf8')
    const at = guard.indexOf('export const PAGE_ONLY')
    const list = guard.slice(at, guard.indexOf('\n]\n', at))
    expect(list.length).toBeGreaterThan(0)
    expect(list).not.toMatch(/'\/host\//)
  })

  test('every route table in server/ is one PAGE_ONLY is built from', () => {
    const dir = join(import.meta.dir, '..', 'server')
    const declared = readdirSync(dir)
      .filter((file) => file.endsWith('.ts'))
      .flatMap((file) => [...readFileSync(join(dir, file), 'utf8').matchAll(/^export const (\w+) = \{\n(?:  .*\n)*?\} as const satisfies RouteTable/gm)].map((hit) => hit[1]!))
      .sort()
    expect(declared).toEqual(Object.keys(TABLES).sort())
  })

  test('the desks that match by hand match on their tables: no path is spelled outside the table', () => {
    const dir = join(import.meta.dir, '..', 'server')
    for (const file of ['anyway.ts', 'restartModule.ts', 'stopModule.ts', 'headers.ts', 'arranging.ts', 'inboxRoutes.ts', 'messageRoutes.ts', 'myModules.ts', 'skills.ts', 'agentSettings.ts', 'pickerOrder.ts', 'chime.ts']) {
      const source = readFileSync(join(dir, file), 'utf8')
      const table = source.match(/^export const \w+ = \{\n(?:  .*\n)*?\} as const satisfies RouteTable/m)?.[0] ?? ''
      expect(table.length, file).toBeGreaterThan(0)
      expect(source.replace(table, '').match(/'\/host\/[^']*'/g) ?? [], file).toEqual([])
    }
  })

  test('adopting is listed once, by its desk', () => {
    for (const path of ADOPT_ROUTES) expect(PAGE_ONLY).toContain(path)
    const guard = readFileSync(join(import.meta.dir, '..', 'server', 'guard.ts'), 'utf8')
    expect(guard).not.toContain("'/host/inbox/adopt'")
  })

  test('PAGE_ONLY names each path once', () => {
    expect(new Set(PAGE_ONLY).size).toBe(PAGE_ONLY.length)
  })

  test('no two tables answer one method and path', () => {
    const keys = specs.map((one) => `${one.method} ${one.path}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('server.ts routes a table’s paths only through its desk', () => {
  const server = readFileSync(join(import.meta.dir, '..', 'server', 'server.ts'), 'utf8')

  test('no route a table declares is still matched inline', () => {
    const inline = specs.filter((one) => server.includes(`url.pathname === '${one.path}' && request.method === '${one.method}'`))
    expect(inline).toEqual([])
  })

  test('one kehikko by its id is routed by the canvases desk alone', () => {
    expect(server).not.toContain('canvasId(')
  })

  test('every desk is asked', () => {
    for (const desk of ['logRoutes', 'trackerRoutes', 'updateRoutes', 'restartRoutes', 'canvasRoutes', 'kehikkoRoutes', 'projectRoutes', 'spaceRoutes', 'moduleRoutes', 'callRoutes', 'personRoutes', 'settingsRoutes', 'developmentRoutes', 'agentRoutes', 'hostRoutes', 'mcpRoutes']) expect(server).toContain(`await ${desk}.route(request, url)`)
  })
})
