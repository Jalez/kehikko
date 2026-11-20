import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ADOPT_ROUTES } from '../server/adoptRoutes.ts'
import { CALL_ROUTES } from '../server/callRoutes.ts'
import { CANVAS_ROUTES, canvasDesk } from '../server/canvasRoutes.ts'
import { createCanvas, open } from '../server/canvases.ts'
import { DEVELOPMENT_ROUTES } from '../server/developmentRoutes.ts'
import { PAGE_ONLY } from '../server/guard.ts'
import { KEHIKKO_ROUTES } from '../server/kehikkoRoutes.ts'
import { LOG_ROUTES } from '../server/logRoutes.ts'
import { MODULE_ROUTES } from '../server/moduleRoutes.ts'
import { PERSON_ROUTES } from '../server/personRoutes.ts'
import { PROJECT_ROUTES } from '../server/projectRoutes.ts'
import { RESTART_ROUTES } from '../server/restartRoutes.ts'
import { pageOnlyPaths, routes, type RouteTable } from '../server/routes.ts'
import { SETTINGS_ROUTES, settingsRouteDesk } from '../server/settingsRoutes.ts'
import { SPACE_ROUTES } from '../server/spaceRoutes.ts'
import { TRACKER_ROUTES } from '../server/trackerRoutes.ts'
import { UPDATE_ROUTES } from '../server/updateRoutes.ts'

/*
 * A desk's routes are a table (`server/routes.ts`): each declares its method,
 * its path, and whether only this host's page may write to it. `PAGE_ONLY` in
 * `guard.ts` is built from those declarations, so a route moved into a table
 * keeps the guard it had, and one added to a table says in one place who may
 * write to it.
 */

const TABLES: Record<string, RouteTable> = { LOG_ROUTES, TRACKER_ROUTES, UPDATE_ROUTES, RESTART_ROUTES, CANVAS_ROUTES, KEHIKKO_ROUTES, PROJECT_ROUTES, SPACE_ROUTES, MODULE_ROUTES, CALL_ROUTES, PERSON_ROUTES, SETTINGS_ROUTES, DEVELOPMENT_ROUTES }
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

describe('PAGE_ONLY and the route tables say the same', () => {
  test('every route a table declares page-only is in PAGE_ONLY', () => {
    for (const spec of specs.filter((one) => one.pageOnly)) expect(PAGE_ONLY).toContain(spec.path)
  })

  test('and every write a table declares on a path in PAGE_ONLY says so itself', () => {
    const unsaid = specs.filter((one) => one.method !== 'GET' && PAGE_ONLY.includes(one.path) && !one.pageOnly)
    expect(unsaid).toEqual([])
  })

  test('the page-only writes moved into tables are the ones that were listed', () => {
    expect(pageOnlyPaths(...Object.values(TABLES)).sort()).toEqual(
      ['/host/log', '/host/logs/open', '/host/module-addresses/check', '/host/restart/now', '/host/restart/queue', '/host/steps/cancel', '/host/tracker/refresh', '/host/trackers', '/host/updates/cancel', '/host/updates/step-back',
        '/host/layouts', '/host/connections', '/host/kehikot/copy', '/host/kehikko-skills', '/host/kehikko-settings', '/host/projects/followed', '/host/projects/locate', '/host/base-branch',
        '/host/onboarding', '/host/pinned-places', '/host/whats-new', '/host/whats-new/mentions', '/host/storage', '/host/module-settings', '/host/module-settings/list', '/host/module-settings/file', '/host/module-settings/set', '/host/uninstall', '/host/development', '/host/unused-folders'].sort(),
    )
    /* Answered to programs too, as before. */
    for (const path of ['/host/updates', '/host/restart', '/host/canvases', '/host/projects', '/host/subject', '/host/epics', '/host/spaces', '/host/parts', '/host/modules', '/host/versions', '/host/start', '/host/call']) expect(PAGE_ONLY).not.toContain(path)
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
    for (const desk of ['logRoutes', 'trackerRoutes', 'updateRoutes', 'restartRoutes', 'canvasRoutes', 'kehikkoRoutes', 'projectRoutes', 'spaceRoutes', 'moduleRoutes', 'callRoutes', 'personRoutes', 'settingsRoutes', 'developmentRoutes']) expect(server).toContain(`await ${desk}.route(request, url)`)
  })
})
