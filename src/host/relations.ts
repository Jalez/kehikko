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
 * ## There are exactly two channels, and everything here rides on them
 *
 * This file is a reading of a pipeline rather than a taxonomy invented beside
 * one, and the distinction matters because the failure it is guarding against
 * is cheap to fall into: fourteen modules each growing a private wire to the
 * one other module they care about, and a list like this one describing the
 * tangle afterwards as though it were a design.
 *
 * There are two general channels in this workspace and there should never be a
 * third without a very good reason written down beside it:
 *
 * - **The canvas context.** A module calls `passage.set` or `selection.set`,
 *   the host holds the value, and `context.ts` broadcasts it to every framed
 *   module. Broadcast, one subject at a time, addressed to nobody.
 * - **Events.** `extensions.emits` and `extensions.consumes` name a format
 *   string and `host/events.ts` posts the payload into the consuming module's
 *   frame. Addressed by format, many-to-many.
 *
 * The relationship that prompted the "Consumes / Provides to" question is
 * already one of these, and it is worth stating because it is the pattern
 * working rather than an exception to it: a learning question that points at
 * the passage of the paper it was written from is `passage.set`, and nothing
 * else. It needed no channel, no pair-specific message and no new machinery —
 * only a capability the learning module's manifest had not yet declared, and,
 * now, a `reacts` line saying it does something when a passage arrives.
 *
 * The consequence for what a module may WRITE is in the essay on `standingOf`
 * below and is the same argument from the other end: a manifest names a thing
 * that travels and a channel it travels on, never another module. The host does
 * the matching, which is the only reason the matching can be believed.
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
 * including what may and may not be said about the receiving end. It is drawn
 * as its own kind
 * rather than folded into the selection because what travels is different in
 * size and in kind — a file, a place in it, and a paragraph of somebody's
 * document — and a person reading a container's relationships is entitled to know
 * which of those two things a module can broadcast.
 *
 * **The selection, and it is INDIRECT.** A module declaring `selection:set`
 * calls `selection.set`, the canvas holds the refs, and they go into the
 * `roadmap.context` every framed module receives. The sending half has always
 * been vouchable. The receiving half was not, and the section below is about
 * what changed.
 *
 * ## The receiving half, which this file used to say was unnameable
 *
 * What stood here was: "The receiving half is NOT vouchable: there is no
 * `selection:read`, no capability, no manifest field and no message by which a
 * module says it reacts to one." That was true of the protocol as it was, and
 * it is the reason a registry could say who SENDS and could not say who
 * RECEIVES — so the sentence somebody wanted, "Consumes: X, Y. Provides to: Z,
 * W", could only ever be written half way.
 *
 * The protocol now has `reacts`, a top-level manifest array naming the context
 * kinds a module says it does something about. Read the essay on it in the
 * protocol's `manifest.ts` before touching anything here, because the shape of
 * what this file may claim follows directly from what that field is:
 *
 * **It is not a capability, and the distinction is the whole design.** There is
 * still no `selection:read`. A context is broadcast to every framed module,
 * unchanged, whether or not it declared a word — `context.ts` composes one per
 * canvas and this host will not compose a different one per container. So
 * `reacts` grants nothing, withholds nothing, and routes nothing. A module
 * that declares it is not privileged; a module that lies about it is wrong in a
 * list. If a future change here begins filtering the broadcast on this field,
 * that change has invented a permission over material the host was already
 * sending, and it should be refused on that ground alone.
 *
 * **So it is weaker evidence than an event, and stays drawn as weaker.** An
 * emit-and-consume pair is two manifests plus `host/events.ts` doing the
 * carrying: the host performs the delivery and may state it. A set-and-react
 * pair is two manifests and a broadcast the host would have sent anyway: both
 * ends said something about themselves, and neither one's word is checked
 * against behaviour. `direct` therefore stays FALSE for these, and the badge
 * stays the weaker one, even though `with` is now populated. Naming both ends
 * is not the same claim as carrying something between them.
 *
 * **A declared reaction with nothing to react to is not drawn.** The rule
 * "half a relationship is not one" applies here as it does to events, and it
 * applies asymmetrically on purpose. A `selection:set` badge is drawn with
 * nobody declared opposite it, because the host itself will broadcast what that
 * module sets to every frame on the canvas — that half is the host's own fact.
 * A `reacts: ['selection']` with no registered setter is only a stranger's
 * sentence about a thing nothing on this machine produces, and repeating it
 * would be the host asserting a link out of one manifest. It also disposes of
 * unknown words for free: a module reacting to `weather` has no counterpart,
 * so nothing is drawn and nothing has to be special-cased.
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
 * bus whether or not its container is on the open kehikko, so that "near or far" is
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

