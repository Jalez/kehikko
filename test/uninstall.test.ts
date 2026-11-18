import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { UNINSTALL_MARK } from 'kehikot-module-protocol'

import { createCanvas, editCanvas, listCanvases, open } from '../server/canvases.ts'
import { readDevelopment, writeDevelopment } from '../server/development.ts'
import { Inbox } from '../server/inbox.ts'
import { ensureKnown, remember } from '../server/known.ts'
import { addProject } from '../server/projects.ts'
import { forgetModule, isOwnCheckout, runCleanUp, uninstallDesk, uninstalledModules, uninstallSaid, type CleanUpRan, type UninstallDeps } from '../server/uninstall.ts'

const GONE = 'kehikot.gone'

describe('Uninstall removes everything Kehikot put on this computer for a module', () => {
  let db: Database
  let base: string
  let project: string
  let projectId: number
  let installed: string
  let versions: string
  let logs: string
  let registry: string
  let checkout: string
  let canvas: number
  let registered: { id: string; url: string; dir?: string }[]
  let stopped: string[]
  let versionsStopped: string[]
  let cleaned: string[]
  let cleanUp: (dir: string) => Promise<CleanUpRan>
  let refuseStop: string | null
  let agentLines: string[]
  let inbox: Inbox
  let deps: UninstallDeps

  const put = (path: string, text = 'x') => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }

  beforeEach(() => {
    db = open(':memory:')
    base = mkdtempSync(join(tmpdir(), 'kehikko-uninstall-'))
    project = join(base, 'project')
    put(join(project, '.kehikot', 'gone', 'data.json'), '{"keep":true}')
    const added = addProject(db, project, 'thesis')
    if (!added.ok) throw new Error(added.why)
    projectId = added.project.id
    installed = join(base, 'installed')
    versions = join(base, 'versions')
    logs = join(base, 'logs')
    registry = join(base, 'modules')
    checkout = join(base, 'my-checkout')
    put(join(installed, GONE, 'run.sh'), 'x'.repeat(4000))
    put(join(installed, '.previous', GONE, 'run.sh'), 'x'.repeat(2000))
    put(join(installed, '.incoming', `${GONE}-1.2.0-git-abc`, 'run.sh'))
    put(join(installed, 'kehikot.kept', 'run.sh'))
    put(join(versions, GONE, 'v1.0.0', 'run.sh'))
    put(join(logs, 'modules', `${GONE}.log`), 'started\n')
    put(join(logs, 'modules', `${GONE}@v1.0.0.log`), 'pinned\n')
    put(join(logs, 'modules', 'kehikot.kept.log'), 'other\n')
    put(join(checkout, 'run.sh'))
    put(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    for (const one of ['gone', 'kept', 'mine']) put(join(registry, `kehikot.${one}.json`), '{}')
    canvas = createCanvas(db, 'main', projectId).id
    const place = (i: string, x: number) => ({ i, x, y: 0, w: 4, h: 4 }) as never
    editCanvas(db, canvas, { placements: [place(GONE, 0), place('kehikot.kept', 4), place('kehikot.mine', 8)] })
    /* Machine-level records of the module, and of another that must stay. */
    ensureKnown(db)
    remember(db, GONE, 'Gone')
    db.exec("insert into module_state (module, state) values ('kehikot.gone', 'view'), ('kehikot.kept', 'view')")
    db.query('insert into container_state (canvas, module, state) values (?, ?, ?)').run(canvas, GONE, 'kept view')
    inbox = new Inbox(db)
    inbox.report(projectId, GONE, 'Gone', [{ id: 'a', state: 'attention', label: 'Needs you' } as never])
    inbox.report(projectId, 'kehikot.kept', 'Kept', [{ id: 'b', state: 'attention', label: 'Needs you too' } as never])
    db.exec("create table if not exists person_message_grants (module text primary key, at integer not null)")
    db.exec("insert into person_message_grants (module, at) values ('kehikot.gone', 1), ('kehikot.kept', 1)")
    writeDevelopment(db, { on: true, folders: { [GONE]: { dir: checkout }, 'kehikot.kept': { dir: '/k' } }, seen: { [GONE]: checkout } })
    registered = [
      { id: GONE, url: 'http://127.0.0.1:7001', dir: join(installed, GONE) },
      { id: 'kehikot.kept', url: 'http://127.0.0.1:7002', dir: join(installed, 'kehikot.kept') },
      { id: 'kehikot.mine', url: 'http://127.0.0.1:7003', dir: checkout },
    ]
    stopped = []
    versionsStopped = []
    cleaned = []
    refuseStop = null
    agentLines = []
    cleanUp = async (dir) => {
      cleaned.push(dir)
      return { ran: false }
    }
    deps = {
      db,
      installed,
      versions,
      logs,
      registry,
      registered: async () => registered.filter((one) => existsSync(join(registry, `${one.id}.json`))),
      nameOf: (id) => (id === GONE ? 'Gone' : id === 'kehikot.mine' ? 'Mine' : 'Kept'),
      projects: () => [{ id: projectId, name: 'thesis', path: project }],
      busy: () => false,
      stop: async (id) => {
        if (refuseStop) return { ok: false, why: refuseStop }
        stopped.push(id)
        return { ok: true }
      },
      stopVersions: (id) => void versionsStopped.push(id),
      cleanUp: (dir) => cleanUp(dir),
      agentModule: () => false,
      registryChanged: () => undefined,
      agentTidy: async () => agentLines,
      forgetInbox: (id) => void inbox.forgetAll(id, ''),
      log: () => undefined,
    }
  })
  afterEach(() => {
    db.close()
    rmSync(base, { recursive: true, force: true })
  })

  test('a full uninstall removes the install dirs, logs, registration and machine rows; it is stopped first', async () => {
    agentLines = ['Removed Gone’s tools from your agent: the module is no longer installed']
    const out = await uninstallDesk(deps, () => 1234).uninstall(GONE)
    if (!out.ok) throw new Error(out.why)
    expect(stopped).toEqual([GONE])
    expect(versionsStopped).toEqual([GONE])
    for (const gone of [
      join(installed, GONE),
      join(installed, '.previous', GONE),
      join(installed, '.incoming', `${GONE}-1.2.0-git-abc`),
      join(versions, GONE),
      join(logs, 'modules', `${GONE}.log`),
      join(logs, 'modules', `${GONE}@v1.0.0.log`),
      join(registry, `${GONE}.json`),
    ]) {
      expect(existsSync(gone)).toBe(false)
    }
    /* Another module's things stay. */
    expect(existsSync(join(installed, 'kehikot.kept', 'run.sh'))).toBe(true)
    expect(existsSync(join(logs, 'modules', 'kehikot.kept.log'))).toBe(true)
    expect(readdirSync(registry).sort()).toEqual(['kehikot.kept.json', 'kehikot.mine.json'])
    /* Its machine rows; another's stay. */
    expect(db.query("select module from module_state").all()).toEqual([{ module: 'kehikot.kept' }])
    expect(db.query("select * from container_state where module = 'kehikot.gone'").all()).toEqual([])
    expect(db.query("select module from person_message_grants").all()).toEqual([{ module: 'kehikot.kept' }])
    expect(db.query("select id from known_modules where id = 'kehikot.gone'").all()).toEqual([])
    expect(inbox.open(projectId).map((one) => one.module)).toEqual(['kehikot.kept'])
    expect(Object.keys(readDevelopment(db)!.folders)).toEqual(['kehikot.kept'])
    expect(readDevelopment(db)!.seen).toEqual({})
    /* The summary in words: what went, the space freed, and the host's own entries in the agent. */
    expect(out.freed).toBeGreaterThan(6000)
    expect(out.said).toStartWith('Gone is uninstalled. Removed: ')
    expect(out.said).toContain('the copy Kehikot installed')
    expect(out.said).toContain('its log')
    expect(out.said).toContain('removed Gone’s tools from your agent')
    expect(out.said).toMatch(/\d+ kB freed\./)
    expect(out.left).toEqual([])
  })

  test('its containers stay, and are said to be a module removed (with its name) until it is registered again', async () => {
    await uninstallDesk(deps).uninstall(GONE)
    expect(listCanvases(db).find((one) => one.id === canvas)!.placements.map((p) => p.i).sort()).toEqual([GONE, 'kehikot.kept', 'kehikot.mine'])
    expect(uninstalledModules(db, new Set(['kehikot.kept', 'kehikot.mine']))).toEqual([{ id: GONE, name: 'Gone', at: expect.any(Number) }])
    /* Reinstalled: no longer "removed". */
    expect(uninstalledModules(db, new Set([GONE]))).toEqual([])
    expect(uninstalledModules(db, new Set())).toEqual([])
  })

  test('the person’s checkout is never touched: unregistered, and said to be theirs to keep or remove', async () => {
    const out = await uninstallDesk(deps).uninstall('kehikot.mine')
    if (!out.ok) throw new Error(out.why)
    expect(existsSync(join(checkout, 'run.sh'))).toBe(true)
    expect(existsSync(join(checkout, '.git', 'HEAD'))).toBe(true)
    expect(existsSync(join(registry, 'kehikot.mine.json'))).toBe(false)
    expect(out.own).toBe(checkout)
    expect(out.said).toContain(`Kehikot no longer uses ${checkout}; it's yours to keep or remove.`)
    expect(isOwnCheckout(checkout, join(installed, 'kehikot.mine'))).toBe(true)
  })

  test('project data only with the checkbox', async () => {
    const desk = uninstallDesk(deps)
    const seen = await desk.preview(GONE)
    if (!seen.ok) throw new Error(seen.why)
    expect(seen.projects).toEqual([{ id: projectId, name: 'thesis', path: project, bytes: 13 }])
    expect(seen.bytes).toBeGreaterThan(6000)
    await desk.uninstall(GONE)
    expect(readFileSync(join(project, '.kehikot', 'gone', 'data.json'), 'utf8')).toBe('{"keep":true}')

    put(join(registry, `${GONE}.json`), '{}')
    const again = await desk.uninstall(GONE, { projects: true })
    if (!again.ok) throw new Error(again.why)
    expect(existsSync(join(project, '.kehikot', 'gone'))).toBe(false)
    expect(again.said).toContain('its saved data in thesis')
  })

  test('the agent-tool clean-up is the module’s own: its uninstall.ts runs in its folder before the folder goes, and its report is said', async () => {
    cleanUp = async (dir) => {
      cleaned.push(dir)
      expect(existsSync(join(dir, 'run.sh'))).toBe(true)
      return { ran: true, report: { removed: [{ what: 'Its SessionStart hook', path: '/home/.agent/settings.json' }], left: [{ what: 'The /x skill', path: '/home/.agent/skills/x', why: 'you changed it' }] } }
    }
    const out = await uninstallDesk(deps).uninstall(GONE)
    if (!out.ok) throw new Error(out.why)
    expect(cleaned).toEqual([join(installed, GONE)])
    expect(out.removed[0]).toEqual({ what: 'Its SessionStart hook', path: '/home/.agent/settings.json' })
    expect(out.said).toContain('its SessionStart hook')
    expect(out.said).toContain('Left: The /x skill (/home/.agent/skills/x), because you changed it.')
  })

  test('an agent module with no clean-up of its own: the host touches nothing of the agent’s and says so', async () => {
    deps.agentModule = () => true
    const out = await uninstallDesk(deps).uninstall(GONE)
    if (!out.ok) throw new Error(out.why)
    expect(out.left).toEqual([
      { what: 'Anything Gone wrote into your agent\'s own settings', why: 'this version has no clean-up of its own, so Kehikot removed only what it could prove was the module’s' },
    ])
  })

  test('something answering that Kehikot did not start is refused before anything is touched', async () => {
    refuseStop = 'Gone answers at http://127.0.0.1:7001 and Kehikot did not start it: stop it where it runs, then press Uninstall again'
    const out = await uninstallDesk(deps).uninstall(GONE)
    expect(out).toEqual({ ok: false, why: `${refuseStop}. Nothing was removed.`, status: 409 })
    expect(existsSync(join(installed, GONE))).toBe(true)
    expect(existsSync(join(registry, `${GONE}.json`))).toBe(true)
  })

  test('a module that is nowhere on this computer, or a bad id, is refused', async () => {
    expect((await uninstallDesk(deps).uninstall('kehikot.nowhere')).ok).toBe(false)
    expect((await uninstallDesk(deps).uninstall('../etc')).ok).toBe(false)
  })

  test('forgetModule touches only that module’s rows', () => {
    expect(forgetModule(db, 'kehikot.nothing')).toBe(0)
  })

  test('the words: nothing removed, and something left', () => {
    expect(uninstallSaid('Gone', [], [], 0)).toBe('Gone is uninstalled.')
    expect(uninstallSaid('Gone', [{ what: 'Its registration' }], [{ what: 'Its log', why: 'it is open.' }], 0)).toBe('Gone is uninstalled. Removed: its registration. Left: Its log, because it is open.')
  })
})

