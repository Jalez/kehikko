import { useCallback, useEffect, useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { SharedAddress, SharedLocation } from 'kehikot-module-protocol'
import type { PressNote } from '@/canvas/HeaderMenus.tsx'
import type { StorageViews } from '@/canvas/Storage.tsx'
import { answerPress, postHeaders, type PressOrder } from '@/host/canvases.ts'
import { agentFooterRefusal, footerPressing, footerShape, readoutsWait, type Footers as HeldFooters } from '@/host/footer.ts'
import type { FooterStore } from '@/host/footerStore.ts'
import { agentRefusal, headerPosting, NO_HEADER, NOTHING_POSTED, pressing, type Headers, type Pressed, type Pressing } from '@/host/header.ts'
import type { Presses } from '@/host/presses.ts'
import type { Presence } from '@/host/registry.ts'
import { storageViewOf } from '@/host/storage.ts'

/** How long the page waits after a module's header changed before posting the whole map. */
const HEADERS_SETTLE_MS = 250

/*
 * A module's header and footer, as the page holds them: pressed by the person
 * or by an agent (`useHeaderPresses`), and said to the server so that
 * `read_canvas` and `press_item` can read them (`useHeaderPosting`). The rules
 * are `host/header.ts` and `host/footer.ts`; what is here is the page's half.
 *
 * Moved out of `App.tsx` as it was, in two hooks called where their parts
 * stood. An agent's press is still judged twice: by the server against what
 * the page posted (`server/headers.ts`), and here against what the frame
 * itself declared (`agentRefusal`, in `orderedRef`).
 */

export interface HeaderPressInputs {
  headers: Headers
  headersRef: { readonly current: Headers }
  footerStore: FooterStore
  presses: Presses
  byIdRef: { readonly current: ReadonlyMap<string, Presence> }
  /** The open kehikko as drawn, read at the moment of an agent's press. */
  openRef: { readonly current: { id: number; placements: readonly { i: string }[] } | null }
  setPressNotes: Dispatch<SetStateAction<Readonly<Record<string, PressNote>>>>
  /* Assigned here: an agent's `press_item`, handed to this page by the stream. */
  orderedRef: MutableRefObject<((order: PressOrder) => void) | null>
}

/** A press on a header or footer item, the person's or an agent's. It runs no effect. */
export function useHeaderPresses({ headers, headersRef, footerStore, presses, byIdRef, openRef, setPressNotes, orderedRef }: HeaderPressInputs) {
  const onPressItem = useCallback(
    (id: string, press: Pressing): Promise<Pressed> =>
      pressing(headersRef.current[id] ?? NO_HEADER, press, byIdRef.current.get(id)?.name ?? id, (one) => presses.item(id, one)),
    [presses],
  )
  /* A press on a footer item: the same road, judged against the footer and sent with `place: 'footer'`. */
  const onFooterPressItem = useCallback(
    (id: string, press: Pressing): Promise<Pressed> =>
      footerPressing(footerStore.get(id), press, byIdRef.current.get(id)?.name ?? id, (one) => presses.item(id, one)),
    [presses, footerStore],
  )

  /**
   * The modules on this kehikko that offer their own storage view (a header
   * switch or go with a `storage` option), for the Storage dialog, and the
   * press that opens one — the same press a person makes in its menu.
   */
  const storageViews = useMemo<StorageViews>(
    () => ({
      of: (module) => storageViewOf(headers[module]) !== null,
      open: (module) => {
        const press = storageViewOf(headersRef.current[module])
        return press ? onPressItem(module, press) : Promise.resolve({ ok: false, why: 'That module no longer offers a storage view here.' })
      },
    }),
    [headers, onPressItem],
  )

  /**
   * An agent's `press_item`, made by this page.
   *
   * The door is on the server and the module's frame is here, so the server
   * hands the press to the one page it chose (`server/headers.ts`) and waits
   * for this page's answer. It travels the same road as a person's press from
   * here on — `onPressItem` — after one more question the server has already
   * asked: may an agent press this at all (`agentRefusal`). Asked again here
   * because what the server judged is what this page POSTED, and what is held
   * here is what the frame itself declared: the only copy a module wrote.
   * Something that talked the server into believing an item was marked for
   * agents has still not got it pressed.
   *
   * Nothing about the arrangement is touched: no container is moved, folded,
   * selected or added by a press.
   */
  const made = useRef<string[]>([])
  /* When an agent's press was last handed to each module (protocol 2.28.0, `host/navigate.ts`). */
  const agentPressedAt = useRef(new Map<string, number>())
  orderedRef.current = (order) => {
    /* A page mid-reconnect has two streams for a moment and hears an order on
       both. One press. */
    if (made.current.includes(order.id)) return
    made.current = [...made.current.slice(-31), order.id]
    void (async () => {
      const canvas = openRef.current
      const press: Pressing = { item: order.item, ...(order.value === undefined ? {} : { value: order.value }), ...(order.text === undefined ? {} : { text: order.text }) }
      /* Protocol 2.38.0: an order may be for an item of the module's footer, judged against what the frame declared for it. */
      const footer = order.place === 'footer'
      const items = footer ? footerStore.all()[order.module] : headersRef.current[order.module]
      const refused =
        !canvas || canvas.id !== order.kehikko
          ? `The page that was asked does not have kehikko ${order.kehikko} open any more, so nothing was pressed.`
          : !canvas.placements.some((placement) => placement.i === order.module)
            ? `${order.module} is not on kehikko ${order.kehikko} any more, so nothing was pressed.`
            : !items
              ? `${order.module} has declared no ${footer ? 'footer' : 'header'} on the page, so there is nothing to press.`
              : footer
                ? agentFooterRefusal(footerStore.get(order.module), press, order.module)
                : agentRefusal(headersRef.current[order.module] ?? NO_HEADER, press, order.module)
      /* Noted before the press reaches the module: what it asks next is an agent's doing, and may
         not switch project (`personsPressRefusal`). */
      if (!refused) agentPressedAt.current.set(order.module, Date.now())
      const came: Pressed = refused ? { ok: false, why: refused } : await (footer ? onFooterPressItem : onPressItem)(order.module, press)
      if (came.ok) {
        const found = items?.find((item) => item.id === order.item)
        const label = found && 'label' in found ? found.label : order.item
        setPressNotes((was) => ({
          ...was,
          [order.module]: { n: (was[order.module]?.n ?? 0) + 1, item: order.item, text: `an agent pressed ${label}` },
        }))
      }
      await answerPress(order.id, came)
    })()
  }

  return { onPressItem, onFooterPressItem, storageViews, agentPressedAt }
}

export interface HeaderPostingInputs {
  open: { placements: readonly { i: string }[] } | null
  openId: number | null
  headers: Headers
  footerStore: FooterStore
  /** The code location and the address on the open kehikko, by value. */
  codeAt: string
  addressAt: string
  /* Assigned here: say it all again, for a stream that reopened. */
  repostRef: MutableRefObject<(() => void) | null>
}

/** What is declared on the open kehikko, posted to the server a moment after it changes. */
export function useHeaderPosting({ open, openId, headers, footerStore, codeAt, addressAt, repostRef }: HeaderPostingInputs) {
  /**
   * What the modules on the open kehikko have declared, said to the server.
   *
   * So that `read_canvas` can list a container's header items and
   * `press_item` can refuse before anything is pressed. Only the open
   * kehikko's containers: a page loaded for the kehikko next door is declared
   * too, and is not what anybody is looking at. Posted whole whenever it
   * changes, and again when the stream reopens — a server that restarted
   * has forgotten it.
   */
  const declaredHere = useMemo(() => {
    if (!open) return null
    const on: [string, Headers[string]][] = []
    for (const placement of open.placements) {
      const items = headers[placement.i]
      if (items) on.push([placement.i, items])
    }
    return JSON.stringify(on)
  }, [open, headers])
  /* And their footers, posted with them (protocol 2.38.0): read from the store when posting, so a
     ticking readout costs this page no render (`host/footerStore.ts`). */
  const footedNow = useCallback((): string => {
    if (!open) return '[]'
    const held = footerStore.all()
    const on: [string, HeldFooters[string]][] = []
    for (const placement of open.placements) {
      const items = held[placement.i]
      if (items && items.length) on.push([placement.i, items])
    }
    return JSON.stringify(on)
  }, [open, footerStore])
  /* What this page last posted: a posting that says what the server already holds is not made
     (`headerPosting`), unless the stream reopened and the server may have forgotten it. */
  const postedRef = useRef(NOTHING_POSTED)
  /* And what it said less its footers' readouts (`footerShape`), and when: a change to readouts
     alone is posted at most every `READOUTS_POSTED_EVERY_MS` (`readoutsWait`). */
  const shapePostedRef = useRef(NOTHING_POSTED)
  const postedAtRef = useRef(0)
  /** Post what is declared now; or, for a change to readouts alone that came too soon, how many ms until it may be. */
  const postDeclared = useCallback((again = false): number => {
    if (openId === null || declaredHere === null) return 0
    const footedHere = footedNow()
    const base = headerPosting(openId, declaredHere, codeAt, addressAt)
    const said = footedHere === '[]' ? base : JSON.stringify([base, footedHere])
    if (!again && said === postedRef.current) return 0
    const shape = footedHere === '[]' ? base : JSON.stringify([base, footerShape(footedHere)])
    const wait = again ? 0 : readoutsWait(shape === shapePostedRef.current, Date.now() - postedAtRef.current)
    if (wait > 0) return wait
    postedRef.current = said
    shapePostedRef.current = shape
    postedAtRef.current = Date.now()
    void postHeaders(
      openId,
      Object.fromEntries(JSON.parse(declaredHere) as [string, Headers[string]][]),
      codeAt ? (JSON.parse(codeAt) as SharedLocation) : null,
      addressAt ? (JSON.parse(addressAt) as SharedAddress) : null,
      Object.fromEntries(JSON.parse(footedHere) as [string, HeldFooters[string]][]),
    )
    return 0
  }, [openId, declaredHere, footedNow, codeAt, addressAt])
  /* A moment after the last change: the modules of a kehikko greet one after another, and each
     greeting is a change, but one posting of the whole map says all of them. */
  useEffect(() => {
    let later: ReturnType<typeof setTimeout> | null = null
    const post = () => {
      later = null
      const wait = postDeclared()
      if (wait > 0) later = setTimeout(post, wait)
    }
    const soon = () => {
      if (later) clearTimeout(later)
      later = setTimeout(post, HEADERS_SETTLE_MS)
    }
    soon()
    /* A footer changing is a change too, told by the store rather than by a render. */
    const stop = footerStore.subscribe(soon)
    return () => {
      stop()
      if (later) clearTimeout(later)
    }
  }, [postDeclared, footerStore])
  repostRef.current = () => void postDeclared(true)
}
