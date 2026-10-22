import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { baseBranchOf, branchNameProblem, forgetOriginDefaults, originDefault, readBaseBranch, setBaseBranch, settingsFile } from '../server/baseBranch.ts'
import { open } from '../server/canvases.ts'
import type { Ran, Runner } from '../server/feedback.ts'
import { addProject, listProjects } from '../server/projects.ts'
import { toWireContext, whileFrozen, type Subject } from '../src/host/context.ts'

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-base-branch-')))
  forgetOriginDefaults()
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const MAIN = () => 'main'

/** A git that answers by the subcommand: `remote get-url`, `ls-remote` and `rev-parse` each with an exit code. */
function git(codes: { remote?: number; lsRemote?: number; revParse?: number }): { run: Runner; asked: string[][] } {
  const asked: string[][] = []
  const run: Runner = async (argv) => {
    asked.push(argv)
    const code = argv.includes('get-url') ? (codes.remote ?? 0) : argv.includes('ls-remote') ? (codes.lsRemote ?? 0) : argv.includes('rev-parse') ? (codes.revParse ?? 1) : 1
    return { code, out: '', err: '' } satisfies Ran
  }
  return { run, asked }
}

const written = () => JSON.parse(readFileSync(settingsFile(folder)!, 'utf8')) as Record<string, unknown>

describe('the file', () => {
  test('is .kehikot/host/settings.json, beside kehikot.json', () => {
    expect(settingsFile(folder)).toBe(join(folder, '.kehikot', 'host', 'settings.json'))
    expect(settingsFile(null)).toBeNull()
  })

  test('none is nothing set, and origin’s default is in force', () => {
    expect(readBaseBranch(folder)).toBeNull()
    expect(baseBranchOf(folder, MAIN)).toEqual({ set: null, origin: 'main', branch: 'main' })
  })

  test('a set branch is in force over origin’s default', () => {
    mkdirSync(join(folder, '.kehikot', 'host'), { recursive: true })
    writeFileSync(settingsFile(folder)!, JSON.stringify({ version: 1, baseBranch: 'development' }))
    expect(baseBranchOf(folder, MAIN)).toEqual({ set: 'development', origin: 'main', branch: 'development' })
  })

  test('a file that does not read, or names no branch git would take, sets nothing', () => {
    mkdirSync(join(folder, '.kehikot', 'host'), { recursive: true })
    writeFileSync(settingsFile(folder)!, '{ not json')
    expect(readBaseBranch(folder)).toBeNull()
    writeFileSync(settingsFile(folder)!, JSON.stringify({ version: 1, baseBranch: '--upload-pack=x' }))
    expect(readBaseBranch(folder)).toBeNull()
  })
})

describe('a branch name', () => {
  test('is what git takes', () => {
    for (const name of ['main', 'development', 'release/2.0', 'feat/base-branch', 'v1.2']) expect(branchNameProblem(name)).toBeNull()
  })

  test('and nothing that could reach git as an option or a pattern', () => {
    for (const name of ['', '-x', '--upload-pack=x', 'a..b', 'a b', 'a~1', 'a^', 'a:b', 'a*', 'a?', 'a[b', 'a\\b', 'x.lock', 'x/', '/x', 'x//y', '.x', 'x/.y', 'x.', 'a@{1}', '@', 'HEAD', 'x'.repeat(201)]) {
      expect(branchNameProblem(name), name).not.toBeNull()
    }
  })
})

describe('origin’s default', () => {
  test('is read once in a while, not on every ask', () => {
    let reads = 0
    const read = () => {
      reads += 1
      return 'main'
    }
    expect(originDefault(folder, read, 0)).toBe('main')
    expect(originDefault(folder, read, 10_000)).toBe('main')
    expect(reads).toBe(1)
    expect(originDefault(folder, read, 60_000)).toBe('main')
    expect(reads).toBe(2)
  })

  test('is null for a folder with no git', () => {
    expect(originDefault(folder)).toBeNull()
  })
})

