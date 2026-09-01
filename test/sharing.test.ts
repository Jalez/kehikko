import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

import { KEHIKOT_IGNORE, ignoresKehikot } from 'roadmap-module-protocol'

import { addProject, forgetProject, listProjects, named, shareKehikot } from '../server/projects.ts'
import { open as openDb } from '../server/canvases.ts'

/*
 * Whether a project's `.kehikot/` is committed with it.
 *
 * This is tested against a real directory rather than a mocked filesystem,
 * because the whole of what it does is write one file in somebody's repository
 * and every interesting case is a fact about that file: whether it already had
 * the rule, whether it existed at all, whether the folder is a repository. A
 * fake would be this test agreeing with its own idea of `readFileSync`.
 */

const root = mkdtempSync(join(tmpdir(), 'kehikko-sharing-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let made = 0
/** A folder, optionally with a git history and a `.gitignore` already in it. */
function project(git: boolean, gitignore?: string): string {
  const dir = join(root, `p${(made += 1)}`)
  mkdirSync(dir, { recursive: true })
  /* A directory rather than a real repository: `hasGit` asks whether `.git` is
     there and not whether git would agree it is a repository, which is the same
     question every module in this workspace asks and is cheap enough to ask on
     every list. */
  if (git) mkdirSync(join(dir, '.git'))
  if (gitignore !== undefined) writeFileSync(join(dir, '.gitignore'), gitignore)
  return dir
}

function db(): Database {
  return openDb(':memory:')
}

/** Add one project and hand back its row. */
function added(store: Database, dir: string) {
  const out = addProject(store, dir)
  if (!out.ok) throw new Error(out.why)
  return out.project
}

describe('whether a project keeps its .kehikot out of git', () => {
  test('a folder with no .gitignore is already sharing, and is not given one', () => {
    const store = db()
    const dir = project(true)
    const one = added(store, dir)
    /* The absence of a file is the absence of a rule. Anything else would have
       the host inventing an ignore nobody wrote in order to report one. */
    expect(one.shared).toBe(true)
    expect(existsSync(join(dir, '.gitignore'))).toBe(false)

    /* And turning ON what is already on writes nothing, so pressing a checkbox
       that is already where you pressed it does not put a file in `git status`. */
    const again = shareKehikot(store, one.id, true)
    expect(again.ok).toBe(true)
    expect(existsSync(join(dir, '.gitignore'))).toBe(false)
  })

  test('turning it off writes the rule, and turning it back on removes it', () => {
    const store = db()
    const dir = project(true, 'node_modules\ndist\n')
    const one = added(store, dir)
    expect(one.shared).toBe(true)

    const off = shareKehikot(store, one.id, false)
    expect(off.ok && off.project.shared).toBe(false)
    const withRule = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(ignoresKehikot(withRule)).toBe(true)
    expect(withRule.startsWith('node_modules\ndist\n')).toBe(true)

    const on = shareKehikot(store, one.id, true)
    expect(on.ok && on.project.shared).toBe(true)
    /* The round trip, which is the property that makes this a setting rather
       than a one-way door: what was there before is what is there after. */
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\ndist\n')
  })

  test('what the list says is what the file says, not what was stored', () => {
    const store = db()
    const dir = project(true, KEHIKOT_IGNORE)
    added(store, dir)
    expect(listProjects(store)[0]?.shared).toBe(false)

    /* Edited by hand, behind this host's back — which is the ordinary case for
       a `.gitignore` and the reason this is read on every list rather than
       stored. A column would still be saying `false` here. */
    writeFileSync(join(dir, '.gitignore'), 'dist\n')
    expect(listProjects(store)[0]?.shared).toBe(true)
  })

  test('a folder with no git history is refused, and nothing is written', () => {
    const store = db()
    const dir = project(false, 'dist\n')
    const one = added(store, dir)
    expect(one.git).toBe(false)

    const said = shareKehikot(store, one.id, false)
    expect(said.ok).toBe(false)
    if (!said.ok) expect(said.status).toBe(409)
    /* The refusal is the whole point: there is nothing to keep out of a history
       that does not exist, and a `.gitignore` left behind in a folder that is
       not a repository would do nothing and explain nothing. */
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('dist\n')
  })

  /*
   * The case the first version of `hasGit` got wrong, and the reason it walks up.
   *
   * The thesis on this machine is `…/CS-DEGREE/05_drafts/thesis_latex`: no `.git`
   * of its own, several directories inside one. A check that looked only at the
   * project folder would withhold this setting from the project whose papers
   * most need committing — while `notes` wrote a `.gitignore` into that same
   * folder anyway, because it has always walked up.
   */
  test('a project nested inside a repository has a history, and the file goes at the project', () => {
    const store = db()
    const outer = project(true)
    const inner = join(outer, 'drafts', 'thesis')
    mkdirSync(inner, { recursive: true })
    const one = added(store, inner)
    expect(one.git).toBe(true)

    const off = shareKehikot(store, one.id, false)
    expect(off.ok).toBe(true)
    /* At the project, never at the repository root: git honours a `.gitignore`
       in any directory, so the rule reaches this folder and nothing beside it. */
    expect(existsSync(join(inner, '.gitignore'))).toBe(true)
    expect(existsSync(join(outer, '.gitignore'))).toBe(false)
  })

  test('a project that is not there is a 404 rather than a thrown host', () => {
    const said = shareKehikot(db(), 4321, true)
    expect(said.ok).toBe(false)
    if (!said.ok) expect(said.status).toBe(404)
  })
})

describe('what a project is called', () => {
  test('is the name of its folder, read on every list rather than stored', () => {
    const store = db()
    const dir = project(true)
    const one = added(store, dir)
    expect(one.name).toBe(dir.split('/').at(-1)!)
    expect(named(dir)).toBe(one.name)
  })

  /* The case this replaced: a row reading "Community portal" over a folder
     called `hippos-portal`, so every sentence a module wrote about that project
     named one of the two while the person was looking at the other. A typed
     name is still accepted at the door — refusing one would break a caller over
     a field nothing depends on — and it is not what anybody is shown. */
  test('a typed name is not what the project is called', () => {
    const store = db()
    const dir = project(true)
    const out = addProject(store, dir, 'Something Else Entirely')
    if (!out.ok) throw new Error(out.why)
    expect(out.project.name).toBe(dir.split('/').at(-1)!)
    expect(listProjects(store)[0]?.name).not.toBe('Something Else Entirely')
  })
})

describe('forgetting a project', () => {
  /*
   * The ask was that deleting a project erased the `.kehikot` folder from it.
   * It does not, and the reason is that papers moved into that folder an hour
   * before: erasing it would delete a thesis from a control labelled "project".
   * Forgetting and erasing are two decisions with two different worst cases,
   * and the one that cannot be undone does not ride along with the one that can.
   */
  test('leaves every file exactly where it was, .kehikot included', () => {
    const store = db()
    const dir = project(true, 'dist\n')
    mkdirSync(join(dir, '.kehikot', 'paper', 'thesis'), { recursive: true })
    writeFileSync(join(dir, '.kehikot', 'paper', 'thesis', 'main.tex'), '\\begin{document}\\end{document}')
    const one = added(store, dir)

    const said = forgetProject(store, one.id)
    expect(said.ok).toBe(true)
    expect(listProjects(store).map((p) => p.id)).not.toContain(one.id)

    expect(existsSync(join(dir, '.kehikot', 'paper', 'thesis', 'main.tex'))).toBe(true)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('dist\n')
  })

  /* What it does delete, and why the count comes back: the arrangement of
     containers on a canvas is something somebody built by hand, so the page can
     say how many before anybody commits to it. */
  test('says how many kehikot go with it, counted before they are gone', () => {
    const store = db()
    const one = added(store, project(true))
    const said = forgetProject(store, one.id)
    expect(said.ok && said.canvases).toBe(1)
  })

  test('a project that is not there is a 404 rather than a silent success', () => {
    const said = forgetProject(db(), 9876)
    expect(said.ok).toBe(false)
    if (!said.ok) expect(said.status).toBe(404)
  })
})
