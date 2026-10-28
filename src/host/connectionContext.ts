import type { ContentChange, Disposition, EpicPart, SharedAddress, SharedLocation, TrackerSignal } from 'kehikot-module-protocol'

import { toWireContext, type Subject, type WireContext } from './context.ts'
import { withheldFor, type ConnectionsSetting } from './connections.ts'
import { passageOn, pointedBy, type Said } from './said.ts'
import { containersOf, type Arranged } from './showing.ts'

/**
 * The context ONE module on the open kehikko is told, when the person switched off a connection
 * into it (`host/connections.ts`): the passage set by a module it does not follow here is not
 * delivered — the passage is the latest pointing among the OTHER modules placed, as if that one
 * were not on the kehikko — nor that module's pointing in its row of `containers`; a selection
 * picked out by a module it does not follow is not delivered (and the code location, which stands
 * on the selection, goes with it); a code location or an address from a module it does not follow
 * is not delivered; and with the bar's parts switched off for it, it is told the parts with none
 * picked — the whole epic. Everything else is the shared context's.
 *
 * `null` when nothing is withheld from it: it is sent the shared context, the same object, so no
 * frame sees a new context where there is none. Pure; `test/connections-enforced.test.ts` is its table.
 */
export interface ContextFacts {
  subject: Subject
  theme: 'light' | 'dark'
  selection: readonly string[]
  /** Which module picked the selection out, or null when the host did not hear it (a reload). */
  selectedBy: string | null
  kehikko: { id: number; name: string; key?: string } | null
  said: Said
  /** The ids placed on the open kehikko, and the host's own pointing id. */
  placed: readonly string[]
  /** The host's own id for a pointing it makes itself ("Open the file"). Never withheld. */
  hostPoints: string
  placements: readonly Arranged[]
  dispositions: readonly Disposition[]
  tracker: TrackerSignal
  content: readonly ContentChange[]
  parts: readonly EpicPart[]
  location: SharedLocation | null
  address: SharedAddress | null
}

export function receiverContext(
  facts: ContextFacts,
  receiver: string,
  setting: ConnectionsSetting | null | undefined,
): WireContext | null {
  const withheld = withheldFor(setting, receiver, {
    placed: facts.placed.filter((id) => id !== facts.hostPoints),
    selectedBy: facts.selectedBy,
    locationBy: facts.location?.by ?? null,
    addressBy: facts.address?.by ?? null,
  })
  if (withheld === null) return null
  const from = facts.placed.filter((id) => !withheld.passageFrom.has(id))
  const passage = from.length ? passageOn(facts.said, from) : null
  const pointed = pointedBy(facts.said)
  for (const id of withheld.passageFrom) delete pointed[id]
  const selection = withheld.selection ? [] : facts.selection
  const containers = containersOf({
    placements: facts.placements,
    said: facts.said.showing,
    pointed,
    selection,
    selectedBy: withheld.selection ? null : facts.selectedBy,
  })
  return toWireContext(
    facts.subject,
    facts.theme,
    selection,
    facts.kehikko,
    passage,
    containers,
    facts.dispositions,
    facts.tracker,
    facts.content,
    withheld.parts ? facts.parts.map((part) => ({ ...part, picked: false })) : facts.parts,
    withheld.location ? null : facts.location,
    withheld.address ? null : facts.address,
  )
}
