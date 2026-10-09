import { JOURNEYS_MODULE } from 'kehikot-module-protocol'

import { SQUEEZED_ROWS } from './columns.ts'
import type { OfficialModule } from './official.ts'

/**
 * An epic that is not divided into parts, and the one press that gets a
 * person to where it is divided.
 *
 * ## Why the bar says anything about an epic with no parts
 *
 * `Parts.tsx` used to draw nothing for one. The argument was that there is
 * nothing to explain — "an epic with no parts has no narrower question to
 * ask" — and it was wrong in the way that mattered. The person this was built
 * for had a thesis, a chapter to a file, and had been told they could tick the
 * chapters they wanted to see. They opened the thesis and saw no such control
 * anywhere, because nothing had been divided yet; nothing on screen said
 * parts existed, and nothing said where one is made. A feature whose entry is
 * invisible until it has been used once has no entry.
 *
 * So the control is always there for an open epic. With parts it is the
 * picker. With none it says so, in one sentence, and offers one press.
 *
 * ## The host still writes no part
 *
 * Parts are the Journeys module's: they are the `groups` of its journey
 * record, and it is the only program that makes, rewords or removes one. That
 * does not change here and must not — a second writer of one file is two
 * derivations of a part's id, which is the disagreement `host/parts.ts`
 * describes having deleted. What the host adds is a way THERE: it finds
 * Journeys, puts it in front of the person, and asks it to open the place.
 *
 * ## How Journeys is asked: `kehikot.goto`, with a reference that is a place
 *
 * Three ways for a host to point a module at something were looked at.
 *
 *  - **A field in `kehikot.context`.** State. It would be re-sent with every
 *    context and on every reload, so a canvas would reopen a module's parts
 *    box each time the page loaded. A press is not state; `presses.ts` has
 *    the argument in full.
 *  - **The frame's location**, `/app#epic=x&parts=open`. A page may set that
 *    across origins, and Journeys reads a fragment. It says nothing back, so
 *    an older Journeys ignores it in silence, and set from outside it can
 *    reload a document somebody is typing a step into.
 *  - **`kehikot.goto`.** The message the protocol has for exactly this — "walk
 *    to this, on your own page" — and the only one of the three that is
 *    ANSWERED: `kehikot.went`, found or not and why. A Journeys that knows
 *    the reference opens its parts and says so; one that predates it looks
 *    for a card of that name, finds none, and says THAT, which this host can
 *    put in front of the person instead of a press that did nothing.
 *
 * So it is a walk, naming `PARTS_REF`: a reference no tracker issues, which
 * Journeys reads as "the place this epic is divided". It lands on the parts
 * box when the project keeps a journey for the epic, and on the offer to
 * begin one and divide it when it does not; which of the two is Journeys' to
 * know.
 *
 * `PARTS_REF` is spelled here and in Journeys (`wire/methods.ts`), and two
 * spellings of one word in two repositories is the thing this workspace keeps
 * being bitten by. It is a constant for the protocol, beside
 * `JOURNEYS_MODULE`. The protocol was not changed in the task that added
 * this.
 *
 * ## Three places Journeys can be, and each gets the right press
 *
 * On this kehikko; registered and not on it; not installed. The press is the
 * same intention every time — "take me there" — so it is ONE press in every
 * case, and what differs is how much the host does first: nothing, put the
 * container on the kehikko, or install the module and then put it there.
 * `nextMove` is that sequence, one step at a time, re-read after each.
 *
 * ## A kehikko still never carries the focus
 *
 * Nothing here touches which parts are picked. Putting Journeys on a kehikko
 * is an arrangement, and is stored where arrangements are; the parts and the
 * focus on them stay the project's, per epic, as they were.
 *
 * Pure: no `window`, no `fetch`. The effect that runs these moves is
 * `canvas/Dividing.ts`.
 */

/** The module that makes parts. The protocol's own spelling of its id. */
export const MAKER = JOURNEYS_MODULE

/** What it is called before anything has said its name. */
export const MAKER_NAME = 'Journeys'

