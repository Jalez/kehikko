import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { browse, rootsFor } from '../server/folders.ts'

/**
 * The one endpoint on this host that enumerates somebody's disk.
 *
 * A browser cannot hand a page a real path — `showDirectoryPicker` returns an
 * opaque handle — and a path is exactly what a module needs, so the server
 * lists and the page draws. That makes this the most dangerous thing here, and
 * most of what is below is about what it refuses rather than what it returns.
 */

let scratch: string
let roots: string[]
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-folders-')))
  mkdirSync(join(scratch, 'Projects', 'roadmap', 'data', 'epics'), { recursive: true })
  mkdirSync(join(scratch, 'Projects', 'roadmap', '.git'), { recursive: true })
  mkdirSync(join(scratch, 'Projects', 'plain'), { recursive: true })
  mkdirSync(join(scratch, 'Projects', 'worktree'), { recursive: true })
  writeFileSync(join(scratch, 'Projects', 'worktree', '.git'), 'gitdir: /elsewhere\n')
  mkdirSync(join(scratch, 'Projects', '.hidden'), { recursive: true })
  writeFileSync(join(scratch, 'Projects', 'notes.txt'), 'hello')
  /* The sibling whose name starts the same way, which is the classic hole in a
     prefix check that forgot the separator. */
  mkdirSync(join(scratch, 'Projects-old'), { recursive: true })
  roots = [join(scratch, 'Projects')]
})
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('what it lists', () => {
  test('folders, by name, with what can be said about each of them', () => {
    const browsed = browse(join(scratch, 'Projects'), roots)
    expect(browsed.ok).toBe(true)
    if (!browsed.ok) return

    const names = browsed.listing.entries.map((entry) => entry.name)
    /* Folders only. `notes.txt` is a file and is not a place to go. */
    expect(names).toEqual(['plain', 'roadmap', 'worktree'])

    const roadmap = browsed.listing.entries.find((entry) => entry.name === 'roadmap')!
    expect(roadmap.git).toBe(true)
    expect(roadmap.worktree).toBe(false)
    /* The fact that decides what a kehikko there can do, shown before the
       project is added rather than discovered after. */
    expect(roadmap.epics).toBe(true)

    /* `.git` as a FILE is a worktree or a submodule. Both are folders you may
       open, which is why "pick the worktree" needs no concept of its own. */
    const worktree = browsed.listing.entries.find((entry) => entry.name === 'worktree')!
    expect(worktree.worktree).toBe(true)
    expect(worktree.git).toBe(false)

    const plain = browsed.listing.entries.find((entry) => entry.name === 'plain')!
    expect(plain.git).toBe(false)
    expect(plain.epics).toBe(false)
  })

  test('hidden folders are not listed', () => {
    const browsed = browse(join(scratch, 'Projects'), roots)
    expect(browsed.ok).toBe(true)
    if (!browsed.ok) return
    expect(browsed.listing.entries.map((entry) => entry.name)).not.toContain('.hidden')
  })

  test('nothing is read out of a file, only names off a directory', () => {
    const browsed = browse(join(scratch, 'Projects'), roots)
    expect(browsed.ok).toBe(true)
    if (!browsed.ok) return
    /* Every field on an entry is a name or a boolean. There is nowhere for the
       contents of anything to travel. */
    for (const entry of browsed.listing.entries) {
      expect(Object.keys(entry).sort()).toEqual(['epics', 'git', 'name', 'path', 'worktree'])
    }
  })

  test('with nothing asked for, it starts at the first root', () => {
    const browsed = browse(null, roots)
    expect(browsed.ok).toBe(true)
    if (!browsed.ok) return
    expect(browsed.listing.path).toBe(join(scratch, 'Projects'))
  })

  test('"up" stops at the roots rather than offering a step that would be refused', () => {
    const top = browse(join(scratch, 'Projects'), roots)
    expect(top.ok).toBe(true)
    if (top.ok) expect(top.listing.parent).toBeNull()

    const inside = browse(join(scratch, 'Projects', 'roadmap'), roots)
    expect(inside.ok).toBe(true)
    if (inside.ok) expect(inside.listing.parent).toBe(join(scratch, 'Projects'))
  })
})

