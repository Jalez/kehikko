import type { Database } from 'bun:sqlite'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { LIMITS } from 'kehikot-module-protocol'

import { ensureCanvases, listCanvases, type Canvas } from '../canvases.ts'
import { lookingAt, type Looking } from '../doorPlaces.ts'
import { addProject, listProjects, projectAt, type Project } from '../projects.ts'
import { kehikkoIn } from './bounds.ts'
import type { Door, Placed } from './door.ts'
import { missingSaid, PROJECT_HINT, roster, same, trimmedPath } from './words.ts'

/**
 * Where a call is: which project an argument names, which kehikko a call is about — decided once
 * for every tool that names one — and what the person has on screen.
 */

/**
 * The project an argument names: its id, its folder, or its exact name (one project only), as `jump` resolves
 * them — never a prefix or a guess.
 *
 * A folder this host does not know yet, holding its own `.git` or `.kehikot`, is ADDED as a project, the way
 * "Add a project" adds one (`addProject`, with its first kehikko), and the answer says so: an agent asked to work
 * in a project that is on the disk should not have to ask the person to open it first, and must not write its
 * files by hand instead. Anything else is refused in words. A git worktree (`.git` is a file) is not added: it
 * is a checkout of a project, and a second project for it would split that project's spaces in two.
 */
export function projectIn(db: Database, value: unknown): { ok: true; project: Project; added: string | null } | { ok: false; why: string } {
  if (typeof value !== 'string' || !value.trim() || value.length > LIMITS.PATH) {
    return { ok: false, why: `project, when given, is a project’s folder (an absolute path), its name or its id, as read_canvas and my_place print them. Nothing was read or changed.` }
  }
  const asked = value.trim()
  const projects = listProjects(db)
  const named = projects.filter((one) => same(one.name, asked))
  const known =
    projects.find((one) => one.uid === asked)
    ?? projects.find((one) => trimmedPath(one.path) === trimmedPath(asked))
    ?? (isAbsolute(asked) ? (() => { const at = projectAt(db, asked); return at ? projects.find((one) => one.path === at.path) : undefined })() : undefined)
    ?? (named.length === 1 ? named[0] : undefined)
  if (known) return { ok: true, project: known, added: null }
  const listed = `This host’s projects: ${projects.length ? projects.map((one) => `${one.name} (${one.path})`).join(', ') : 'none'}.`
  if (named.length > 1) return { ok: false, why: `More than one project is called ${asked}; name it by its folder. ${listed} Nothing was read or changed.` }
  if (!isAbsolute(asked)) return { ok: false, why: `This host has no project ${asked}. ${listed} A project it does not know yet is named by its folder, an absolute path. Nothing was read or changed.` }
  const isDir = (path: string): boolean => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }
  if (!isDir(asked)) return { ok: false, why: `There is no folder at ${asked}, and it is not a project this host knows. ${listed} Nothing was read or changed.` }
  const git = `${trimmedPath(asked)}/.git`
  if (existsSync(git) && !isDir(git)) {
    return { ok: false, why: `${asked} is a git worktree or submodule, not a project: name the project it is a checkout of. ${listed} Nothing was read or changed.` }
  }
  if (!isDir(git) && !isDir(`${trimmedPath(asked)}/.kehikot`)) {
    return { ok: false, why: `${asked} is not a project this host knows, and it holds no .git or .kehikot of its own, so it is not added as one. ${listed} The person can add it from the project list. Nothing was read or changed.` }
  }
  const done = addProject(db, asked)
  if (!done.ok) return { ok: false, why: `${asked} could not be added as a project: ${done.why} Nothing was read or changed.` }
  return {
    ok: true,
    project: done.project,
    added: done.already ? null : `Added ${done.project.name} (${done.project.path}) to this host’s projects, as Add a project does, because it was not one yet.`,
  }
}

/**
 * Which kehikko a call is about, decided once for every tool.
 *
 * Three ways it can go and all three are said out loud in the answer, because
 * "which canvas did that act on" is the question this whole door is most likely
 * to be got wrong about. A named kehikko that does not exist is refused with
 * the list; no name and no unambiguous open page is refused with the list; a
 * name that exists, or one open page, is an answer that says which it took and
 * why.
 */