/** The reference Journeys reads as "where this epic is divided into parts". See the essay above. */
export const PARTS_REF = 'journeys:parts'

/** How long a walk is retried while a container that was just placed loads its page. */
export const WALK_WITHIN_MS = 25_000

/** Where the module that makes parts is, from where the person is standing. */
export type Maker =
  /** On the open kehikko. `collapsed` is whether its container is folded to a header. */
  | { at: 'here'; name: string; collapsed: boolean }
  /** Registered on this computer, and not on the open kehikko. */
  | { at: 'elsewhere'; name: string }
  /** On the official list and not installed. `step` while it is installing; `failed` when that stopped. */
  | { at: 'shelf'; name: string; step: string | null; failed: string | null }
  /** Not registered, and the official list has not been read yet. */
  | { at: 'looking'; name: string }
  /** Not registered and not on the list: there is nothing this host can press. */
  | { at: 'nowhere'; name: string; why: string | null }

/**
 * Where Journeys is.
 *
 * `registered` is every module the sweep found, running or not: a module that
 * is registered and asleep is still one this host can put on a kehikko, and
 * waking it is what placing it does. `official` is null until the list has
 * been asked for, and `unread` is why it could not be.
 */
export function makerOf(
  registered: readonly { id: string; name?: string }[],
  placements: readonly { i: string; collapsed?: boolean }[],
  official: readonly OfficialModule[] | null,
  unread: string | null = null,
): Maker {
  const known = registered.find((one) => one.id === MAKER)
  const listed = official?.find((one) => one.id === MAKER)
  const name = known?.name ?? listed?.name ?? MAKER_NAME
  const placed = placements.find((one) => one.i === MAKER)
  if (known && placed) return { at: 'here', name, collapsed: placed.collapsed === true }
  if (known) return { at: 'elsewhere', name }
  if (listed && !listed.installed) {
    return {
      at: 'shelf',
      name,
      step: listed.install?.state === 'installing' ? listed.install.step : null,
      failed: listed.install?.state === 'failed' ? listed.install.why : null,
    }
  }
  /* Installed, by the list's account, and not yet in the registry: the sweep
     that finds its registration has not run. Still looking, not nowhere. */
  if (listed?.installed) return { at: 'looking', name }
  if (official === null && unread === null) return { at: 'looking', name }
  return { at: 'nowhere', name, why: unread }
}

/** What the host does next to get a person to the parts. One step; asked again after it. */
export type Move = 'install' | 'wait' | 'place' | 'unfold' | 'walk' | 'stop'

/**
 * The next step toward Journeys with its parts open.
 *
 * A function of where Journeys is NOW, and nothing remembered: after each
 * step the world is read again — the registry swept, the kehikko re-read —
 * and this is asked again. That is what lets one press carry through an
 * install that takes a minute without a script that assumes what the minute
 * produced.
 */
export function nextMove(maker: Maker): Move {
  if (maker.at === 'here') return maker.collapsed ? 'unfold' : 'walk'
  if (maker.at === 'elsewhere') return 'place'
  if (maker.at === 'shelf') return maker.step !== null ? 'wait' : maker.failed !== null ? 'stop' : 'install'
  if (maker.at === 'looking') return 'wait'
  return 'stop'
}

/** A press in flight, as the bar draws it; null when none is. */
export type Going = { epic: string; step: 'installing' | 'placing' | 'opening' } | null

/**
 * What the bar says about an epic with no parts, and what its one press is
 * called. Data, so it can be asserted without a DOM, as `focusSaid` is.
 *
 * `press` is null when there is nothing to press: Journeys cannot be found,
 * or the list is still being read. `trouble` is what the last press came to
 * when it did not arrive, in a sentence; it stands until the next press.
 */
