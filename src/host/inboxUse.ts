import { isHostModule, type Entry } from './inbox.ts'

/**
 * "Use inbox": the person's switch, per module and for the whole machine, for whether what a module
 * says reaches their Inbox. Kept by the server (`Inbox.use`, `inbox_muted` in `frame.sqlite`), set
 * only by a press in the page (`POST /host/inbox/use`, `PAGE_ONLY`).
 *
 * Off is not deleted: the record keeps the module's items, so turning it back on shows what the
 * module says now. What off changes is what the page draws, sounds and counts — no rows, no dots,
 * no chime, no toast, no count, and Next that needs me passes it by. It is never silent: the
 * Container menu's row says the state, and the Inbox panel says how many modules are muted, with
 * the way back.
 *
 * The host's own lists (`isHostModule`) have their own settings and are never muted here.
 */

/** A muted module's entries left out; the same list back when nothing is muted. */
export function unmuted<T extends Pick<Entry, 'module'>>(entries: readonly T[], muted: ReadonlySet<string>): readonly T[] {
  if (!muted.size) return entries
  const kept = entries.filter((one) => !muted.has(one.module))
  return kept.length === entries.length ? entries : kept
}

/** Whether "Stop showing it here" is offered for an entry: a module's, never the host's own. */
export const mayMute = (module: string): boolean => !isHostModule(module)

/**
 * Whether a container's Container menu has the "Use inbox" row: a module that can say something to
 * the Inbox (`activity:report`, or a line through `events:emit`), or one that is muted now, so the
 * way back is where the way in was.
 */
export function offersInboxUse(manifest: { declares: { uses?: readonly string[] } } | undefined | null, muted: boolean): boolean {
  if (muted) return true
  const uses = manifest?.declares.uses ?? []
  return uses.includes('activity:report') || uses.includes('events:emit')
}

/** What the Inbox panel says of the muted modules: never mute silently. */
export const mutedWords = (count: number): string => `${count} ${count === 1 ? 'module' : 'modules'} muted`

/** The by-line's offer on an entry, and its tooltip. */
export const stopWords = (name: string): string => `Stop showing ${name} here`
export const stopTitle = 'Turns “Use inbox” off for this module everywhere: nothing it says is shown, sounded or counted until you turn it back on'
