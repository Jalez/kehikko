import { LIMITS, own, type FilterChoice, type FilterGroup } from 'kehikot-module-protocol'

/**
 * What the host does with a filter, which is as close to nothing as it can be.
 *
 * A module says what it can be narrowed by — some axes, each with some options
 * and a resting one — and the host draws a control and remembers what was
 * pressed. It never learns what any of it means. There is no place in this file
 * where `resolved` differs from `ignored`, and there must not be: the modules
 * this was built for have six ideas between them and a seventh is arriving, and
 * a host that knew any of them would be a host to be edited every time somebody
 * has an idea. See the essay on `filterOptionSchema` in the protocol.
 *
 * ## The one hard problem, which is that a memory outlives its reason
 *
 * The choice is remembered, per container, in this host's own store — because
 * the requirement is that it survives quitting the app, and neither the module
 * (which may not be running) nor the browser (which is shared by every canvas)
 * can be asked to do that. See `filters` on the placement schema.
 *
 * A memory that outlives the thing it referred to is the failure this workspace
 * keeps finding, and here it has a very specific shape: a module ships a new
 * version with different options, or is pointed at something where the old
 * option means nothing, and a container is left narrowed by a value that is in
 * no menu. Nothing errors. The person sees a shorter list than they expect and
 * has nothing to press to get the rest back, because the thing to press is not
 * there.
 *
 * So a stored choice is never SENT as it stands once there is an offer. It is
 * reconciled against the offer the module is making RIGHT NOW, and anything the
 * module is not currently offering is treated, for that message, as though it
 * were never chosen. That is `chosen` below. It is NOT forgotten: see `settle`,
 * which keeps what the offer merely lacks (a zero-count option, a module that
 * is asleep) stored, and `remembered` for the one message before any offer.
 *
 * The module defends itself as well — the protocol says it should fall back to
 * its own default for an id it does not recognise — and that is what the
 * greeting leans on: this host cannot reconcile anything before the module has
 * said what it offers, so the greeting carries the stored choice unchecked
 * (`remembered`) rather than `{}`, and the module's own fallback covers an id
 * it no longer has until `chosen` replaces it.
 *
 * ## Nothing here is a permission
 *
 * An offer is not `declares.uses` and it is not `reacts`. Those are manifest
 * fields, read before a program runs, by somebody deciding whether to run it.
 * This is a running module describing what it is showing, it is not checked
 * against anything, and nothing is gated on it. A module that offers nothing
 * gets no control, which is what every module got the day before this existed.
 */

/**
 * Group id to option id, as the module named them — or, under a `toggles`
 * group, to the list of its option ids that are switched on.
 */
export type Choice = FilterChoice

/**
 * The ids a `toggles` group has switched on, out of whatever was stored.
 *
 * In the group's own order rather than the order they were pressed, so two
 * sets with the same members are the same record and `sameChoice` can say so
 * without sorting. Anything the group no longer offers is dropped here, which
 * is the list's version of a choice falling to its fallback: an id in no menu
 * is a switch nobody can see or turn off. A string under a toggles group — a
 * value from before the module made it one — names nothing in a set, and reads
 * as nothing switched on.
 */
export function switchedOn(group: FilterGroup, wanted: string | readonly string[] | undefined): string[] {
  if (!Array.isArray(wanted)) return []
  const on = new Set(wanted)
  return group.options.filter((option) => on.has(option.id)).map((option) => option.id)
}

/** A group's set with one option flipped, as `chosen` would then hold it. */
export function toggled(group: FilterGroup, current: readonly string[], option: string): string[] {
  const on = new Set(current)
  if (on.has(option)) on.delete(option)
  else on.add(option)
  return switchedOn(group, [...on])
}

/**
 * The choice a module should actually be told about, given what it is offering.
 *
 * Built from the offer rather than from the store, which is what makes it
 * impossible for a group the module no longer has to survive in it. A stored
 * value is consulted; it is never the shape of the answer.
 *
 * `own()` at every lookup, and the protocol's essay on it is the reason: both
 * of these strings arrived from a framed program, and `stored['constructor']`
 * finds something on the prototype that nobody ever chose. The protocol refuses
 * those three spellings at the wire and the server refuses them at the column;
 * this is the third place, and it is the one that would actually be exploited
 * if either of the others were ever relaxed.
 *
 * A group with a stored value that is not one of its options falls to that
 * group's `fallback`, which is the module's own word for its resting state. Not
 * to the first option, and not omitted: omitting it would leave the module
 * guessing, and guessing is what the fallback exists to stop.
 */
