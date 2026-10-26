import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { PAGE_FILES_REASON, receivedRow, routeReason } from '../server/traffic.ts'

/*
 * Every request this host answers is filed with a reason (`routeReason` in `server/traffic.ts`).
 * Monitor's record on 0.1.72 showed 578 of Kehikot's own 1261 calls in the fifteen minutes after a
 * start as "no reason given": the reasons were looked up by the exact path, so `/host/canvases/3`,
 * `/host/inbox/notice`, the module settings and the desktop app's own page files had none.
 */

const SERVER = join(import.meta.dir, '..', 'server')

/** Source without its block comments: a path a comment mentions is not a route. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : /\.ts$/.test(name) ? [path] : []
  })
}

/** Every `/host/…` path the server's code names: its routes, and the routes they are under. */
function routes(): string[] {
  const found = new Set<string>()
  for (const path of files(SERVER)) {
    for (const match of code(readFileSync(path, 'utf8')).matchAll(/'(\/host\/[a-z][a-z/-]*[a-z])'/g)) found.add(match[1]!)
  }
  return [...found].sort()
}

describe('the reason a received request is filed under', () => {
  test('finds the routes', () => {
    const all = routes()
    for (const one of ['/host/modules', '/host/watch', '/host/inbox/notice', '/host/module-settings/set', '/host/mine/add']) expect(all).toContain(one)
  })

  test('every route the server answers has one', () => {
    expect(routes().filter((path) => routeReason(path) === null)).toEqual([])
  })

  test('a route with an id after it is about its route', () => {
    expect(routeReason('/host/canvases/12')).toBe(routeReason('/host/canvases'))
    expect(routeReason('/host/mine/remove')).toBe('my modules')
  })

  test("the desktop app's page files are the page loading; an unknown /host path has none", () => {
    expect(routeReason('/')).toBe(PAGE_FILES_REASON)
    expect(routeReason('/assets/index-abc.js')).toBe(PAGE_FILES_REASON)
    expect(routeReason('/host/nothing-here')).toBeNull()
    expect(routeReason('/mcp')).not.toBeNull()
  })

  test('the received row carries it', () => {
    const page = 'http://127.0.0.1:4170'
    const request = new Request('http://127.0.0.1:4171/host/canvases/3', { method: 'PATCH', headers: { origin: page } })
    expect(receivedRow(request, new Response('{}'), 1, 1, { pageOrigins: [page] }, null)?.reason).toBe('the page reads or saves the kehikot')
  })
})
