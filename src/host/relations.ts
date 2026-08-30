import type { Presence } from './registry.ts'

/**
 * Which modules touch which, out of what they already declared.
 *
 * ## The question, and why it needed answering carefully
 *
 * Somebody looking at the modules list asked a fair question: if a module uses
 * another module, or interacts with one, should the list not say so? It should.
 * The difficulty is that "interacts with" is four different claims wearing one
 * phrase, and three of them are weaker than the fourth. Drawn identically they
 * would make the host assert relationships it cannot see.
 *
 * So this file is the model, written down, and the rule it is held to is the
 * one `ask.ts` holds `view.goto` to: the host does not say `no-such-target`
 * about an epic it never looked for, because that is "a claim it is in no
 * position to make". A badge saying two modules interact when they merely
 * could is exactly the same error, at the same cost.
 *
 * ## What is derivable, and it is only these
 *
 * **An event, and it is the one DIRECT link.** `extensions.emits` on one
 * manifest and `extensions.consumes` on another name the same format string.
 * That is not a resemblance: `host/events.ts` reads those very arrays on every
 * emit and posts the message into the consumer's frame. The host performs the
 * delivery, so the host may state it, and may name both ends.
 *
 * **The passage, and it is INDIRECT in exactly the same way.** A module
 * declaring `passage:set` calls `passage.set`, the canvas holds it, and it goes
 * into the `roadmap.context` every framed module receives. Everything the
 * paragraph below says about the selection holds here with the noun swapped,
 * including the honest half-answer: there is no `passage:read`, so the sending
 * end is nameable and the receiving end is not. It is drawn as its own kind
 * rather than folded into the selection because what travels is different in
 * size and in kind — a file, a place in it, and a paragraph of somebody's
 * document — and a person reading a pane's relationships is entitled to know
 * which of those two things a module can broadcast.
 *
 * **The selection, and it is INDIRECT.** A module declaring `selection:set`
 * calls `selection.set`, the canvas holds the refs, and they go into the
 * `roadmap.context` every framed module receives. The sending half is
 * vouchable. The receiving half is NOT: there is no `selection:read`, no
 * capability, no manifest field and no message by which a module says it
 * reacts to one — see `CAPABILITIES` in the protocol's `methods.ts`, where
 * every entry is a thing a module ASKS the host for, and reading the context is
 * not asked for because it is simply handed over. So this relationship names
 * one end and honestly cannot name the other.
 *
 * **Navigation, also INDIRECT, and the widest.** A module declaring
 * `view:navigate` can call `view.goto` with an epic; the canvas makes it the
 * subject and tells every module on it. It is interaction with the CANVAS that
 * everything on the canvas feels, and it is easy to under-draw because the
 * mover names nobody.
 *
 * ## What is NOT drawn, deliberately
 *
 * **A shared subject.** Every epic-scoped module on a kehikko is looking at the
 * same epic. True, and true of ten of the eleven modules on this machine — a
 * badge for it would be on almost every row, and `Tools.tsx` has the argument
 * about what a canvas full of marks teaches people to do with marks. It is also
 * co-location rather than interaction: neither module can affect the other by
 * it. The one that CAN move the subject is drawn, above, as navigation.
 *
 * **An emit nobody consumes, or a consumer with no registered emitter.** Half a
 * relationship is not one. A module can perfectly well declare a format for a
 * counterpart that is not installed, and a row saying so would be asserting an
 * absence rather than a link. Nothing is drawn, which is why the tests below
 * cover both cases explicitly.
 *
 * **Two modules over the same material.** The citations module reads the corpus
 * the paper module renders. That is a real relationship and this file will
 * never show it, because nothing in either manifest names the other, and the
 * two hold their own copies of a path nobody declared. The only way to draw it
 * would be a list in the host saying "these two go together", hand-maintained,
 * rotting from the day it is written and wrong in a way no test can catch. The
 * honest answer is that the badge cannot show it.
 */

/**
 * Where the other end of a relationship is, right now.
 *
 * It qualifies every direct relationship, because the events bus deliberately
 * delivers across canvases — see `ModuleFrame.tsx`, which joins a module to the
 * bus whether or not its pane is on the open kehikko, so that "near or far" is
 * the module's comparison rather than the host's rule. A counterpart on another
 * kehikko is therefore genuinely reachable, and one that is on no kehikko at
 * all genuinely is not: it has no frame, so there is nothing to post into.
 */
export type Reach =
  /** On the kehikko that is open. */
  | { where: 'here' }
  /** Placed, but on other kehikkos. Named, because "which one" is the question. */
  | { where: 'elsewhere'; kehikkos: string[] }
  /** Registered and answering, and on no kehikko. Nothing is framed to hear. */
  | { where: 'unplaced' }
  /** Registered and not answering. */
  | { where: 'silent' }

/** The module at the other end, when there is one to name. */
export interface Counterpart {
  id: string
  /** What it calls itself, or its id when the host never read a manifest. */
  name: string
  reach: Reach
}