export function chosen(offer: readonly FilterGroup[], stored: Choice): Choice {
  const settled: Choice = {}
  for (const group of offer.slice(0, LIMITS.FILTER_GROUPS)) {
    const wanted = own(stored, group.id)
    if (group.kind === 'text') {
      /*
       * A typed group has no options to reconcile against and no fallback to
       * fall to, and both absences are one fact: its resting state is empty,
       * and empty is spelled by not being in the record at all.
       *
       * So there is nothing here to go stale in the way an option id does. A
       * query typed against last month's version of a module is still a query,
       * and the module either narrows by it or finds nothing — which is a state
       * that says so on screen, in the module's own words, with a count beside
       * it. That is not the failure this file guards. A value in no menu is
       * unreachable; a value in an input is right there to be edited.
       */
      if (typeof wanted === 'string' && wanted !== '') settled[group.id] = wanted
      continue
    }
    if (group.kind === 'toggles') {
      /* Absent when nothing is on, for the text group's reason: the resting
         state of a set is empty, and empty is spelled by not being here. */
      const on = switchedOn(group, wanted)
      if (on.length) settled[group.id] = on
      continue
    }
    const known = typeof wanted === 'string' && group.options.some((option) => option.id === wanted)
    /* `fallback` is optional on the type because a text group has none, and a
       choice group without one cannot reach here — the protocol's own schema
       refuses it. Defaulted rather than asserted, because "cannot" is a
       property of a schema somebody may edit. */
    settled[group.id] = known ? (wanted as string) : (group.fallback ?? '')
  }
  return settled
}

/**
 * How many groups one container may keep stored, offered or not. The wire
 * carries at most `FILTER_GROUPS` and a module offers at most that many; the
 * rest of this is room for groups that are not on offer right now (a module
 * asleep, an older version, an offer that was briefly empty) so that they are
 * there when the module is back. Bounded so a module that invents a new group
 * id every version cannot grow a container's record without limit.
 */
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])

export const STORED_GROUPS = LIMITS.FILTER_GROUPS * 3

/**
 * What should be WRITTEN DOWN after a press, which is not the same thing.
 *
 * `chosen` fills in every group, because a module has to be told about all of
 * them. This drops every OFFERED group that is on its resting option, because a
 * store full of "this one is at its default" is a store that cannot tell a
 * person who chose the default from a person who never chose anything — and
 * only one of those should survive the module changing its mind about what the
 * default is.
 *
 * ## What is NOT dropped: anything the offer merely lacks
 *
 * The protocol has no way for a module to say "this group is gone" or "this
 * option is gone for good". An offer is what it shows right now, and an option
 * that counts zero is not in it ("Hide closed changes (0)" is not a thing to
 * press) while it is exactly what a person switched on last week and expects
 * back when it counts something again. So absence is not a reason to forget:
 *
 * - an option id a stored `toggles` set holds that the group does not offer is
 *   carried through, after the offered ones;
 * - a stored group the offer does not mention at all is carried through
 *   untouched, and so is every group when the offer is empty (a module that is
 *   not running, or has not finished loading, offers nothing, and pruning
 *   against nothing would forget every filter on the canvas).
 *
 * What is dropped is what the PERSON (or the module's own `filters.set`)
 * changed: `choice` is the group being written, and it replaces that group's
 * stored value, including a toggles set's offered members. Nothing else ever
 * leaves, except to the bounds: `STORED_GROUPS` groups, `FILTER_OPTIONS` ids in
 * a set — the oldest carried values go first, offered ones always stay. Only
 * `chosen` decides what is SENT, and it sends only what is on offer.
 *
 * `before` is what was stored. Without it this is the old pure function of an
 * offer and a choice.
 */
