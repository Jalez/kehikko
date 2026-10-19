import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

import { BranchMark } from '../src/canvas/Branch.tsx'
import { TooltipProvider } from '../src/components/ui/tooltip.tsx'
import { offMain, sourceHint, type Source } from '../src/host/source.ts'
import { sourceOf } from '../server/source.ts'

/** Which branch a module runs from, and when the header marks it. */

const plain: Source = { dir: '/x/installed/kehikot.notes', registered: true, branch: 'main', upstream: 'origin/main', behind: 0, ahead: 0, dirty: false }

describe('when a branch is worth a person’s attention', () => {
  test('main, level, clean, in the registered folder is the plain case', () => {
    expect(offMain(plain)).toEqual([])
    expect(sourceHint(plain)).toBe('Running from /x/installed/kehikot.notes, on main, level with origin/main.')
  })

  test('each way of not running what was merged is said', () => {
    expect(offMain({ ...plain, branch: 'fix-x' })).toEqual(['on fix-x, not main'])
    expect(offMain({ ...plain, branch: null })).toEqual(['on no branch (detached)'])
    expect(offMain({ ...plain, behind: 3 })).toEqual(['3 commits behind origin/main'])
    expect(offMain({ ...plain, ahead: 1 })).toEqual(['1 commit not on origin/main'])
    expect(offMain({ ...plain, dirty: true })).toEqual(['uncommitted changes'])
    expect(offMain({ ...plain, registered: false })).toEqual(['not the folder the app runs it from'])
    expect(sourceHint({ ...plain, dir: '/x/Projects/kehikko-notes', registered: false, behind: 1 })).toBe(
      'Running from /x/Projects/kehikko-notes — 1 commit behind origin/main; not the folder the app runs it from.',
    )
  })
})

describe('the mark in the header', () => {
  const draw = (source: Source | null) => renderToStaticMarkup(<TooltipProvider><BranchMark source={source} /></TooltipProvider>)

  test('quiet on main, and gone with the version when the container is narrow', () => {
    const html = draw(plain)
    expect(html).toContain('data-off-main="false"')
    expect(html).toContain('>main<')
    expect(html).toContain('@max-[300px]/container:hidden')
  })

  test('marked anywhere else, at every width, with the reason as its label', () => {
    const html = draw({ ...plain, branch: 'fix-x' })
    expect(html).toContain('data-off-main="true"')
    expect(html).toContain('fix-x')
    expect(html).not.toContain('@max-[300px]/container:hidden')
    expect(html).toContain('on fix-x, not main')
  })

  test('nothing when the host could not read it', () => {
    expect(draw(null)).toBe('')
  })
})

describe('reading where a module runs from', () => {
  const made: string[] = []
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  /** A clone of a one-commit repository, on main and tracking origin/main. */
  function clone(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikot-source-')))
    made.push(root)
    const origin = join(root, 'origin')
    execFileSync('git', ['init', '-q', '-b', 'main', origin])
    git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one')
    const copy = join(root, 'copy')
    execFileSync('git', ['clone', '-q', origin, copy])
    return copy
  }
  const nothing = { listenerOf: async () => null, cwdOf: async () => null }

  test('a module that is not answering is read in its registered folder', async () => {
    const dir = clone()
    const source = await sourceOf('kehikot.a', 'http://127.0.0.1:7001', dir, false, nothing)
    expect(source).toMatchObject({ dir, registered: true, branch: 'main', upstream: 'origin/main', behind: 0, dirty: false })
  })

  test('one that answers is read where its process runs, and said not to be the registered folder', async () => {
    const registered = clone()
    const elsewhere = clone()
    git(elsewhere, 'checkout', '-q', '-b', 'fix-x')
    writeFileSync(join(elsewhere, 'x.txt'), 'x')
    git(elsewhere, 'add', 'x.txt')
    const processes = { listenerOf: async () => 4242, cwdOf: async () => elsewhere }
    const source = await sourceOf('kehikot.b', 'http://127.0.0.1:7002', registered, true, processes)
    expect(source).toMatchObject({ dir: elsewhere, registered: false, branch: 'fix-x', dirty: true })
    expect(offMain(source!)).toContain('not the folder the app runs it from')
  })

  test('a process running from inside its registered folder is the registered folder', async () => {
    const dir = clone()
    const processes = { listenerOf: async () => 4242, cwdOf: async () => dir }
    expect(await sourceOf('kehikot.c', 'http://127.0.0.1:7003', dir, true, processes)).toMatchObject({ dir, registered: true })
  })

  test('kept for a while: a sweep every few seconds does not re-read it', async () => {
    const dir = clone()
    let asked = 0
    const counting = { listenerOf: async () => (asked += 1, 4242), cwdOf: async () => dir }
    await sourceOf('kehikot.d', 'http://127.0.0.1:7004', dir, true, counting, 1_000)
    await sourceOf('kehikot.d', 'http://127.0.0.1:7004', dir, true, counting, 2_000)
    expect(asked).toBe(1)
    await sourceOf('kehikot.d', 'http://127.0.0.1:7004', dir, true, counting, 40_000)
    expect(asked).toBe(2)
  })
})