export interface Relationship {
  kind: 'emits' | 'consumes' | 'selection' | 'passage' | 'navigation'
  /**
   * Whether the host itself carries something between two named programs.
   *
   * True only of the event kinds. The user asked about both direct and indirect
   * interaction and they must not look alike: "the host hands Checklist's
   * notification to Notifications" and "this can move the canvas, which
   * everything on it feels" are claims of different strength.
   */
  direct: boolean
  /** The format, for the event kinds. */
  extension?: string
  /** The other ends, for the direct kinds. Never empty when present. */
  with: Counterpart[]
  /**
   * How many OTHER modules on the open kehikko are told, for the indirect
   * kinds — that being the whole of what the host can say about who feels it.
   * The context goes to every frame on the canvas; `context.ts` is explicit
   * that this host does not compose a different one per pane.
   */
  told: number
}

/** Where everything is, as the canvas layer knows it. */
export interface Placings {
  /** The ids on the kehikko that is open. */
  onCanvas: ReadonlySet<string>
  /** Every other kehikko each id sits on, by name. */
  elsewhere: ReadonlyMap<string, readonly string[]>
}

/**
 * The relationships each registered module has, keyed by module id.
 *
 * Pure: manifests and placements in, relationships out. No fetch, no window,
 * no clock — which is what lets the whole model be tested without a browser,
 * and is why it lives here rather than inside the component that draws it.
 *
 * A module the host never got a manifest from has no relationships at all, and
 * that is not a gap to fill in: the host has read nothing it said, so it has
 * nothing to report about what it speaks to.
 */
export function relate(
  presences: readonly Presence[],
  placings: Placings,
): Map<string, Relationship[]> {
  const emitters = new Map<string, string[]>()
  const consumers = new Map<string, string[]>()
  for (const presence of presences) {
    const extensions = presence.module?.extensions
    if (!extensions) continue
    for (const extension of extensions.emits) push(emitters, extension, presence.id)
    for (const extension of extensions.consumes) push(consumers, extension, presence.id)
  }

  const named = new Map<string, Presence>()
  for (const presence of presences) named.set(presence.id, presence)

  /* Who would feel a move of the canvas: the ready modules on the open kehikko.
     Counted once rather than per relationship, and "ready" is part of it —
     a pane whose program is not answering is not being told anything. */
  const here = presences.filter(
    (presence) => presence.condition === 'ready' && placings.onCanvas.has(presence.id),
  ).length

  const found = new Map<string, Relationship[]>()
  for (const presence of presences) {
    const module = presence.module
    if (!module) continue
    const relationships: Relationship[] = []

    for (const extension of module.extensions.emits) {
      const others = (consumers.get(extension) ?? []).filter((id) => id !== presence.id)
      if (!others.length) continue
      relationships.push({
        kind: 'emits',
        direct: true,
        extension,
        with: others.map((id) => counterpart(id, named, placings)),
        told: 0,
      })
    }

    for (const extension of module.extensions.consumes) {
      const others = (emitters.get(extension) ?? []).filter((id) => id !== presence.id)
      if (!others.length) continue
      relationships.push({
        kind: 'consumes',
        direct: true,
        extension,
        with: others.map((id) => counterpart(id, named, placings)),
        told: 0,
      })
    }

    /* The count excludes this module when it is itself on the open kehikko: the
       sentence is about who ELSE hears, and a module that is told what it just
       said is not an audience — the same rule `events.ts` applies to a sender. */
    const others = here - (placings.onCanvas.has(presence.id) && presence.condition === 'ready' ? 1 : 0)

    if (module.declares.uses.includes('view:navigate')) {
      relationships.push({ kind: 'navigation', direct: false, with: [], told: others })
    }
    if (module.declares.uses.includes('selection:set')) {
      relationships.push({ kind: 'selection', direct: false, with: [], told: others })
    }
    /* The same shape as the selection and named separately, because it is not
       the same fact. A selection is refs; a passage is a file, a place in it
       and a paragraph of what was there — which is a great deal more of
       somebody's material to put in front of every pane on the canvas, and a
       person deciding whether to place this module is entitled to read that
       rather than infer it from a word they may take to mean the same thing. */
    if (module.declares.uses.includes('passage:set')) {
      relationships.push({ kind: 'passage', direct: false, with: [], told: others })
    }

    if (relationships.length) found.set(presence.id, relationships)
  }
  return found
}

function push(index: Map<string, string[]>, key: string, id: string): void {
  const already = index.get(key)
  if (already) already.push(id)
  else index.set(key, [id])
}

function counterpart(id: string, named: Map<string, Presence>, placings: Placings): Counterpart {
  const presence = named.get(id)
  return {
    id,
    name: presence?.name ?? id,
    reach: reachOf(id, presence, placings),
  }
}

function reachOf(id: string, presence: Presence | undefined, placings: Placings): Reach {
  if (presence && presence.condition !== 'ready') return { where: 'silent' }
  if (placings.onCanvas.has(id)) return { where: 'here' }
  const kehikkos = placings.elsewhere.get(id)
  if (kehikkos?.length) return { where: 'elsewhere', kehikkos: [...kehikkos] }
  return { where: 'unplaced' }
}