describe('runCleanUp: a module’s uninstall.ts, run as a script', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kehikko-cleanup-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('no script: not run', async () => {
    expect(await runCleanUp(dir, process.execPath, process.env)).toEqual({ ran: false })
  })

  test('runs in the module’s folder with the env it is given, and its marked line is the report', async () => {
    const owned = join(dir, 'owned-entry')
    writeFileSync(owned, 'x')
    writeFileSync(
      join(dir, 'uninstall.ts'),
      `import { rmSync } from 'node:fs'\nrmSync(process.env.OWNED, { force: true })\nconsole.log('cleaning…')\nconsole.log(${JSON.stringify(UNINSTALL_MARK)} + JSON.stringify({ removed: [{ what: 'Its entry', path: process.env.OWNED }], left: [] }))\n`,
    )
    const ran = await runCleanUp(dir, process.execPath, { ...process.env, OWNED: owned })
    expect(ran).toEqual({ ran: true, report: { removed: [{ what: 'Its entry', path: owned }], left: [] } })
    expect(existsSync(owned)).toBe(false)
  })

  test('one that fails or hangs is said, never waited on for ever', async () => {
    writeFileSync(join(dir, 'uninstall.ts'), 'process.exit(3)\n')
    expect(await runCleanUp(dir, process.execPath, process.env)).toEqual({ ran: true, report: null, why: 'stopped with exit code 3' })
    writeFileSync(join(dir, 'uninstall.ts'), 'await new Promise(() => setInterval(() => {}, 1000))\n')
    expect(await runCleanUp(dir, process.execPath, process.env, 300)).toEqual({ ran: true, report: null, why: 'did not finish within 1 second' })
  })
})
