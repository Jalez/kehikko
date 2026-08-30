import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { LIMITS } from 'roadmap-module-protocol'

import { within } from './projects.ts'

/**
 * Walking the disk to pick a project, and why the server has to be the one
 * doing it.
 *
 * ## A browser cannot hand a page a path
 *
 * The obvious build is a file input or the File System Access API, and neither
 * can work here. `showDirectoryPicker()` returns an opaque `FileSystemHandle`:
 * the page can read files THROUGH it and can never learn where it points. What
 * this host needs is the string `/Users/somebody/Projects/roadmap`, because
 * that string is what goes into `roadmap.context.projectPath` and what every
 * module joins its own subdirectory onto. A handle is unusable for that, and no
 * amount of asking the browser more politely produces the path.
 *
 * So the server lists directories and the page draws the dialog. That is not a
 * workaround; it is the only arrangement in which a page in a browser can end
 * up holding a real path, and it is what every editor with a "open folder"
 * dialog and a local backend does.
 *
 * ## Which makes this the most dangerous endpoint on the host
 *
 * It enumerates directories on somebody's machine on request. Four rules, and
 * each one is a specific failure rather than hygiene:
 *
 *  1. **Only directories, and it must BE one.** A path that is a file is
 *     refused rather than read. Nothing here ever opens a file, and the answer
 *     carries names, never contents — this is a read of the shape of a disk,
 *     not of anything on it.
 *
 *  2. **Resolved, then contained.** The asked-for path is put through
 *     `realpath` FIRST and the containment check runs on the result. Checking
 *     before resolving is the classic hole: `~/Projects/link` is inside home by
 *     string comparison and may be a symlink to `/etc`, and a check that ran on
 *     the string would have approved it.
 *
 *  3. **Symlinks are not followed out.** Entries are classified with `lstat`,
 *     so a symlink is never reported as a directory and never becomes a step a
 *     person can take. Somebody who genuinely wants the folder behind one can
 *     type its real path, which goes through rule 2 like everything else.
 *
 *  4. **Confined to roots the person is already standing in.** Home, plus every
 *     folder that is already a project. Not `/`. A project outside home — a
 *     repository on another volume — is reachable because it is a root of its
 *     own once it has been added, and adding it is a separate, deliberate act.
 *
 * ## What it says about a folder
 *
 * Three facts, all cheap and all the ones a person needs to recognise a folder
 * they meant: whether it is a git repository, whether it is a git worktree, and
 * whether it holds `data/epics`. The last is the one that changes what a
 * kehikko there can do, and showing it in the picker means nobody adds a
 * project and then wonders why the epic list is empty.
 */

export interface Entry {
  name: string
  path: string
  /** `.git` is a directory: an ordinary repository. */
  git: boolean
  /** `.git` is a FILE: a worktree, or a submodule. Both are folders you may open. */
  worktree: boolean
  /** `data/epics` is under it, so a kehikko here would have epics to pick. */
  epics: boolean
}

export interface Listing {
  path: string
  /** One step up, or null at a root — so the dialog knows whether to draw "up". */
  parent: string | null
  /** Whether this folder is itself addable: it always is, and the page says so. */
  entries: Entry[]
  /** Names beyond `MOST` were not listed. Said out loud rather than silently clipped. */
  more: number
}

export type Browsed = { ok: true; listing: Listing } | { ok: false; why: string; status: number }

/**
 * As many folders as anybody scans in one pass.
 *
 * A directory with four thousand entries in it exists — `node_modules` is one —
 * and a dialog listing all of them is a dialog nobody scrolls. The count of
 * what was left out travels with the answer, because a list that quietly ends
 * is a list somebody will believe is the whole of it.
 */
const MOST = 500

/** Where a person may browse: home, plus every folder already opened as a project. */
export function rootsFor(projectPaths: readonly string[]): string[] {
  const roots: string[] = []
  for (const candidate of [homedir(), ...projectPaths]) {
    try {
      roots.push(realpathSync(candidate))
    } catch {
      /* A project folder that has been moved or unmounted since it was added.
         It stops being a root, which is correct — there is nothing there to
         browse — and the project row stays, so the person can see what broke. */
    }
  }
  return roots
}