export function decide(
  door: Door,
  args: Record<string, unknown>,
): { ok: true; canvas: Canvas; how: string } | { ok: false; why: string } {
  const asked = kehikkoIn(args.kehikko)
  if (asked === null) {
    return {
      ok: false,
      why:
        'kehikko must be the whole number a kehikko is identified by, e.g. kehikko: 3 — not a string and not a '
        + `name. Leave it out to act on the one a page of this host has open.\n\n${roster(door.db)}`,
    }
  }

  const id = asked ?? null
  const here = door.here ?? null
  /* A project named: any project this host knows, whichever one is on screen. */
  if (args.project !== undefined && args.project !== null) {
    const found = projectIn(door.db, args.project)
    if (!found.ok) return { ok: false, why: found.why }
    const { project, added } = found
    if (project.missing) return { ok: false, why: missingSaid(project) }
    const addedSaid = added ? `${added} ` : ''
    if (id !== null) {
      const canvas = listCanvases(door.db).find((c) => c.id === id)
      if (!canvas) return { ok: false, why: `there is no kehikko with id ${id}.\n\n${roster(door.db)}` }
      if (canvas.project !== project.id) {
        return { ok: false, why: `kehikko ${canvas.id} (${canvas.name}) is not in ${project.name}. Leave kehikko out to act on ${project.name}, or name one of its kehikot.\n\n${roster(door.db)}` }
      }
      return { ok: true, canvas, how: `${addedSaid}the kehikko you named, in ${project.name}` }
    }
    let theirs = listCanvases(door.db).filter((c) => c.project === project.id)
    let made = false
    if (!theirs.length) {
      theirs = ensureCanvases(door.db, project.id).filter((c) => c.project === project.id)
      made = true
    }
    const madeSaid = made ? ` (it had none, so one was made, as opening it in Kehikot would)` : ''
    if (here?.canvas && here.project.id === project.id) {
      const canvas = theirs.find((c) => c.id === here.canvas!.id)
      if (canvas) return { ok: true, canvas, how: `${addedSaid}this conversation’s own kehikko in ${project.name}` }
    }
    const open = door.which()
    const watched = door.watched?.() ?? (open.ok ? [open.id] : [])
    const shown = theirs.find((c) => open.ok && c.id === open.id) ?? theirs.find((c) => watched.includes(c.id))
    if (shown) return { ok: true, canvas: shown, how: `${addedSaid}the kehikko a page of this host shows in ${project.name}` }
    const first = theirs[0]
    if (!first) return { ok: false, why: `${project.name} has no kehikko and none could be made. Nothing was read or changed.` }
    return { ok: true, canvas: first, how: `${addedSaid}${project.name}’s first kehikko${madeSaid} — no page has it open` }
  }
  if (id === null && here?.canvas) {
    /* The conversation's own kehikko, whatever the person has on screen. */
    const canvas = listCanvases(door.db).find((c) => c.id === here.canvas!.id) ?? here.canvas
    const open = door.which()
    const watched = door.watched?.() ?? (open.ok ? [open.id] : [])
    const shown = watched.includes(canvas.id)
    return {
      ok: true,
      canvas,
      how: shown
        ? 'this conversation’s own kehikko, which a page of this host has open'
        : 'this conversation’s own kehikko — not the one on screen now; no page has it open',
    }
  }
  if (id === null) {
    const open = door.which()
    if (!open.ok) return { ok: false, why: `${open.why} ${PROJECT_HINT}\n\n${roster(door.db)}` }
    const canvas = listCanvases(door.db).find((c) => c.id === open.id)
    if (!canvas) {
      /* A page reporting a kehikko that has since been deleted, most likely in
         another window. Refused rather than falling back to some other kehikko,
         which would be the guess this whole file exists to avoid. */
      return {
        ok: false,
        why:
          `a page of this host says kehikko ${open.id} is open, but there is no kehikko with that id any more — `
          + `it was probably deleted in another window.\n\n${roster(door.db)}`,
      }
    }
    return {
      ok: true,
      canvas,
      how: here
        ? `the kehikko a page of this host has open — this conversation’s own kehikko (${here.key ?? 'none'}) is not in ${here.project.name} any more`
        : 'the kehikko a page of this host has open',
    }
  }

  const canvas = listCanvases(door.db).find((c) => c.id === id)
  if (!canvas) {
    return { ok: false, why: `there is no kehikko with id ${id}.\n\n${roster(door.db)}` }
  }
  return { ok: true, canvas, how: 'the kehikko you named' }
}

/** What the person has on screen: the kehikko a page has open, when exactly one is. */
export function looking(door: Door): Looking | null {
  const open = door.which()
  return lookingAt(door.db, open.ok ? open.id : null)
}

/** The conversation's place and what the person is looking at, for an answer that says both. */
export function placedOf(door: Door): Placed | undefined {
  return door.here === undefined ? undefined : { here: door.here, looking: looking(door), unrecorded: door.unrecorded ?? null }
}
