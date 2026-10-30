import { useCallback, useEffect, useRef, useState } from 'react'

import type { Place } from '@/host/jump.ts'
import {
  editPinned,
  fetchPinned,
  isPinChord,
  pinnedHere,
  placeOf,
  type PinEdit,
  type PinnedPlace,
  type PinTarget,
} from '@/host/pinnedPlaces.ts'

/** What the bar is given to draw the pinned places and the Pin button. See `PinnedPlaces.tsx`. */
export interface PinnedView {
  places: readonly PinnedPlace[]
  /** The pin of the place on screen, or null when it is not pinned. */
  here: PinnedPlace | null
  /** Whether there is a place on screen to pin (a project is open). */
  canPin: boolean
  onGo(pin: PinnedPlace): void
  onUnpin(id: number): void
  onOrder(ids: number[]): void
  onToggle(): void
  /** The menu opened: read the pins again, so a gone project or epic is said now. */
  onOpen(): void
}

export interface PinnedDeps {
  /** The place on screen as a pin's target (`targetOf`), or null with no project open. */
  here: PinTarget | null
  /** Go there as the person's own pickers go: `goPlace` in `App.tsx`. */
  go(place: Place): void
  /** Say a refusal on the host's error line. */
  trouble(why: string): void
}

/**
 * The pinned places: read once, again when the menu opens and when the window
 * comes back to the front, and changed only by the person's presses (and
 * Alt+Shift+P). The store is the server's (`server/pinnedPlaces.ts`); the page
 * holds the last answer and nothing else.
 */
export function usePinnedPlaces(deps: PinnedDeps): PinnedView {
  const depsRef = useRef(deps)
  depsRef.current = deps
  const [places, setPlaces] = useState<readonly PinnedPlace[]>([])

  const read = useCallback(() => {
    fetchPinned()
      .then(setPlaces)
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    read()
    window.addEventListener('focus', read)
    return () => window.removeEventListener('focus', read)
  }, [read])

  const edit = useCallback((change: PinEdit) => {
    editPinned(change)
      .then(setPlaces)
      .catch((error: Error) => depsRef.current.trouble(`The pinned places were not changed: ${error.message}`))
  }, [])

  const here = pinnedHere(places, deps.here)
  const hereRef = useRef(here)
  hereRef.current = here

  const onToggle = useCallback(() => {
    const at = depsRef.current.here
    if (!at) return
    const pinned = hereRef.current
    edit(pinned ? { unpin: pinned.id } : { pin: at })
  }, [edit])

  /* Alt+Shift+P pins or unpins the place on screen. By `code`, as the Inbox's
     Alt+Shift+N is, so the Option key's dead keys on a Mac do not matter; not
     in a text field. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPinChord(event)) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      event.preventDefault()
      onToggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onToggle])

  return {
    places,
    here,
    canPin: deps.here !== null,
    onGo: (pin) => {
      if (pin.stale) return
      depsRef.current.go(placeOf(pin.target))
    },
    onUnpin: (id) => edit({ unpin: id }),
    onOrder: (ids) => {
      /* Drawn in the new order at once; the server's answer replaces it. */
      setPlaces((was) => ids.flatMap((id) => was.filter((one) => one.id === id)))
      edit({ order: ids })
    },
    onToggle,
    onOpen: read,
  }
}
