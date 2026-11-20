import type { Database } from 'bun:sqlite'
import type { SpaceNode } from 'kehikot-module-protocol'

import { listCanvases, type Canvas } from '../canvases.ts'
import type { Here, Unrecorded } from '../doorPlaces.ts'
import { MISSING_SAID, projectById } from '../projects.ts'
import type { Door } from './door.ts'

/**
 * The door's own words that more than one tool says: the roster a refusal lists, what a missing
 * project or an unplaced conversation is told, who an agent's change is signed as, and the small
 * helpers that put a module's or a person's words into an answer.
 */

/** Every kehikko this host holds, one per line, for a refusal somebody has to act on. */
/** What an agent is told about a project whose folder is gone. Never thrown, never written. */
export function missingSaid(project: { name: string; path: string }): string {
  return `${project.name} (${project.path}): ${MISSING_SAID} Nothing was read from it or written to it. The person can find it again from the project list.`
}

export function roster(db: Database): string {
  const canvases = listCanvases(db)
  if (!canvases.length) return 'This host holds no kehikot at all.'
  return (
    'The kehikot are:\n'
    + canvases
        .map((canvas) => {
          const project = canvas.project === null ? null : projectById(db, canvas.project)
          const where = project
            ? ` in ${project.name} (${project.path}${project.uid ? `, project id ${project.uid}` : ''}${project.missing ? ', folder missing' : ''})`
            : ''
          return `  ${canvas.id}: ${canvas.name}${where}`
        })
        .join('\n')
  )
}

/**
 * What a tool that needs a page showing the kehikko says when none does: how to get one there, never that it
 * cannot be done. A jump moves the person's view, so it is theirs to ask for.
 */
export function openFirst(door: Door, canvas: Canvas): string {
  const project = canvas.project === null ? null : projectById(door.db, canvas.project)
  const where = project ? `${project.name}${canvas.key ? `, kehikko ${canvas.key}` : ''}` : `kehikko ${canvas.id}`
  return `To act there, a page has to show it: ask the person to open ${where} in Kehikot, or, if they ask to be taken there, jump with project${project ? ` "${project.path}"` : ''} first.`
}

/**
 * What a refusal that found no kehikko says, so an agent learns that no page has to be open: any project
 * the host knows is reached by naming it.
 */
export const PROJECT_HINT =
  'No page has to be open: pass project — a project’s folder, name or id, as read_canvas and my_place print them — '
  + 'to act on any project this host knows.'

/** What the call that settled a connection in a place says (`Door.settled`): where, why, and how to change it. */
export function settledWords(here: Here): string {
  return (
    `This conversation had no place, so Kehikot set one: ${here.project.name}, ${here.epic ? `space ${here.epic} (the project’s only top-level space)` : 'the whole project, no space'}`
    + `${here.canvas ? ` on kehikko "${here.canvas.name}"` : ''}. Nobody was asked. If it is about one space, call set_my_place with that space `
    + '(and the kehikko); every tool here answers about this place until then.'
  )
}

/** What an answer says to a conversation with no place of its own. */
export const UNPLACED_LINE =
  'This conversation is not recorded under any place, so this answer is about what the person has open NOW — which '
  + 'is not this conversation’s place, only their current view. set_my_place records one.'

/** The same, for a call that carried a module's token whose record could not be read. */
export const unreadLine = (unrecorded: Unrecorded): string =>
  `This conversation carries a place from ${unrecorded.module}, but ${unrecorded.why}; so this answer is about what `
  + 'the person has open NOW, not this conversation’s place.'

/** A module's own words, for one line of an answer: no line breaks to forge a line with, and in quotes. */
export function quoted(text: string): string {
  return JSON.stringify(text.replace(/[\s\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim())
}

/** How many names a refusal lists before it stops. */
export const LISTED = 30

export const listWords = (names: readonly string[]) =>
  names.length ? `${names.slice(0, LISTED).join(', ')}${names.length > LISTED ? ', …' : ''}` : 'none'
export const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
export const trimmedPath = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path)

/** Who a mark through this door is signed as. */
export const AGENT = 'agent (MCP)'
/**
 * Who a fold through this door is signed as ON THE PAGE, where it is read in
 * a sentence — "folded by an agent". The door has no session, so it does not
 * know which agent; a module asking for a fold would be signed with its name.
 */
export const SIGNED = 'an agent'

/** A tree of spaces as lines an agent reads: one space a line, indented by depth, with its path of ids. */
export function spacesText(tree: readonly SpaceNode[], above: string[] = [], depth = 0): string {
  if (!tree.length && depth === 0) return '(no spaces)'
  return tree
    .map((node) => {
      const path = [...above, node.id]
      const line = `${'  '.repeat(depth)}- ${node.name} [${path.join('/')}]`
      return node.children.length ? `${line}\n${spacesText(node.children, path, depth + 1)}` : line
    })
    .join('\n')
}