/** The context kinds a module can declare a reaction to, and the capability that produces each. */
const SETS: Record<string, string> = { selection: 'selection:set', passage: 'passage:set' }

export interface Relationship {
  kind: 'emits' | 'consumes' | 'selection' | 'passage' | 'navigation'
  /**
   * Which end of a context kind this module is.
   *
   * Only on `selection` and `passage`, because only they have two ends to be.
   * `emits` and `consumes` say their direction in the kind itself, and
   * `navigation` genuinely has one end — moving the canvas is felt by whatever
   * is on it, and nothing declares that it follows the subject beyond the mode
   * scope it already declared.
   *
   * A separate field rather than five more kinds, so that everything that
   * reasons about WHAT travels — the icon, the noun in the sentence, the
   * argument for drawing a passage apart from a selection — keeps reading one
   * word, and only the two places that care about direction read two.
   */
  role?: 'sets' | 'reacts'
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
  /**
   * The other ends, when both halves were declared. Never empty when present.
   *
   * Populated for the event kinds, where the host carries the payload, and for
   * the context kinds, where it does not — see the header. `direct` is what
   * separates those two, not this.
   */
  with: Counterpart[]
  /**
   * How many OTHER modules on the open kehikko are told, for the indirect
   * kinds — that being the whole of what the host can say about who feels it.
   * The context goes to every frame on the canvas; `context.ts` is explicit
   * that this host does not compose a different one per container.
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
  /* The two halves of a context kind, indexed the same way the event halves
     are. `setters` comes from a CAPABILITY the module declared and `reactors`
     from a DESCRIPTION it wrote, which is why the two are read out of two
     different fields and why nothing below ever treats them as equivalent
     evidence — see the header. */
  const setters = new Map<string, string[]>()
  const reactors = new Map<string, string[]>()
  for (const presence of presences) {
    const module = presence.module
    if (!module) continue
    for (const extension of module.extensions.emits) push(emitters, extension, presence.id)
    for (const extension of module.extensions.consumes) push(consumers, extension, presence.id)
    for (const [kind, capability] of Object.entries(SETS)) {
      if (module.declares.uses.includes(capability)) push(setters, kind, presence.id)
    }
    /* `?? []` because this arrives as JSON from a server that may be older than
       the page. Unknown words are kept rather than filtered: they simply find
       no setter opposite them and are never drawn, which is the same refusal a
       known word with no setter gets and needs no separate rule. */
    for (const kind of module.reacts ?? []) push(reactors, kind, presence.id)
  }

  const named = new Map<string, Presence>()
  for (const presence of presences) named.set(presence.id, presence)

  /* Who would feel a move of the canvas: the ready modules on the open kehikko.
     Counted once rather than per relationship, and "ready" is part of it —
     a container whose program is not answering is not being told anything. */
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
      relationships.push({
        kind: 'selection',
        role: 'sets',
        direct: false,
        with: reactorsOf('selection', presence.id, reactors, named, placings),
        told: others,
      })
    }
    /* The same shape as the selection and named separately, because it is not
       the same fact. A selection is refs; a passage is a file, a place in it
       and a paragraph of what was there — which is a great deal more of
       somebody's material to put in front of every container on the canvas, and a
       person deciding whether to place this module is entitled to read that
       rather than infer it from a word they may take to mean the same thing. */
    if (module.declares.uses.includes('passage:set')) {
      relationships.push({
        kind: 'passage',
        role: 'sets',
        direct: false,
        with: reactorsOf('passage', presence.id, reactors, named, placings),
        told: others,
      })
    }

    /* The receiving half, and the only half of this file that is drawn out of a
       module's description of itself rather than out of a capability. It is
       drawn ONLY when something registered can produce the thing: a reaction to
       what nothing on this machine sets is a sentence the host has no part in
       and would be repeating on trust. `told` is zero here rather than the
       audience count — a reactor has no audience, it IS one. */
    for (const kind of module.reacts ?? []) {
      if (kind !== 'selection' && kind !== 'passage') continue
      const from = (setters.get(kind) ?? []).filter((id) => id !== presence.id)
      if (!from.length) continue
      relationships.push({
        kind,
        role: 'reacts',
        direct: false,
        with: from.map((id) => counterpart(id, named, placings)),
        told: 0,
      })
    }

    if (relationships.length) found.set(presence.id, relationships)
  }
  return found
}

