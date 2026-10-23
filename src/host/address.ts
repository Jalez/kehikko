import {
  LIMITS,
  addressLabel,
  addressRefusal,
  sharedAddressSchema,
  type AddressIntent,
  type AddressOpenResult,
  type SharedAddress,
} from 'kehikot-module-protocol'

/**
 * A web address handed to a kehikko to be shown (protocol 2.16.0).
 *
 * A module calls `address.open` with a page that is not a tracker ref — a
 * design document, a deployed preview, a dashboard, a pipeline log. The sender
 * names the address and nothing else. What the host does depends on what is on
 * the open kehikko:
 *
 * - A container whose module says it shows pages (`reacts: ['address']`, the
 *   Browser) is a READER. With one, the address goes into `context.address` on
 *   that kehikko, stamped with who asked (`by`, out of the registration, never
 *   the frame's word) and when (`at`), and the answer is `shown`. The reader
 *   opens it when the `at` is new to it.
 * - With none, nothing is opened. The address is put in front of the person as
 *   an OFFER — open it in their own browser (`https:` only, `openExternal`), or
 *   add a module that shows pages to this kehikko, which then opens it — and the
 *   answer is `offered`. Nothing leaves the canvas without a person's press.
 * - An agent's `open_address` at the host's door is held tighter: it is taken
 *   only into a reader on the kehikko. With none it is declined and nothing is
 *   offered, so an agent cannot put a page in front of the person, or out into
 *   their browser, by itself.
 *
 * ## Where it is kept
 *
 * In the page, in memory, by kehikko id — never `kehikot.json`, never the
 * canvases database, and not `sessionStorage` either: opening a page is a
 * request made once, and a reload is not the person asking again. The page
 * also tells the server (`POST /host/headers`, beside the code location) so
 * `read_canvas` can say the last address.
 *
 * Pure, so `test/address.test.ts` is a table.
 */

/** The last address on each kehikko, by kehikko id. */
export type Addresses = Readonly<Record<number, SharedAddress>>

export const NO_ADDRESSES: Addresses = {}

/** The one reaction a host reads: a module that shows pages. */
export const SHOWS_PAGES = 'address'

/** Who asked for an address to be shown. */
export type Asker = { by: string } | { agent: true }

export interface Handing {
  kehikko: number
  url: string
  title?: string
  intent?: AddressIntent
  asker: Asker
  /** When, ISO 8601. */
  at: string
  /** The containers on that kehikko whose modules show pages (`readersOn`). */
  readers: readonly string[]
}

/**
 * An address put in front of the person because nothing on the kehikko shows
 * pages. Held by the page until the person answers it or it is replaced.
 */
export interface Offer {
  kehikko: number
  url: string
  title?: string
  /** The module that asked, out of its registration. */
  by: string
  at: string
}

export interface Handed {
  next: Addresses
  answer: AddressOpenResult
  /** What to put in front of the person, when nothing on the kehikko shows pages. */
  offer: Offer | null
}

/**
 * The stamp for a new hand-over: `at`, or one millisecond after the last one on
 * that kehikko when the clock has not moved. Two calls in one millisecond are
 * two requests, and a reader tells them apart by `at` alone.
 */
export function freshAt(at: string, before: string | undefined): string {
  if (before === undefined) return at
  const now = Date.parse(at)
  const was = Date.parse(before)
  if (Number.isNaN(now) || Number.isNaN(was) || now > was) return at
  return new Date(was + 1).toISOString()
}

/**
 * A module or an agent handed an address to a kehikko. `next` is the same
 * object when nothing changed.
 */
export function handed(was: Addresses, handing: Handing): Handed {
  const { kehikko, url, title, intent, asker, at, readers } = handing
  /* The protocol's schema already refused a bad address; asked again because an
     agent's call arrives here by another road, and this is the one that decides. */
  const refusal = addressRefusal(url)
  if (refusal !== null) return { next: was, answer: { outcome: 'declined', why: refusal.slice(0, LIMITS.REASON) }, offer: null }

  if (!readers.length) {
    if ('agent' in asker) {
      return {
        next: was,
        answer: {
          outcome: 'declined',
          why:
            'Nothing on this kehikko shows pages, so the address was not opened anywhere. An agent may open an address only '
            + 'in a module that shows pages on the kehikko (the Browser): place one with place_modules, or give the person the address.',
        },
        offer: null,
      }
    }
    return {
      next: was,
      answer: {
        outcome: 'offered',
        why: 'Nothing on this kehikko shows pages, so the person was asked whether to open it in their browser or add a module that shows pages.',
      },
      offer: { kehikko, url, ...(title === undefined ? {} : { title }), by: asker.by, at },
    }
  }

  const shared = sharedAddressSchema.safeParse({
    url,
    ...(title === undefined ? {} : { title }),
    intent: intent ?? 'show',
    ...asker,
    at: freshAt(at, was[kehikko]?.at),
  })
  if (!shared.success) return { next: was, answer: { outcome: 'declined', why: 'That address will not go into a context.' }, offer: null }
  return { next: { ...was, [kehikko]: shared.data }, answer: { outcome: 'shown', why: '' }, offer: null }
}