/**
 * List the directories inside one folder.
 *
 * `asked` is whatever arrived on the query string, including null. Null means
 * "start somewhere sensible", which is home — the place a person's own work is,
 * and the only default this host can pick without guessing at somebody's
 * filing.
 */
export function browse(asked: string | null, roots: readonly string[]): Browsed {
  if (!roots.length) {
    return { ok: false, why: 'This host has nowhere it is willing to browse.', status: 409 }
  }

  const wanted = asked === null || asked === '' ? roots[0]! : asked

  if (typeof wanted !== 'string' || wanted.length > LIMITS.PATH || wanted.includes('\0')) {
    return { ok: false, why: 'That is not a path.', status: 400 }
  }
  if (!isAbsolute(wanted)) {
    /* Relative would be resolved against wherever this server was started,
       which is a directory nobody chose and one the page has never seen. */
    return { ok: false, why: 'A folder is browsed by its absolute path.', status: 400 }
  }

  let real: string
  try {
    real = realpathSync(resolve(wanted))
  } catch {
    return { ok: false, why: 'There is no folder at that path.', status: 404 }
  }

  /* Resolved first, contained second. See rule 2 above: the other order is the
     hole, not a style preference. */
  if (!within(real, roots)) {
    return {
      ok: false,
      why: 'That folder is outside the places this host will list. Browsing starts at your home folder and at the projects you have already opened.',
      status: 403,
    }
  }

  try {
    if (!statSync(real).isDirectory()) {
      return { ok: false, why: 'That is a file. This lists folders.', status: 400 }
    }
  } catch {
    return { ok: false, why: 'There is no folder at that path.', status: 404 }
  }

  let names: string[]
  try {
    names = readdirSync(real)
  } catch {
    /* Permission, most often. A refusal rather than an empty list: "you may not
       look in here" and "there is nothing in here" send a person to two
       different places. */
    return { ok: false, why: 'That folder could not be read.', status: 403 }
  }

  const folders: Entry[] = []
  let skipped = 0
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    /* Hidden folders are not listed. `.git`, `.cache`, `.Trash` and nine
       hundred others are not projects, and the one thing in a dotfile anybody
       would want to open they can reach by typing the path. */
    if (name.startsWith('.')) continue
    const path = join(real, name)
    let kind
    try {
      /* `lstat`, not `stat`. A symlink to a directory is a symlink, and
         reporting it as a folder is how a walk leaves the roots by a step the
         person had no way to see. */
      kind = lstatSync(path)
    } catch {
      continue
    }
    if (!kind.isDirectory()) continue
    if (folders.length >= MOST) {
      skipped += 1
      continue
    }
    folders.push({ name, path, ...marksOf(path) })
  }

  const up = dirname(real)
  return {
    ok: true,
    listing: {
      path: real,
      /* Null at a root, and at `/`, where `dirname` answers with itself. A
         dialog that offered "up" out of the roots would offer a step that is
         then refused, which is a control that exists to say no. */
      parent: up !== real && within(up, roots) ? up : null,
      entries: folders,
      more: skipped,
    },
  }
}

/**
 * What can be said about a folder without opening anything inside it.
 *
 * `.git` as a directory is a repository; `.git` as a FILE is a worktree or a
 * submodule, which is the distinction that makes "pick the worktree" need no
 * concept of its own here — both are folders, and the person can see which is
 * which. Every one of these is a `stat` on a path built from a name the
 * filesystem itself just handed over.
 */
function marksOf(path: string): { git: boolean; worktree: boolean; epics: boolean } {
  let git = false
  let worktree = false
  try {
    const dot = lstatSync(join(path, '.git'))
    git = dot.isDirectory()
    worktree = dot.isFile()
  } catch {
    /* No `.git`. An ordinary folder, which is a perfectly good project. */
  }
  let epics = false
  try {
    epics = statSync(join(path, 'data', 'epics')).isDirectory()
  } catch {
    /* No epics here. Not an error — see `addProject`. */
  }
  return { git, worktree, epics }
}