describe('what it refuses', () => {
  test('anything outside the roots, including a sibling whose name starts the same way', () => {
    for (const outside of ['/etc', join(scratch, 'Projects-old')]) {
      const browsed = browse(outside, roots)
      expect(browsed.ok).toBe(false)
      if (browsed.ok) continue
      expect(browsed.status).toBe(403)
    }
  })

  test('a path that walks up out of the roots, however it is spelled', () => {
    /* `resolve` flattens the dots before anything else looks at the string, and
       the containment check then runs on the resolved path — so this is the
       same refusal as naming `/etc` outright rather than a separate rule. */
    const browsed = browse(join(scratch, 'Projects', '..', 'Projects-old'), roots)
    expect(browsed.ok).toBe(false)
    if (!browsed.ok) expect(browsed.status).toBe(403)
    /* And one that walks up past anything this host has heard of, which lands
       on whichever refusal comes first — outside, or not there at all. Both are
       a no, which is the property being asserted. */
    expect(browse(join(scratch, 'Projects', '..', '..', '..', '..', 'etc'), roots).ok).toBe(false)
  })

  test('a symlink that leaves the roots, because the check runs after the resolving', () => {
    /* The classic hole: `Projects/out` IS inside `Projects` by string
       comparison. It is a link to somewhere else, and a check that ran on the
       string would have approved it. `realpath` first, contain second. */
    const elsewhere = join(scratch, 'Elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    symlinkSync(elsewhere, join(scratch, 'Projects', 'out'))

    const browsed = browse(join(scratch, 'Projects', 'out'), roots)
    expect(browsed.ok).toBe(false)
    if (!browsed.ok) expect(browsed.status).toBe(403)
  })

  test('a symlink is never offered as a folder to walk into', () => {
    const elsewhere = join(scratch, 'Elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    symlinkSync(elsewhere, join(scratch, 'Projects', 'out'))

    const browsed = browse(join(scratch, 'Projects'), roots)
    expect(browsed.ok).toBe(true)
    if (!browsed.ok) return
    /* Classified with `lstat`, so it is not a directory as far as this is
       concerned, and there is no step for a person to take that they had no way
       to see the consequence of. */
    expect(browsed.listing.entries.map((entry) => entry.name)).not.toContain('out')
  })

  test('a file is not a folder', () => {
    const browsed = browse(join(scratch, 'Projects', 'notes.txt'), roots)
    expect(browsed.ok).toBe(false)
    if (!browsed.ok) expect(browsed.status).toBe(400)
  })

  test('a path that is not there', () => {
    const browsed = browse(join(scratch, 'Projects', 'nowhere'), roots)
    expect(browsed.ok).toBe(false)
    if (!browsed.ok) expect(browsed.status).toBe(404)
  })

  test('a relative path, which would resolve against a directory nobody chose', () => {
    const browsed = browse('Projects/roadmap', roots)
    expect(browsed.ok).toBe(false)
    if (!browsed.ok) expect(browsed.status).toBe(400)
  })

  test('a path with a NUL in it, or one longer than any filesystem hands out', () => {
    expect(browse(`${join(scratch, 'Projects')}\0/etc`, roots).ok).toBe(false)
    expect(browse(`/${'a'.repeat(5000)}`, roots).ok).toBe(false)
  })

  test('with no roots at all it lists nothing rather than falling back to /', () => {
    const browsed = browse(join(scratch, 'Projects'), [])
    expect(browsed.ok).toBe(false)
    if (!browsed.ok) expect(browsed.status).toBe(409)
  })
})

describe('the roots', () => {
  test('are home plus the folders already opened as projects, resolved', () => {
    const found = rootsFor([join(scratch, 'Projects', 'roadmap')])
    expect(found).toContain(join(scratch, 'Projects', 'roadmap'))
    /* Home is always one of them, because that is where a person's own work is
       and it is the only default this host can pick without guessing. */
    expect(found.length).toBeGreaterThan(1)
  })

  test('a project folder that has been moved or unmounted stops being a root', () => {
    /* It stops being browsable, which is correct — there is nothing there — and
       the project row stays, so the person can see what broke. */
    const found = rootsFor([join(scratch, 'gone')])
    expect(found).not.toContain(join(scratch, 'gone'))
  })
})
