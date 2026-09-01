import { LIMITS, own, type FilterGroup } from 'roadmap-module-protocol'

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
 * So a stored choice is never used as it stands. It is reconciled against the
 * offer the module is making RIGHT NOW, every time, and anything the module is
 * not currently offering is treated as though it were never chosen. That is
 * `chosen` below, and it is the only way a stored value reaches either the menu
 * or the wire.
 *
 * The module defends itself as well — the protocol says it should fall back to
 * its own default for an id it does not recognise — and the redundancy is
 * deliberate. This host cannot reconcile anything before the module has said
 * what it offers, and the greeting goes out first, so the first choice a module
 * ever receives is one nobody has checked. Two programs each assuming the other
 * got it right is exactly how a stale value survives.
 *
 * ## Nothing here is a permission
 *
 * An offer is not `declares.uses` and it is not `reacts`. Those are manifest
 * fields, read before a program runs, by somebody deciding whether to run it.
 * This is a running module describing what it is showing, it is not checked
 * against anything, and nothing is gated on it. A module that offers nothing
 * gets no control, which is what every module got the day before this existed.
 */

/** Group id to option id, as the module named them. */
export type Choice = Record<string, string>

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
      if (wanted !== undefined && wanted !== '') settled[group.id] = wanted
      continue
    }
    const known = wanted !== undefined && group.options.some((option) => option.id === wanted)
    /* `fallback` is optional on the type because a text group has none, and a
       choice group without one cannot reach here — the protocol's own schema
       refuses it. Defaulted rather than asserted, because "cannot" is a
       property of a schema somebody may edit. */
    settled[group.id] = known ? wanted : (group.fallback ?? '')
  }
  return settled
}

/**
 * What should be WRITTEN DOWN after a press, which is not the same thing.
 *
 * `chosen` fills in every group, because a module has to be told about all of
 * them. This drops every group that is on its resting option, because a store
 * full of "this one is at its default" is a store that cannot tell a person who
 * chose the default from a person who never chose anything — and only one of
 * those should survive the module changing its mind about what the default is.
 *
 * It also drops any group the module is not offering, which is where a value
 * from an older version of a module finally stops being carried. Reconciling on
 * READ alone would leave it in the database forever, invisible, waiting to come
 * back to life if that option ever returned under the same spelling — attached
 * to a press somebody made two versions ago.
 *
 * That pruning is why this takes the offer and is only ever called when there
 * is one. A module that is not running offers nothing, and pruning against
 * nothing would silently forget every filter on the canvas the moment somebody
 * restarted the host with a module asleep.
 */
export function settle(offer: readonly FilterGroup[], choice: Choice): Choice {
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
      if (wanted !== '') kept[group.id] = wanted.slice(0, LIMITS.FILTER_TEXT)
      continue
    }
    if (wanted === group.fallback) continue
    if (!group.options.some((option) => option.id === wanted)) continue
    kept[group.id] = wanted
  }
  return kept
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
    if (group.kind === 'text') return true
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
 * those would otherwise be a write to the arrangement and a `roadmap.context`
 * to every frame on the canvas.
 *
 * `Object.hasOwn` rather than `in`: both of these are keyed by strings a framed
 * module invented, and `'constructor' in b` is true of every object there has
 * ever been.
 */
export function sameChoice(a: Choice, b: Choice): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
}
