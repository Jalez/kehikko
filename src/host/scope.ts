import { showsProject, type ContextScope } from 'kehikot-module-protocol'

/**
 * "All epics": the project about every epic at once (`context.scope:
 * 'project'`, protocol 2.9.0), and what the host does for a module that
 * cannot show that.
 *
 * ## The module says whether it can, and the host covers the rest
 *
 * A module lists `project` in `declares.scopes` when it can show every epic of
 * the project, each item labelled with its epic. One that does not still gets
 * its normal context — `scope: 'project'`, `epic: null`, no parts — because a
 * context is the host's account of where the person is standing and it is the
 * same account for everyone. What it does not get is a person looking at it:
 * the HOST covers its container with one sentence, rather than leave the
 * module to go blank (it would read `epic: null` as "no epic" and show its
 * empty state) or go on showing the last epic it was told about, which would
 * be a page quietly describing work the person is no longer on.
 *
 * ## The page stays, underneath
 *
 * The cover is drawn over the container's body and the module's page is
 * hidden by the path a folded container's page takes (`visibility`, in
 * `Frames.tsx`): kept at its size, kept running, its document untouched. So
 * whatever the module was holding — a scroll position, a half-typed field, a
 * terminal — is exactly where it was when an epic is picked again, and the
 * page cannot be clicked or tabbed into behind a sentence that says it is not
 * in use.
 *
 * ## A pinned container is not covered
 *
 * A pinned container keeps the context it was pinned with and does not hear
 * the canvas move (`whileFrozen` in `context.ts`), so it is still on the
 * epic it was on. Covering it would hide a module that is showing exactly what
 * it says it is showing.
 */

/** What the cover says. One sentence and an instruction, with no module named: the container's header already names it. */
export const ONE_EPIC_AT_A_TIME = 'This module works on one epic at a time. Pick an epic to use it.'

/** What the epic picker calls the choice, and what its closed control says while it is chosen. */
export const ALL_EPICS = 'All epics'

/**
 * Whether a container is covered while the project is on "All epics": the
 * subject is the whole project, the container is not pinned, and its module
 * has not said it can show a whole project. A module whose manifest has not
 * been read is not covered here — it has a cover of its own while it loads, or
 * a notice when it will not answer (`host/standing.ts`).
 */
export function coveredForScope(
  scope: 'epic' | 'project' | undefined,
  module: { declares?: { scopes?: readonly ContextScope[] } } | null | undefined,
  pinned = false,
): boolean {
  if (scope !== 'project' || pinned || !module) return false
  return !showsProject(module)
}