export function undividedSaid(
  maker: Maker,
  going: Going = null,
  trouble: string | null = null,
): { label: string; hint: string; lead: string; where: string; press: string | null; busy: boolean; trouble: string | null } {
  const name = maker.name
  const lead =
    'This epic is not divided into parts yet. A part is a heading — a chapter of the paper, a seam of the work — and '
    + 'once there are some, they are ticked here to point every module at those only.'
  const base = { label: 'no parts', hint: 'this epic is not divided into parts yet — press to see where that is done', lead }

  if (going) {
    const doing =
      going.step === 'installing'
        ? `Installing ${name}${maker.at === 'shelf' && maker.step ? ` — ${maker.step}` : ''}… It is put on this kehikko and opened on this epic’s parts when it is ready.`
        : going.step === 'placing'
          ? `Putting ${name} on this kehikko…`
          : `Opening this epic’s parts in ${name}…`
    return { ...base, where: doing, press: null, busy: true, trouble: null }
  }

  if (maker.at === 'here') {
    return {
      ...base,
      where: `Parts are made in ${name}, which is on this kehikko.`,
      press: `divide this epic into parts in ${name}`,
      busy: false,
      trouble,
    }
  }
  if (maker.at === 'elsewhere') {
    return {
      ...base,
      where: `Parts are made in ${name}, which is not on this kehikko.`,
      press: `put ${name} here and divide this epic into parts`,
      busy: false,
      trouble,
    }
  }
  if (maker.at === 'shelf') {
    if (maker.step !== null) {
      return { ...base, where: `Parts are made in ${name}, which is being installed — ${maker.step}…`, press: null, busy: true, trouble }
    }
    return {
      ...base,
      where: `Parts are made in ${name}, which is not installed on this computer.`,
      press: maker.failed !== null ? `try installing ${name} again` : `install ${name} and divide this epic into parts`,
      busy: false,
      trouble: maker.failed !== null ? `${name} did not install: ${maker.failed}` : trouble,
    }
  }
  if (maker.at === 'looking') {
    return { ...base, where: `Parts are made in ${name}. Looking for it…`, press: null, busy: true, trouble }
  }
  return {
    ...base,
    where:
      `Parts are made in ${name}, and this host cannot find it: it is not registered on this computer`
      + (maker.why ? `, and the list of modules it could install could not be read (${maker.why}).` : ' and is not on the list of modules it can install.'),
    press: null,
    busy: false,
    trouble,
  }
}

/**
 * What to say when Journeys answered a walk and did not open its parts.
 *
 * `why` is the module's own sentence. It is quoted, not paraphrased: the most
 * likely reason is a Journeys from before it knew `PARTS_REF`, whose answer
 * is about a card it could not find, and the person can do in one press
 * inside the module what the host could not do from outside.
 */
export function unopenedSaid(name: string, why: string): string {
  const said = why.trim()
  return (
    `${name} is on this kehikko and did not open its parts${said ? ` — it answered “${said}”` : ''}. `
    + `Press “divide into parts” in ${name} itself; if there is no such press, it is an older ${name} and wants updating.`
  )
}

/** What to say when Journeys was put on the kehikko and never answered. */
export function unansweredSaid(name: string): string {
  return (
    `${name} is on this kehikko and has not answered yet, so its parts were not opened. When its container has loaded, `
    + `press “divide into parts” in it — or press this again.`
  )
}

/**
 * Whether the container a person was just sent to is too short to work in.
 *
 * `rows` is what the column grants it (`granted` in `columns.ts`), or null
 * when it is not on the kehikko. A column is a fixed budget handed out from
 * the top, so a Journeys under a paper that fills the screen is drawn at the
 * floor — three rows, a header and a line — and that is where the press
 * lands: on the right place, opened, in a strip nobody can read a list of
 * chapters in. The host does not take rows from the container above to fix
 * that; whose rows they are is the person's to say, with a drag. It says so.
 */
export function cramped(rows: number | null): boolean {
  return rows !== null && rows <= SQUEEZED_ROWS
}

/** What to say when the press arrived in a container squeezed to its floor. */
export function crampedSaid(name: string): string {
  return (
    `${name} is open on this epic’s parts, in a container only a few rows tall. `
    + `Give it height to work in: drag the bottom corner of the container above it up, or its own corner down.`
  )
}