export function settle(offer: readonly FilterGroup[], choice: Choice, before: Choice = {}): Choice {
  const kept: Choice = {}
  for (const group of offer) {
    const wanted = own(choice, group.id)
    if (wanted === undefined) continue
    if (group.kind === 'text') {
      /* Empty is how a typed group says it is at rest, so it is dropped here
         exactly as a choice group on its fallback is — and for the same reason:
         a store that recorded "this input is empty" could not tell somebody who
         cleared it from somebody who never typed in it.

         Clipped rather than refused. The protocol bounds this at
         `FILTER_TEXT`, and a value over it can only arrive from a module's own
         `filters.set` or a hand-edited database; a query cut to length is still
         a query, where dropping it is a filter that silently stops working the
         first time somebody pastes something long. */
      if (typeof wanted === 'string' && wanted !== '') kept[group.id] = wanted.slice(0, LIMITS.FILTER_TEXT)
      continue
    }
    if (group.kind === 'toggles') {
      /* The offered members as written, then the stored ones this group does
         not offer right now (zero today, back tomorrow). An empty set with
         nothing carried is the group at rest, and dropped for the same reason. */
      const on = switchedOn(group, wanted)
      const offered = new Set(group.options.map((option) => option.id))
      const old = own(before, group.id)
      const carried = Array.isArray(old) ? old.filter((id) => !offered.has(id)) : []
      const all = [...on, ...carried].slice(0, LIMITS.FILTER_OPTIONS)
      if (all.length) kept[group.id] = all
      continue
    }
    if (typeof wanted !== 'string' || wanted === group.fallback) continue
    if (!group.options.some((option) => option.id === wanted)) continue
    kept[group.id] = wanted
  }
  /* Groups the offer does not mention: held as they were stored. A group that
     IS offered but absent from `kept` is at rest and stays dropped. */
  const offeredIds = new Set(offer.map((group) => group.id))
  for (const id of Object.keys(before)) {
    if (Object.keys(kept).length >= STORED_GROUPS) break
    if (offeredIds.has(id) || RESERVED.has(id)) continue
    const old = own(before, id)
    if (old === undefined || old === '' || (Array.isArray(old) && !old.length)) continue
    kept[id] = Array.isArray(old) ? old.slice(0, LIMITS.FILTER_OPTIONS) : old
  }
  return kept
}

/**
 * The stored choice as a module that has not offered anything yet is told it.
 *
 * Before the first offer there is nothing to reconcile against, and `chosen`
 * against nothing is `{}` — which drew the module unnarrowed for the one round
 * trip until its offer arrived, then narrowed it: a flash of everything. So the
 * greeting carries what is stored, as it stands, cut to the wire's bounds; the
 * protocol already makes a module fall back on an id it does not know, and
 * `chosen` replaces this with the reconciled choice when the offer arrives.
 */
export function remembered(stored: Choice): Choice {
  const told: Choice = {}
  for (const id of Object.keys(stored)) {
    if (Object.keys(told).length >= LIMITS.FILTER_GROUPS) break
    const value = own(stored, id)
    if (typeof value === 'string' && value !== '') told[id] = value.slice(0, LIMITS.FILTER_TEXT)
    else if (Array.isArray(value) && value.length) told[id] = [...new Set(value)].slice(0, LIMITS.FILTER_OPTIONS)
  }
  return told
}

/**
 * Is anything actually narrowed?
 *
 * The one thing the host can honestly say about a filter without knowing what
 * it means: some group is on something other than the option its own module
 * called the resting one. It is what the header control looks like from across
 * a canvas, and it is the whole of the always-visible signal that something is
 * being hidden — the module's own words for how much are one press away, in the
 * menu, where the module wrote them.
 */
export function narrowed(offer: readonly FilterGroup[], choice: Choice): boolean {
  return offer.some((group) => {
    const wanted = own(choice, group.id)
    if (wanted === undefined || wanted === '') return false
    /* A text group with anything in it is narrowing something, whatever it
       says. The host cannot know what the module will match, and does not need
       to: the claim this makes is "something has been typed here", which is
       exactly as true as "something other than the resting option is pressed"
       and is the same signal a person needs when a list looks short. */
    if (group.kind === 'text') return typeof wanted === 'string'
    /* A set with anything in it is hiding something, by the same argument: the
       host cannot know what each option covers, only that one is switched on,
       and the resting state of a toggles group is nothing switched on. */
    if (group.kind === 'toggles') return switchedOn(group, wanted).length > 0
    return wanted !== group.fallback
  })
}

/**
 * Whether two choices say the same thing.
 *
 * Content and not identity, because these records are rebuilt on every render
 * out of a stored value and a live offer. Used to decide whether a press or a
 * re-announcement is worth a write — a module whose label carries a count
 * re-announces whenever the count changes, which is often, and every one of
 * those would otherwise be a write to the arrangement and a `kehikot.context`
 * to every frame on the canvas.
 *
 * `Object.hasOwn` rather than `in`: both of these are keyed by strings a framed
 * module invented, and `'constructor' in b` is true of every object there has
 * ever been.
 *
 * A toggles set compares by its members in order. `chosen` and `settle` both
 * write a set in the group's own option order, so two records that went through
 * either are equal exactly when they hold the same options.
 */
export function sameChoice(a: Choice, b: Choice): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
}

function sameValue(a: string | readonly string[] | undefined, b: string | readonly string[] | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((id, i) => id === b[i])
  return a === b
}