/**
 * The plain sentence for one relationship, for a tooltip.
 *
 * Here rather than in the component for the reason the derivation is here: the
 * wording is the claim. "Emits" and "consumes" are jargon and a badge is too
 * small for a sentence, so the sentence is the tooltip — and it is the thing
 * that must not overstate, which makes it worth testing.
 *
 * Nothing here says an event IS being delivered. The host carries one when both
 * ends have a frame, and this function is looking at a registry rather than at
 * the bus; what it states is what each side declared, and where the other side
 * is. Those two the host can vouch for.
 */
export function sentenceFor(name: string, relationship: Relationship): string {
  const { kind, extension } = relationship

  if (kind === 'emits' || kind === 'consumes') {
    const others = relationship.with
    const list = names(others)
    const opening =
      kind === 'emits'
        ? `${name} says it sends ${extension}, and ${list} ${others.length === 1 ? 'says it shows' : 'say they show'} that format. The host carries it between them.`
        : `${name} says it shows ${extension}, and ${list} ${others.length === 1 ? 'says it sends' : 'say they send'} that format. The host carries it between them.`
    return `${opening} ${whereClause(others)}`
  }

  if (kind === 'navigation') {
    return relationship.told > 0
      ? `${name} can ask this kehikko to show a different epic. The canvas moves its subject and tells every module on it — ${count(relationship.told)} beside this one right now — so everything here follows at once.`
      : `${name} can ask this kehikko to show a different epic. The canvas would move its subject and tell every module on it; nothing else is on this one.`
  }

  if (kind === 'passage') {
    return relationship.told > 0
      ? `${name} can say where in a document somebody is pointing — which file, which page, which bytes, and what they said — and the host puts it in the context every module on this kehikko is told, ${count(relationship.told)} beside this one right now. Which of them does anything about a passage is in no manifest, so this does not name one.`
      : `${name} can say where in a document somebody is pointing — which file, which page, which bytes, and what they said — and the host puts it in the context every module on the kehikko is told; nothing else is on this one. Which module reacts to a passage is in no manifest.`
  }

  return relationship.told > 0
    ? `${name} can say which references somebody has picked out, and the host puts them in the context every module on this kehikko is told — ${count(relationship.told)} beside this one right now. Which of them does anything about a selection is in no manifest, so this does not name one.`
    : `${name} can say which references somebody has picked out, and the host puts them in the context every module on the kehikko is told; nothing else is on this one. Which module reacts to a selection is in no manifest.`
}

/** The short thing that fits in a badge. Never prose — see the essay in `Bar.tsx`. */
export function labelFor(relationship: Relationship): string {
  if (relationship.kind === 'navigation') return 'moves the epic'
  if (relationship.kind === 'selection') return 'sets the selection'
  if (relationship.kind === 'passage') return 'points at a passage'
  const others = relationship.with
  return others.length === 1 ? (others[0]?.name ?? '') : `${others.length} modules`
}

function names(others: readonly Counterpart[]): string {
  if (others.length === 1) return others[0]?.name ?? ''
  const all = others.map((one) => one.name)
  const last = all.pop()
  return `${all.join(', ')} and ${last}`
}

function count(n: number): string {
  return n === 1 ? 'one module' : `${n} modules`
}

/**
 * Where the other ends are, as one clause.
 *
 * It is the honest half of a direct badge. An event that has nowhere to land
 * because the counterpart is on no kehikko is a relationship that exists on
 * paper and is carrying nothing, and saying otherwise would be the error this
 * whole file is written against.
 */
function whereClause(others: readonly Counterpart[]): string {
  if (others.length !== 1) {
    const reachable = others.filter((one) => one.reach.where === 'here' || one.reach.where === 'elsewhere')
    if (!reachable.length) return 'None of them is on a kehikko right now, so nothing is being carried.'
    return `${reachable.length} of them ${reachable.length === 1 ? 'is' : 'are'} on a kehikko right now.`
  }
  const only = others[0]
  if (!only) return ''
  const reach = only.reach
  switch (reach.where) {
  case 'here':
    return `${only.name} is on this kehikko.`
  case 'elsewhere':
    return `${only.name} is on ${kehikkoList(reach.kehikkos)} rather than this one — the host carries events across kehikkos, so it hears from here.`
  case 'unplaced':
    return `${only.name} is registered and on no kehikko, so it has no page to be handed one and nothing is being carried.`
  default:
    return `${only.name} is not answering, so nothing is reaching it.`
  }
}

function kehikkoList(kehikkos: readonly string[]): string {
  const quoted = kehikkos.map((one) => `“${one}”`)
  if (quoted.length === 1) return `the kehikko ${quoted[0] ?? ''}`
  const last = quoted.pop()
  return `the kehikkos ${quoted.join(', ')} and ${last}`
}