describe('setting it', () => {
  test('checks origin, then writes the branch into the project’s settings', async () => {
    const { run, asked } = git({})
    const done = await setBaseBranch(folder, 'development', run, MAIN)
    expect(done).toEqual({ outcome: 'changed', said: 'The base branch is development.', base: { set: 'development', origin: 'main', branch: 'development' } })
    expect(written()).toEqual({ version: 1, baseBranch: 'development' })
    expect(asked.find((argv) => argv.includes('ls-remote'))).toEqual(['git', '-C', folder, 'ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/development'])
  })

  test('takes origin/ and refs/heads/ off what was typed', async () => {
    await setBaseBranch(folder, ' origin/development ', git({}).run, MAIN)
    expect(written().baseBranch).toBe('development')
    await setBaseBranch(folder, 'refs/heads/main', git({}).run, MAIN)
    expect(written().baseBranch).toBe('main')
  })

  test('refuses a branch origin does not have, in a sentence, and writes nothing', async () => {
    const done = await setBaseBranch(folder, 'nope', git({ lsRemote: 2 }).run, MAIN)
    expect(done).toEqual({ outcome: 'declined', why: 'origin has no branch called nope. Push it first, or name a branch origin has. The base branch was not changed.' })
    expect(existsSync(settingsFile(folder)!)).toBe(false)
  })

  test('refuses a project with no origin', async () => {
    const done = await setBaseBranch(folder, 'main', git({ remote: 2 }).run, MAIN)
    expect(done.outcome).toBe('declined')
    expect(done.outcome === 'declined' && done.why).toContain('no remote called origin')
  })

  test('with origin out of reach, takes its last fetch and says so', async () => {
    const found = await setBaseBranch(folder, 'development', git({ lsRemote: 128, revParse: 0 }).run, MAIN)
    expect(found.outcome).toBe('changed')
    expect(found.outcome === 'changed' && found.said).toContain('origin could not be reached, so this was checked against its last fetch')
    const missing = await setBaseBranch(folder, 'other', git({ lsRemote: 128, revParse: 1 }).run, MAIN)
    expect(missing).toEqual({ outcome: 'declined', why: 'origin could not be reached, and its last fetch has no branch called other. The base branch was not changed.' })
  })

  test('never hands git a name it would not take', async () => {
    const { run, asked } = git({})
    const done = await setBaseBranch(folder, '--upload-pack=touch x', run, MAIN)
    expect(done.outcome).toBe('declined')
    expect(asked).toEqual([])
  })

  test('the same branch again is no write', async () => {
    await setBaseBranch(folder, 'development', git({}).run, MAIN)
    const again = await setBaseBranch(folder, 'development', git({}).run, MAIN)
    expect(again.outcome).toBe('unchanged')
  })

  test('null goes back to origin’s default; the file goes when nothing else is in it, and other keys stay', async () => {
    await setBaseBranch(folder, 'development', git({}).run, MAIN)
    const back = await setBaseBranch(folder, null, git({}).run, MAIN)
    expect(back).toEqual({ outcome: 'changed', said: "The base branch is origin's default, main.", base: { set: null, origin: 'main', branch: 'main' } })
    expect(existsSync(settingsFile(folder)!)).toBe(false)

    writeFileSync(settingsFile(folder)!, JSON.stringify({ version: 1, later: { kept: true } }))
    await setBaseBranch(folder, 'development', git({}).run, MAIN)
    expect(written()).toEqual({ version: 1, later: { kept: true }, baseBranch: 'development' })
    await setBaseBranch(folder, null, git({}).run, MAIN)
    expect(written()).toEqual({ version: 1, later: { kept: true } })
  })

  test('leaves a file that does not read as it is', async () => {
    mkdirSync(join(folder, '.kehikot', 'host'), { recursive: true })
    writeFileSync(settingsFile(folder)!, '{ not json')
    const done = await setBaseBranch(folder, 'development', git({}).run, MAIN)
    expect(done.outcome).toBe('declined')
    expect(readFileSync(settingsFile(folder)!, 'utf8')).toBe('{ not json')
  })

  test('never writes into a folder that is gone', async () => {
    const gone = join(folder, 'gone')
    const done = await setBaseBranch(gone, 'development', git({}).run, MAIN)
    expect(done.outcome).toBe('declined')
    expect(existsSync(gone)).toBe(false)
  })
})

describe('a project carries it', () => {
  test('on the list, read off its settings', () => {
    const db: Database = open(':memory:')
    try {
      const added = addProject(db, folder)
      expect(added.ok).toBe(true)
      expect(listProjects(db).find((one) => one.path === folder)?.baseBranch).toBeNull()
      mkdirSync(join(folder, '.kehikot', 'host'), { recursive: true })
      writeFileSync(settingsFile(folder)!, JSON.stringify({ version: 1, baseBranch: 'development' }))
      expect(listProjects(db).find((one) => one.path === folder)?.baseBranch).toBe('development')
    } finally {
      db.close()
    }
  })
})

describe('the context a container is sent', () => {
  const subject = (baseBranch?: string | null, home = false): Subject => ({
    epic: null,
    project: { id: 1, name: 'P', path: '/p', epics: true, git: true, shared: false, ...(baseBranch !== undefined ? { baseBranch } : {}), ...(home ? { home } : {}) },
  })

  test('says the project’s base branch, and nothing when the host cannot say one', () => {
    expect(toWireContext(subject('development'), 'light').baseBranch).toBe('development')
    expect('baseBranch' in toWireContext(subject(null), 'light')).toBe(false)
    expect('baseBranch' in toWireContext(subject(), 'light')).toBe(false)
    expect('baseBranch' in toWireContext({ epic: null, project: null }, 'light')).toBe(false)
  })

  test('says none for the home folder nobody picked', () => {
    expect('baseBranch' in toWireContext(subject('main', true), 'light')).toBe(false)
  })

  test('survives an epic slug the schema will not take', () => {
    expect(toWireContext({ ...subject('development'), epic: 'NOT A SLUG' }, 'light').baseBranch).toBe('development')
  })

  test('reaches a pinned container in the same project', () => {
    const held = toWireContext(subject('main'), 'light')
    expect(whileFrozen(held, toWireContext(subject('main'), 'light'))).toBeNull()
    expect(whileFrozen(held, toWireContext(subject('development'), 'light'))?.baseBranch).toBe('development')
    expect('baseBranch' in (whileFrozen(held, toWireContext(subject(null), 'light')) ?? {})).toBe(false)
  })
})
