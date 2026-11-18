import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { folderSize, inspect, runGit, trashUnused, type UnusedDeps } from '../server/unusedFolders.ts'
import { sizeSaid, trashedSaid, verdictSaid } from '../src/host/unusedFolders.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { stdio: 'pipe' })

/** A checkout pushed to a bare "remote": clean, or with the change a test asks for. */
function checkout(root: string, name: string, mess: 'clean' | 'uncommitted' | 'unpushed' = 'clean'): string {
  const remote = join(root, `${name}.git`)
  const dir = join(root, name)
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  writeFileSync(join(dir, 'a.txt'), 'a')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'one')
  git(dir, 'remote', 'add', 'origin', remote)
  git(dir, 'push', '-q', 'origin', 'main')
  if (mess === 'uncommitted') writeFileSync(join(dir, 'b.txt'), 'draft')
  if (mess === 'unpushed') {
    writeFileSync(join(dir, 'b.txt'), 'b')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'two')
  }
  return dir
}

function world(candidates: string[], used: Record<string, string> = {}) {
  const trashed: string[] = []
  const deps: UnusedDeps = {
    candidates: async () => candidates,
    usedBy: async (dir) => used[dir] ?? null,
    git: runGit,
    size: folderSize,
    trash: async (dir) => {
      trashed.push(dir)
      return { ok: true }
    },
  }
  return { deps, trashed }
}

describe('unused folders', () => {
  const root = () => realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-unused-')))

  test('a clean checkout is offered; one with uncommitted changes or unpushed commits is kept, with the reason', async () => {
    const r = root()
    const clean = checkout(r, 'clean')
    const dirty = checkout(r, 'dirty', 'uncommitted')
    const ahead = checkout(r, 'ahead', 'unpushed')
    const { deps, trashed } = world([clean, dirty, ahead])
    const listed = await inspect(deps)
    expect(listed.map((one) => [one.dir, one.trash, one.why])).toEqual([
      [clean, true, null],
      [dirty, false, 'has uncommitted changes'],
      [ahead, false, 'has commits that are not pushed'],
    ])
    expect(listed.every((one) => one.bytes > 0)).toBe(true)
    /* Even when everything is asked for, only what passes goes. */
    const done = await trashUnused([clean, dirty, ahead], deps)
    expect(trashed).toEqual([clean])
    expect(done.done.moved.map((one) => one.dir)).toEqual([clean])
    expect(done.done.kept.map((one) => one.dir)).toEqual([dirty, ahead])
    expect(existsSync(dirty) && existsSync(ahead)).toBe(true)
  })

  test('a folder a registration or a module still uses is never moved, and a path that was not listed is refused', async () => {
    const r = root()
    const used = checkout(r, 'used')
    const other = checkout(r, 'other')
    const { deps, trashed } = world([used], { [used]: 'Flows' })
    const listed = await inspect(deps)
    expect(listed[0]).toMatchObject({ trash: false, why: 'still used by Flows' })
    const done = await trashUnused([used, other], deps)
    expect(trashed).toEqual([])
    expect(done.done.kept).toEqual([
      { dir: used, why: 'still used by Flows' },
      { dir: other, why: 'Kehikot does not list it as unused' },
    ])
  })

  test('the worktrees folder beside a checkout goes only when every worktree in it passes', async () => {
    const r = root()
    const a = checkout(r, 'kehikko-a')
    const b = checkout(r, 'kehikko-b')
    const clean = checkout(join(r, 'kehikko-a-worktrees'), 'one')
    mkdirSync(join(r, 'kehikko-b-worktrees'), { recursive: true })
    const messy = checkout(join(r, 'kehikko-b-worktrees'), 'two', 'uncommitted')
    const { deps, trashed } = world([a, b])
    const listed = await inspect(deps)
    expect(listed.map((one) => [one.dir, one.trash, one.worktrees])).toEqual([
      [a, true, false],
      [`${a}-worktrees`, true, true],
      [b, true, false],
      [`${b}-worktrees`, false, true],
    ])
    expect(listed[3]!.why).toBe('two has uncommitted changes')
    await trashUnused(listed.filter((one) => one.trash).map((one) => one.dir), deps)
    expect(trashed.sort()).toEqual([a, `${a}-worktrees`, b].sort())
    expect(existsSync(clean) && existsSync(messy)).toBe(true)
  })

  test('a dry listing matches what is moved, and the words say it', async () => {
    const r = root()
    const a = checkout(r, 'a')
    const b = checkout(r, 'b', 'uncommitted')
    const { deps } = world([a, b])
    const listed = await inspect(deps)
    const wouldGo = listed.filter((one) => one.trash).map((one) => one.dir)
    const done = await trashUnused(listed.map((one) => one.dir), deps)
    expect(done.done.moved.map((one) => one.dir)).toEqual(wouldGo)
    expect(verdictSaid(listed[0]!)).toBe('will go to the Trash')
    expect(verdictSaid(listed[1]!)).toBe('kept: has uncommitted changes')
    expect(trashedSaid(done.done, r)).toMatch(/^1 folder moved to the Trash, \d+ KB; 1 kept: ~\/b \(has uncommitted changes\)\.$/)
    expect(sizeSaid(3.1e9)).toBe('3.1 GB')
  })
})

test('no tool of the agents’ door can move a folder to the Trash', async () => {
  const mcp = await Bun.file(join(import.meta.dir, '..', 'server', 'mcp.ts')).text()
  expect(mcp).not.toMatch(/unused-folders|moveToTrash|unusedFolders/)
})
