import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { spawnRunner } from '../server/feedback.ts'
import { projectFileTracked } from '../server/projectIdentity.ts'
import { QUIET_ENV } from '../server/quietEnv.ts'
import { inspect, runGit, type UnusedDeps } from '../server/unusedFolders.ts'
import { readCheckout } from '../server/updates.ts'
import { run } from '../server/versions.ts'

/*
 * The host reads people's own repositories (a module's checkout, a folder it no longer uses, a
 * project) and must never write to them. `git status` and its kin refresh the index's stat cache as
 * a side effect and WRITE `.git/index`, taking `index.lock` while they do, unless optional locks are
 * off. A host doing that races the person's own git (their commit fails on the lock) and changes
 * their repository behind their back; the development drive caught it as a changed `.git/index`.
 *
 * So every git the host runs gets `GIT_OPTIONAL_LOCKS=0` (in `QUIET_ENV`). Writes the host means
 * (a fetch, a checkout, a pull into a copy it owns) take their locks as before: the variable only
 * drops the optional ones.
 */

const root = mkdtempSync(join(tmpdir(), 'kehikko-git-reads-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { stdio: 'pipe' })

let made = 0
/** A repository whose index `git status` would rewrite: a committed file with a new time but the same bytes, and work not committed. */
function staleIndex(): string {
  const dir = join(root, `repo-${made++}`)
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  writeFileSync(join(dir, 'serve.ts'), 'export {}\n')
  writeFileSync(join(dir, 'package.json'), '{}\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'first')
  /* Same bytes, a later time: the index's stat cache no longer matches, which a refresh would write. */
  const later = new Date(Date.now() + 60_000)
  utimesSync(join(dir, 'serve.ts'), later, later)
  utimesSync(join(dir, 'package.json'), later, later)
  writeFileSync(join(dir, 'unsaved-work.ts'), 'export const draft = 1\n')
  return dir
}

function indexOf(dir: string): string {
  const path = join(dir, '.git', 'index')
  return `${statSync(path).mtimeMs}:${readFileSync(path).toString('base64')}`
}

const env: Record<string, string | undefined> = { ...process.env }
delete env.GIT_OPTIONAL_LOCKS

describe('a repository the host only reads', () => {
  test('the repository used here is one plain `git status` does rewrite (so the checks below mean something)', () => {
    const dir = staleIndex()
    const before = indexOf(dir)
    execFileSync('git', ['-C', dir, 'status', '--porcelain'], { stdio: 'pipe', env })
    expect(indexOf(dir)).not.toBe(before)
  })

  test('reading a checkout for updates leaves its index exactly as it was', async () => {
    const dir = staleIndex()
    const before = indexOf(dir)
    const read = await readCheckout({ id: 'kehikot.sample', name: 'Sample', dir }, false)
    expect('error' in read ? read.error : null).toBeNull()
    expect(indexOf(dir)).toBe(before)
    expect(readdirSync(join(dir, '.git')).includes('index.lock')).toBe(false)
  })

  test('checking an unused folder for work not committed leaves its index exactly as it was', async () => {
    const dir = staleIndex()
    git(dir, 'add', 'unsaved-work.ts')
    const before = indexOf(dir)
    const deps: UnusedDeps = {
      candidates: async () => [dir],
      usedBy: async () => null,
      git: runGit,
      size: async () => 0,
      trash: async () => ({ ok: true }),
    }
    const [listed] = await inspect(deps)
    expect(listed?.why).toBe('has uncommitted changes')
    expect(indexOf(dir)).toBe(before)
  })

  test('asking whether a project tracks its project file leaves its index exactly as it was', () => {
    const dir = staleIndex()
    const before = indexOf(dir)
    expect(projectFileTracked(dir)).toBe(false)
    expect(indexOf(dir)).toBe(before)
  })
})

describe('every git the host runs has optional locks off', () => {
  const said = ['-c', 'alias.locks=!printf %s "$GIT_OPTIONAL_LOCKS"', 'locks']

  test('the quiet environment says so', () => {
    expect(QUIET_ENV.GIT_OPTIONAL_LOCKS).toBe('0')
  })

  test('the shared runner, the gh runner and the unused-folders runner each give git GIT_OPTIONAL_LOCKS=0', async () => {
    const dir = staleIndex()
    const quiet = await run(['git', '-C', dir, ...said])
    expect(quiet).toEqual({ ok: true, out: '0' })
    const viaGh = await spawnRunner(['git', '-C', dir, ...said])
    expect(viaGh.out).toBe('0')
    expect(await runGit(dir, said)).toBe('0')
  })

  test('a caller that adds its own environment to the shared runner keeps it', async () => {
    const dir = staleIndex()
    expect(await run(['git', '-C', dir, ...said], { env: { NO_COLOR: '1' } })).toEqual({ ok: true, out: '0' })
  })

  /* A new git spawned straight from the host must be given the quiet environment too: the call names it. */
  test("every `'git'` the host spawns directly is given QUIET_ENV", () => {
    const serverDir = join(import.meta.dir, '..', 'server')
    const files = (readdirSync(serverDir, { recursive: true }) as string[]).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    const spawn = /\b(?:Bun\.spawnSync|Bun\.spawn|execFileSync|execFile|spawnSync|spawn)\(\s*\[?\s*'git'/g
    const bare: string[] = []
    let found = 0
    for (const name of files) {
      const text = readFileSync(join(serverDir, name), 'utf8')
      for (const match of text.matchAll(spawn)) {
        found += 1
        /* The whole call: from its opening parenthesis to the one that closes it. */
        let depth = 0
        let end = match.index
        for (; end < text.length; end++) {
          if (text[end] === '(') depth += 1
          else if (text[end] === ')' && --depth === 0) break
        }
        const call = text.slice(match.index, end + 1)
        if (!/\bQUIET_ENV\b/.test(call)) bare.push(`${name}:${text.slice(0, match.index).split('\n').length}`)
      }
    }
    expect(found).toBeGreaterThan(3)
    expect(bare).toEqual([])
  })
})