/**
 * Who says they react to this kind, other than the module that sets it.
 *
 * Self excluded for the reason a module that consumes what it emits is not its
 * own counterpart: a program telling itself something is not a relationship
 * between two programs, and a row saying so would be on almost every module
 * that both points and follows.
 */
function reactorsOf(
  kind: string,
  self: string,
  reactors: Map<string, string[]>,
  named: Map<string, Presence>,
  placings: Placings,
): Counterpart[] {
  return (reactors.get(kind) ?? [])
    .filter((id) => id !== self)
    .map((id) => counterpart(id, named, placings))
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

  /*
   * The receiving half, and the sentence works hard because the claim is weak.
   *
   * Both halves of it are things two modules wrote about themselves. The host
   * checked neither, carries nothing between them, and would broadcast the
   * context to this module whether or not it had said a word — so the sentence
   * says all three of those out loud rather than letting "X reacts to what Y
   * sets" be read as a wire between them.
   */
  if (relationship.role === 'reacts') {
    const noun = kind === 'passage' ? 'a passage' : 'a selection'
    const what =
      kind === 'passage'
        ? 'where in a document somebody is pointing'
        : 'which references somebody has picked out'
    return `${name} says it reacts to ${noun}, and ${names(relationship.with)} ${relationship.with.length === 1 ? 'says it can say' : 'say they can say'} ${what}. Both are what the modules say about themselves — the host broadcasts the context to every module on the kehikko in any case, and it carries nothing between these two.`
  }

  const reacting = relationship.with.length
    ? `${names(relationship.with)} ${relationship.with.length === 1 ? 'says it' : 'say they'} react${relationship.with.length === 1 ? 's' : ''} to ${kind === 'passage' ? 'a passage' : 'a selection'}, in ${relationship.with.length === 1 ? 'its own manifest' : 'their own manifests'}.`
    : `None of them says in its manifest that it reacts to ${kind === 'passage' ? 'a passage' : 'a selection'}, so this does not name one.`

  if (kind === 'passage') {
    return relationship.told > 0
      ? `${name} can say where in a document somebody is pointing — which file, which page, which bytes, and what they said — and the host puts it in the context every module on this kehikko is told, ${count(relationship.told)} beside this one right now. ${reacting}`
      : `${name} can say where in a document somebody is pointing — which file, which page, which bytes, and what they said — and the host puts it in the context every module on the kehikko is told; nothing else is on this one. ${reacting}`
  }

  return relationship.told > 0
    ? `${name} can say which references somebody has picked out, and the host puts them in the context every module on this kehikko is told — ${count(relationship.told)} beside this one right now. ${reacting}`
    : `${name} can say which references somebody has picked out, and the host puts them in the context every module on the kehikko is told; nothing else is on this one. ${reacting}`
}

