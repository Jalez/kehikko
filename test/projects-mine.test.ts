import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SERVER_ASK_PATH, SERVER_PASS_PATH, serverAskResult } from 'kehikot-module-protocol'
import { askHost, serverPassReply } from 'kehikot-module-protocol/serve'

import { answer } from '../server/answers.ts'
import type { Project } from '../server/projects.ts'
import { projectsMine } from '../server/projectsMine.ts'
import { serverAskDesk } from '../server/serverAsk.ts'

/**
 * `projects.mine` (protocol 2.76.0): the person's projects in which the asking module keeps its own
 * folder, what a module's server asks at start so that what it runs in a project nobody has opened
 * since a restart is picked up. Never the person's whole list.
 */

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-projects-mine-')))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const MODULE = 'kehikot.alpha'
const HOST = 'http://127.0.0.1:4180'
const ORIGIN = 'http://127.0.0.1:4701'

function project(name: string, over: Partial<Project> = {}): Project {
  const path = join(folder, name)
  mkdirSync(path, { recursive: true })
  return { id: 1, name, path, epics: false, git: false, shared: false, missing: false, uid: null, followed: null, baseBranch: null, ...over }
}
const keeps = (p: Project, module = 'alpha') => mkdirSync(join(p.path, '.kehikot', module), { recursive: true })

describe('projectsMine', () => {
  test('only the projects whose .kehikot/<module>/ exists, in the person’s order, with name and id', () => {
    const one = project('one', { uid: 'one-project-id' })
    const two = project('two')
    const three = project('three')
    keeps(one)
    keeps(three)
    keeps(two, 'beta')
    expect(projectsMine([one, two, three], MODULE)).toEqual([
      { path: one.path, name: 'one', id: 'one-project-id' },
      { path: three.path, name: 'three' },
    ])
  })
  test('never a missing folder or the unpicked home folder', () => {
    const gone = project('gone', { missing: true })
    const home = project('home', { home: true })
    keeps(gone)
    keeps(home)
    expect(projectsMine([gone, home], MODULE)).toEqual([])
  })
  test('an id that is no module’s answers nothing', () => {
    const one = project('one')
    keeps(one)
    expect(projectsMine([one], 'not an id')).toEqual([])
  })
})

describe('answer: projects.mine', () => {
  const known = (id: string) => id === MODULE
  const ask = (may: boolean, mine: ((m: string) => { path: string; name: string }[]) | null) =>
    answer(MODULE, 'projects.mine', {}, known, () => {}, null, undefined, null, null, null, { may: () => may }, null, mine)

  test('held to agents:message', () => {
    const said = ask(false, () => [{ path: '/a', name: 'a' }])
    expect(said.ok).toBe(false)
    expect(!said.ok && said.error).toContain('agents:message')
  })
  test('answered from the list it was given, for the asking module', () => {
    let asked = ''
    const said = ask(true, (m) => {
      asked = m
      return [{ path: '/a/one', name: 'one' }]
    })
    expect(asked).toBe(MODULE)
    expect(said).toEqual({ ok: true, data: { projects: [{ path: '/a/one', name: 'one' }] } })
  })
  test('refused with a sentence when no list was given', () => {
    expect(ask(true, null).ok).toBe(false)
  })
})

describe('a module’s server asking it', () => {
  function desk(may: boolean, projects: Project[]) {
    const route = serverAskDesk({
      known: (id) => id === MODULE,
      originOf: async () => ORIGIN,
      may: () => may,
      projectAt: () => null,
      answer: (module, method, params, root) =>
        answer(module, method, params, (id) => id === MODULE, () => {}, root, undefined, null, null, null, { may: () => may }, null, (m) => projectsMine(projects, m)),
      fetch: (async (input: string | URL | Request) => {
        const url = new URL(String(input instanceof Request ? input.url : input))
        const said = serverPassReply('GET', url.pathname, url.searchParams)!
        return Response.json(said.body, { status: said.status })
      }) as unknown as typeof fetch,
    })
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      return (await route.route(request, new URL(request.url))) ?? new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
  }

  test('names no project and is told the projects it keeps its folder in', async () => {
    const one = project('one')
    const two = project('two')
    keeps(two)
    const read = await askHost('projects.mine', {}, { module: MODULE, env: { KEHIKOT_ORIGINS: HOST }, fetch: desk(true, [one, two]) })
    expect(read.ok && read.data.projects.map((p) => p.path)).toEqual([two.path])
  })
  test('a module that did not declare agents:message is refused the grant', async () => {
    const one = project('one')
    keeps(one)
    const read = await askHost('projects.mine', {}, { module: MODULE, env: { KEHIKOT_ORIGINS: HOST }, fetch: desk(false, [one]) })
    expect(read.ok).toBe(false)
    expect(!read.ok && read.refused).toBe('grant')
  })
  test('the route answers the protocol’s shape', async () => {
    expect(SERVER_ASK_PATH).toBe('/host/server-ask')
    expect(SERVER_PASS_PATH).toBe('/api/kehikot/server-pass')
    expect(serverAskResult.safeParse({ ok: true, data: { projects: [] } }).success).toBe(true)
  })
})
