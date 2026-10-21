import type { Place } from './inbox.ts'
import { TRACKER_NOTICES_MODULE } from './trackerNotices.ts'

/**
 * Where pressing an Inbox item takes the person: the steps from where they are
 * to where the item happened, decided here and carried out by the page
 * (`useGoToPlace`) with the same functions the project, kehikko and epic
 * pickers use.
 *
 * An item's place is an epic slug, the parts it is about, and a kehikko KEY.
 * The order is the order a person would go in: project, kehikko, epic and
 * parts, then the module's container is lit on that kehikko. A step already
 * true is left out, so an item of the open kehikko and epic only lights its
 * container.
 *
 * Never a container somewhere else instead: when the place's kehikko is gone,
 * or the module is not on it, the person is taken as far as can be (the
 * project, the epic) and `note` says why it stopped there. An item with no
 * place keeps what was always done — the module's container is found on this
 * kehikko or another — and `note` says the item did not say where it came from.
 */

/** A kehikko of the item's project, as far as going there needs. */
export interface KehikkoAt {
  key: string
  name: string
  /** The modules placed on it. */
  modules: readonly string[]
}

/** Where the person is now. */
export interface Here {
  project: number | null
  epic: string | null
  parts: readonly string[]
  /** The open kehikko's key. */
  kehikko: string | null
}

/** What is known of the project the item belongs to. */
export interface Target {
  project: number
  kehikot: readonly KehikkoAt[]
  /** Its epics' slugs, or null while they are not read (another project's are read on arrival). */
  epics: readonly string[] | null
}

export type GoStep =
  | { kind: 'project'; project: number }
  | { kind: 'kehikko'; key: string }
  | { kind: 'epic'; epic: string; parts: string[] }
  | { kind: 'highlight'; module: string }

export interface GoPlan {
  steps: GoStep[]
  /** A short line for the person when the plan stops short of the container, or the item named no place. */
  note: string | null
}

const NO_PLACE = 'This notice did not say where it came from, so its module is shown where it is.'
const NO_EPIC = 'No epic of this project names it.'

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((one) => b.includes(one))

/** The steps from `here` to the place of an item of `module`, in `target`'s project. */
export function planGo(item: { module: string; name?: string; place?: Place }, here: Here, target: Target): GoPlan {
  const who = item.name || item.module
  const place = item.place
  const steps: GoStep[] = []
  const elsewhere = target.project !== here.project
  if (elsewhere) steps.push({ kind: 'project', project: target.project })
  /* After a project switch nothing of `here` holds: every step is needed. */
  const at: Here = elsewhere ? { project: target.project, epic: null, parts: [], kehikko: null } : here

  const named = place?.kehikko !== undefined || place?.epic !== undefined
  /* The host's own tracker notices are on no kehikko: they go to the epic naming the ref, and light nothing. */
  const own = item.module === TRACKER_NOTICES_MODULE
  if (!named && own) return { steps, note: NO_EPIC }
  if (!named) {
    /* Today's behaviour: the module where it is, this kehikko first. */
    const on = target.kehikot.find((one) => one.key === at.kehikko && one.modules.includes(item.module))
      ?? target.kehikot.find((one) => one.modules.includes(item.module))
    if (on && on.key !== at.kehikko) steps.push({ kind: 'kehikko', key: on.key })
    if (on) steps.push({ kind: 'highlight', module: item.module })
    return { steps, note: NO_PLACE }
  }

  const notes: string[] = []
  /* The epic, when it is one this project has. Unknown epics (another project's, not read yet) are tried. */
  let epicStep: GoStep | null = null
  if (place?.epic !== undefined) {
    if (target.epics !== null && !target.epics.includes(place.epic)) {
      notes.push(`This project has no epic ${place.epic} any more.`)
    } else {
      const parts = [...new Set(place.parts ?? [])]
      if (place.epic !== at.epic || !sameSet(parts, at.parts)) epicStep = { kind: 'epic', epic: place.epic, parts }
    }
  }

  let lit: KehikkoAt | null = null
  if (place?.kehikko !== undefined) {
    const kehikko = target.kehikot.find((one) => one.key === place.kehikko) ?? null
    if (kehikko === null) {
      notes.push(`The kehikko ${who} spoke from is gone, so nothing is lit.`)
    } else {
      if (kehikko.key !== at.kehikko) steps.push({ kind: 'kehikko', key: kehikko.key })
      if (kehikko.modules.includes(item.module)) lit = kehikko
      else notes.push(`${who} is not on ${kehikko.name} any more, so nothing is lit.`)
    }
  } else if (!own) {
    /* A place of an epic alone: the module where it is, this kehikko first. */
    const on = target.kehikot.find((one) => one.key === at.kehikko && one.modules.includes(item.module))
      ?? target.kehikot.find((one) => one.modules.includes(item.module))
      ?? null
    if (on === null) notes.push(`${who} is on no kehikko of this project, so nothing is lit.`)
    else {
      if (on.key !== at.kehikko) steps.push({ kind: 'kehikko', key: on.key })
      lit = on
    }
  }
  if (epicStep) steps.push(epicStep)
  if (lit) steps.push({ kind: 'highlight', module: item.module })
  return { steps, note: notes.length ? notes.join(' ') : null }
}