/** The short thing that fits in a badge. Never prose — see the essay in `Bar.tsx`. */
export function labelFor(relationship: Relationship): string {
  if (relationship.kind === 'navigation') return 'moves the epic'
  if (relationship.kind === 'selection') {
    return relationship.role === 'reacts' ? 'follows the selection' : 'sets the selection'
  }
  if (relationship.kind === 'passage') {
    return relationship.role === 'reacts' ? 'follows a passage' : 'points at a passage'
  }
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

/**
 * Both halves of a module's place in the registry, for the list.
 *
 * ## What the two lists are, and what they are not
 *
 * Somebody browsing every registered module asked for the sentence in its
 * plainest form: "Consumes: X, Y, Z. Provides to: Z, W, A." That is a question
 * about MODULES, so the two lists here are names of other programs — the same
 * `Counterpart`s the badges use, deduplicated, because one module can be on the
 * other end of three relationships and belongs in the sentence once.
 *
 * Every one of those names is DERIVED. No manifest anywhere names another
 * module, and none may: a module that wrote "I consume Paper" would be making a
 * claim about a program it cannot see, would be wrong the day that program is
 * renamed or replaced, and would have to be believed because there is nothing
 * to check it against. What a module writes is what it takes and what it puts
 * out — a passage, a selection, a named event format — and the host does the
 * matching. That is why the two lists can be trusted at all, and it is why the
 * two of them are computed here rather than read off anything.
 *
 * `providesTo` therefore holds only the ends that were actually declared
 * opposite. A module that emits a format nobody consumes, or sets a passage
 * nobody says they follow, has an empty list and still gets its badge — see
 * below. That is the same refusal `relate` makes and for the same reason:
 * naming an audience the host cannot see would be inventing one, and the badge
 * already says the module provides without pretending to know to whom.
 *
 * ## Why the badges are read off the manifest and the lists off the pairs
 *
 * They answer two different questions and it would be a mistake to derive both
 * the same way. "Is this a provider?" is a fact about the module alone: it says
 * it emits something, or it declared a capability that puts something in front
 * of every pane on a canvas. That stays true on a machine where nothing else is
 * installed, and a person browsing a registry to decide what to install needs
 * it to. "Who does it provide to?" is a fact about this machine's population
 * and changes the moment somebody registers another program.
 *
 * So a module can be badged a provider with nothing after "Provides to", and
 * that pair of facts is the true one rather than an inconsistency to smooth
 * over. The row that would be dishonest is the opposite: a name in a list with
 * no declaration behind it.
 *
 * Nothing here gates anything. These are two lists and two words on a screen.
 */
export interface Standing {
  /** Says, in its own manifest, that it takes something in. */
  consumer: boolean
  /** Says, in its own manifest, that it puts something out. */
  provider: boolean
  /** The modules something reaches it from, named once each. */
  consumes: Counterpart[]
  /** The modules that said they take something from it, named once each. */
  providesTo: Counterpart[]
}

/** The capabilities that make a module a provider of something shared. */
const OFFERS = ['events:emit', 'selection:set', 'passage:set', 'view:navigate']

export function standingOf(presence: Presence, relationships: readonly Relationship[]): Standing {
  const module = presence.module
  const consumes = new Map<string, Counterpart>()
  const providesTo = new Map<string, Counterpart>()
  for (const relationship of relationships) {
    /* Which map a relationship lands in is exactly the direction question, and
       the two channels answer it in two different fields: an event says it in
       `kind`, a context kind says it in `role`. Navigation lands in neither,
       deliberately — it moves the canvas and names nobody, so it has no other
       end to put in a list. */
    const into =
      relationship.kind === 'consumes' || relationship.role === 'reacts'
        ? consumes
        : relationship.kind === 'emits' || relationship.role === 'sets'
          ? providesTo
          : null
    if (!into) continue
    for (const one of relationship.with) if (!into.has(one.id)) into.set(one.id, one)
  }

  /* `events:emit` is checked as well as `extensions.emits`, because they are
     two different admissions and a module can make either without the other:
     one names a FORMAT it will send, the other is the capability it needs to
     send anything at all. A module with the capability and no format is still
     offering to put payloads on the bus. */
  const provider = Boolean(
    module &&
      (module.extensions.emits.length > 0 || module.declares.uses.some((one) => OFFERS.includes(one))),
  )
  const consumer = Boolean(
    module && (module.extensions.consumes.length > 0 || (module.reacts ?? []).length > 0),
  )

  return { consumer, provider, consumes: [...consumes.values()], providesTo: [...providesTo.values()] }
}
