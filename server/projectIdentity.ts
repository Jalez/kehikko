import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

import { PROJECT_FILE, projectFile, readProjectFile, withProjectFileIgnored } from 'kehikot-module-protocol'

import { makeUnderRoot, projectRootExists } from './projectRoot.ts'

/**
 * A project's permanent id, and the one file this host writes at the top of a
 * project's `.kehikot/`: `.kehikot/project.json` (protocol 2.1.0).
 *
 * ## Why
 *
 * A project used to be known by its path alone, so renaming or moving its
 * folder made it a stranger. The id is kept INSIDE the folder, so it moves
 * with it, and the database keeps it beside the path (`projects.uid`). A
 * folder carrying an id this host knows is that project, wherever it is now.
 *
 * ## The rules, from the protocol
 *
 * - The host writes the file once, when it meets a project without one (or
 *   with one that does not parse), and never rewrites it — except for a COPY:
 *   two folders carrying one id, where the one met second is given a fresh id.
 * - Never committed: whenever the file is written in a git project, the
 *   project's `.gitignore` gets `withProjectFileIgnored`, append-only. It is
 *   the same file and the same scope `shareKehikot` writes (the project root,
 *   never the repository's), and only in a project under git, as there.
 * - The home folder is never written into, and a folder that refuses the
 *   write (read-only) keeps its id in the database only.
 *
 * File I/O only. What the database says is `projects.ts`'s business.
 */

/** Read the id a folder carries, or null: no file, unreadable, or not a `projectFileSchema`. */
export function readProjectId(root: string): string | null {
  const file = projectFile(root)
  if (file === null) return null
  try {
    return readProjectFile(JSON.parse(readFileSync(file, 'utf8')))?.id ?? null
  } catch {
    return null
  }
}

/** Whether a folder is the person's home folder, which this host never writes an id into. */
export function isHome(root: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(resolve(path))
    } catch {
      return resolve(path)
    }
  }
  /* Either spelling of home: `HOME`, what the person's shell calls it (and what
     a test can point elsewhere), and the account's own, which `HOME` cannot hide. */
  const at = real(root)
  return at === real(homedir()) || (!!process.env.HOME && at === real(process.env.HOME))
}

export type Written = 'written' | 'home' | 'missing' | 'refused'

/**
 * Write `{ id, createdAt }` to `<root>/.kehikot/project.json`, atomically (a
 * temporary file beside it, renamed over). `.kehikot/` is made inside a root
 * that exists; the root never is. Never throws: a folder that will not take
 * the write answers `refused`, and the id stays in the database only.
 */
export function writeProjectId(root: string, id: string, git: boolean): Written {
  if (isHome(root)) return 'home'
  if (!projectRootExists(root)) return 'missing'
  const file = projectFile(root)
  if (file === null) return 'refused'
  const beside = `${file}.${process.pid}.tmp`
  try {
    if (!makeUnderRoot(root, dirname(file))) return 'missing'
    writeFileSync(beside, `${JSON.stringify({ id, createdAt: new Date().toISOString() }, null, 2)}\n`)
    renameSync(beside, file)
  } catch {
    try {
      unlinkSync(beside)
    } catch {
      /* Never made. */
    }
    return 'refused'
  }
  if (git) keepOutOfGit(root)
  return 'written'
}

/**
 * The project's `.gitignore`, given the rule that keeps `project.json` out of
 * git, when it lacks it. Append-only, written only when it changes; a missing
 * `.gitignore` is made, because no rule at all would let the id be committed.
 * A `.gitignore` that will not take the write is left; the id is still the id.
 */
function keepOutOfGit(root: string): void {
  const file = resolve(root, '.gitignore')
  let before = ''
  try {
    before = readFileSync(file, 'utf8')
  } catch {
    /* None yet. */
  }
  const after = withProjectFileIgnored(before)
  if (after === before) return
  try {
    writeFileSync(file, after, 'utf8')
  } catch {
    /* Read-only, or not ours to write after all. */
  }
}

/** Whether git tracks `.kehikot/project.json` in this folder — a copy made before the rule existed. */
export function projectFileTracked(root: string): boolean {
  try {
    const run = Bun.spawnSync(['git', '-C', root, 'ls-files', '--error-unmatch', `.kehikot/${PROJECT_FILE}`], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return run.exitCode === 0
  } catch {
    return false
  }
}

let log: (line: string) => void = (line) => console.warn(line)

/** Where this file's lines go. Tests pass a collector; the server leaves the default. */
export function setIdentityLog(next: (line: string) => void): void {
  log = next
}

const said = new Set<string>()

/** One line, once per start for the same words. */
export function sayIdentity(line: string): void {
  if (said.has(line)) return
  said.add(line)
  log(line)
}
