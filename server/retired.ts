import type { ActivityItem } from 'kehikot-module-protocol'

import type { Inbox } from './inbox.ts'
import type { Retired } from './official.ts'
import type { UninstallOutcome } from './uninstall.ts'

/**
 * A module the official list retired, still on this machine.
 *
 * The list (`modules.json`'s `retired`, read by `officialSource.ts`) says which modules are
 * deprecated. Every registered module the list retires carries a note on its presence (`noteOf`) —
 * wherever its directory is — which the modules menu draws as a "Deprecated" badge, with "Replaced by
 * <successor>." when the list names one, and Uninstall beside it.
 *
 * And ONE Inbox item says it (`retiredOffer`): "Atlas, Notifications and Tests are retired and still
 * installed. Uninstall them?", with one press to uninstall them all — each fully, as Uninstall does
 * (`uninstall.ts`), project data kept. Asked on start and when the list or the registry changes; "Not
 * now" holds until the app starts again. Nothing is ever removed without that press.
 *
 * The host names no module here; every id and word arrives from the list or the registry.
 */

/** The host speaks as itself, under the name it goes by. */
export const BY = { module: 'kehikko', name: 'Kehikot' } as const

/** The host's own Inbox list the offer is in: about the modules on this computer. */
export const RETIRED_INBOX_MODULE = 'kehikko.modules'
export const RETIRED_ITEM = 'retired-installed'

/** What a presence says of a retired module: the list's words, and the successor when it names one. */
export interface RetiredNote {
  says: string
  successor?: { id: string; name: string }
}

/** The note for a module, or nothing when the list does not retire it. `nameOf` is the successor's name, when known. */
export function noteOf(retired: readonly Retired[], id: string, nameOf: (id: string) => string | null): RetiredNote | null {
  const entry = retired.find((one) => one.id === id)
  if (!entry) return null
  const name = entry.replacedBy ? nameOf(entry.replacedBy) : null
  return { says: entry.says, ...(entry.replacedBy && name ? { successor: { id: entry.replacedBy, name } } : {}) }
}

/** The retired modules registered here, by name. `nameOf` is the registered name, else the list's. */
export function retiredStill(retired: readonly Retired[], registered: readonly string[], nameOf: (id: string) => string | null): { id: string; name: string }[] {
  const here = new Set(registered)
  return retired
    .filter((one) => here.has(one.id))
    .map((one) => ({ id: one.id, name: nameOf(one.id) ?? one.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** "A, B and C". */
export function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** The words of the offer and its two choices. Pure. */
export function retiredWords(names: readonly string[]): { label: string; yes: string; no: string } {
  const one = names.length === 1
  return {
    label: `${listed(names)} ${one ? 'is' : 'are'} retired and still installed. Uninstall ${one ? 'it' : 'them'}?`,
    yes: one ? 'Uninstall it' : 'Uninstall them',
    no: 'Not now',
  }
}

/** The one Inbox item, as the host reports it into its own list. */
export function retiredItem(names: readonly string[]): ActivityItem {
  const words = retiredWords(names)
  return {
    id: RETIRED_ITEM,
    state: 'attention',
    priority: 'normal',
    label: words.label,
    detail: 'Each is taken off this computer fully: stopped, its copy, logs and registration removed, and what it put in your agent taken out. What it saved in your projects stays.',
    question: { text: words.label, choices: [words.yes, words.no], to: { module: RETIRED_INBOX_MODULE, session: RETIRED_ITEM } },
  } as ActivityItem
}

export interface RetiredOfferDeps {
  inbox: Pick<Inbox, 'report'>
  /** The projects to speak in (the open ones, else the first). */
  where(): number[]
  changed(project: number, rev: number): void
  /** The retired modules registered here now. */
  still(): Promise<{ id: string; name: string }[]>
  /** One full Uninstall, project data kept. */
  uninstall(id: string): Promise<UninstallOutcome>
  /** One line in the Inbox, said where the person is. */
  tell(line: string): void
}

/** The offer: put up, taken down, and answered. */
export function retiredOffer(deps: RetiredOfferDeps) {
  const holding = new Set<number>()
  let declined = false
  let said = ''

  function put(names: readonly string[]): void {
    const items = names.length && !declined ? [retiredItem(names)] : []
    const text = items.length ? retiredWords(names).label : ''
    const now = deps.where()
    if (text === said && now.every((project) => holding.has(project) === items.length > 0)) return
    said = text
    for (const project of new Set([...holding, ...now])) {
      const out = deps.inbox.report(project, RETIRED_INBOX_MODULE, BY.name, items)
      deps.changed(project, out.rev)
    }
    holding.clear()
    if (items.length) for (const project of now) holding.add(project)
  }

  /** Look again: on start, and whenever the list or the registry changes. */
  async function offer(): Promise<void> {
    put((await deps.still()).map((one) => one.name))
  }

  /** The person's press on one of the item's choices. */
  async function answer(text: string): Promise<{ ok: true; said: string } | { ok: false; why: string }> {
    const still = await deps.still()
    const words = retiredWords(still.map((one) => one.name))
    if (text === words.no) {
      declined = true
      put([])
      return { ok: true, said: '' }
    }
    if (text !== words.yes) return { ok: false, why: `Press “${words.yes}” or “${words.no}”.` }
    const lines: string[] = []
    for (const one of still) {
      const done = await deps.uninstall(one.id)
      lines.push(done.ok ? done.said : `${one.name} was not uninstalled: ${done.why}`)
    }
    for (const line of lines) deps.tell(line)
    await offer()
    return { ok: true, said: lines.join(' ') }
  }

  return { offer, answer }
}