/**
 * The person pressed "Add <module> to this kehikko" on an offer: the address
 * goes into the context, signed by the module that asked, so the module just
 * placed opens it when it arrives.
 */
export function accepted(was: Addresses, offer: Offer, at: string): Addresses {
  const out = handed(was, {
    kehikko: offer.kehikko,
    url: offer.url,
    ...(offer.title === undefined ? {} : { title: offer.title }),
    asker: { by: offer.by },
    at,
    readers: ['the module just placed'],
  })
  return out.next
}

/**
 * Which containers on a kehikko show pages: those whose module says it reacts
 * to `address`. `reactsOf` answers what a module's manifest says, or
 * `undefined` when the host has not read it (a module still starting).
 */
export function readersOn(placed: readonly string[], reactsOf: (id: string) => readonly string[] | undefined): string[] {
  return placed.filter((id) => reactsOf(id)?.includes(SHOWS_PAGES) === true)
}

/** What a sweep says of one module, as far as `noteReacts` reads it. */
export interface Reacting {
  id: string
  /** Present when the module is answering. */
  module?: { reacts?: string[] } | undefined
  /** What the host knows of a module that is not answering: remembered, else the official list. */
  reactsKnown?: string[] | undefined
}

/**
 * Fold a sweep into what each module is known to react to, in `seen`. A module that is answering
 * says so itself, and that wins. One that is not answering yet — a Browser still starting — counts
 * by what the host knows of its manifest (`reactsKnown`), so it is a reader at once and an address
 * handed to the kehikko waits in the context for it to greet, rather than the person being told
 * that nothing shows pages. What was seen answering is never replaced by a guess.
 */
export function noteReacts(seen: Map<string, readonly string[]>, sweep: readonly Reacting[]): void {
  for (const presence of sweep) {
    if (presence.module?.reacts) seen.set(presence.id, presence.module.reacts)
    else if (!presence.module && presence.reactsKnown?.length && !seen.has(presence.id)) seen.set(presence.id, presence.reactsKnown)
  }
}

/** The address on one kehikko, or null. */
export function addressOn(addresses: Addresses, kehikko: number | null): SharedAddress | null {
  if (kehikko === null) return null
  return addresses[kehikko] ?? null
}

/** Whether "Open in your browser" may be offered for an address: `https:` only, as `openExternal` takes. */
export function opensOutside(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The words an offer says. The address and its title are a module's words:
 * text, never markup or a link (`AddressOffer` draws them as text).
 */
export function offerWords(offer: Offer, askerName: string, addable: readonly { id: string; name: string }[]) {
  const outside = opensOutside(offer.url)
  const label = addressLabel(offer)
  return {
    title: `${askerName} wants to show a page`,
    lede:
      addable.length > 0
        ? `Nothing on this kehikko shows pages. Add ${addable.map((one) => one.name).join(' or ')} here to open it on the canvas${outside ? ', or open it in your own browser' : ''}.`
        : outside
          ? 'Nothing on this kehikko shows pages, and no module that does is installed. You can open it in your own browser.'
          : 'Nothing on this kehikko shows pages, and no module that does is installed. This address is on this machine, so it is not opened in your browser from here.',
    label,
    outside,
  }
}

/** One line for `read_canvas`: the last address handed to this kehikko, by whom. */
export function addressWords(address: SharedAddress | null): string {
  if (!address) return 'address: none — no web address has been handed to this kehikko since the page opened.'
  const by = address.by ? `, handed over by ${address.by}` : address.agent ? ', handed over by an agent' : ''
  const at = address.at ? ` at ${address.at}` : ''
  /* The address and title are a module's words: one line, quoted, so they cannot forge a line of the answer. */
  const flat = (text: string) => text.replace(/\s+/g, ' ')
  const title = address.title ? ` "${flat(address.title)}"` : ''
  return `address: ${flat(address.url)}${title}${by}${at}. Every module on this kehikko is told it (context.address); a module that shows pages opens it.`
}
