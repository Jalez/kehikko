import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CLOSED_BAR, FIND_ANSWER_MS, KEY_DIALOGS, containerOf, findAsk, findBar, findKeyOf, type FindAct, type FindBar, type FindResult } from '@/host/find.ts'
import type { Presses } from '@/host/presses.ts'
import type { FindControls } from './Container.tsx'

/** Whether ⌘ (a Mac) or Ctrl is the find key on this machine. */
export const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(`${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`)

export interface Finds {
  /** Every container's bar, by module id; a container with none has `CLOSED_BAR`. */
  bars: Readonly<Record<string, FindBar>>
  open(id: string, how?: { query?: string; step?: 'next' | 'prev' }): void
  query(id: string, query: string): void
  setCase(id: string, caseSensitive: boolean): void
  step(id: string, direction: 'next' | 'prev'): void
  close(id: string): void
  /** What a page said a search came to (`kehikot.find.result`). */
  result(id: string, said: { id: string; total: number; current: number; unsupported: boolean }): void
}

/**
 * The find bars of a canvas (protocol 2.69.0): one per container, held by module id, with the
 * searches they send to the frames standing now (`presses.find`) and the keys heard on the host's
 * own page — ⌘F opens the bar of the container focus is in, or else the one picked out
 * (`target`); ⌘G and ⇧⌘G step. A key pressed inside a page arrives as `kehikot.find.open` and is
 * handed to `open` by the canvas. Every rule is `host/find.ts`'s.
 *
 * `askable(id)`: `false` for a module built before Find, which is not asked at all.
 */
export function useFinds(presses: Presses, askable: (id: string) => boolean | null, target: () => string | null): Finds {
  const [bars, setBars] = useState<Record<string, FindBar>>({})
  const held = useRef(bars)
  const askableRef = useRef(askable)
  askableRef.current = askable
  const targetRef = useRef(target)
  targetRef.current = target

  const change = useCallback((id: string, act: FindAct): FindBar => {
    const next = findBar(held.current[id] ?? CLOSED_BAR, act)
    if (next !== held.current[id]) {
      held.current = { ...held.current, [id]: next }
      setBars(held.current)
    }
    return next
  }, [])

  const send = useCallback(
    (id: string, direction: 'first' | 'next' | 'prev') => {
      const bar = held.current[id] ?? CLOSED_BAR
      if (!bar.open) return
      if (askableRef.current(id) === false) {
        change(id, { kind: 'asked', id: null })
        return
      }
      const asked = presses.find(id, findAsk(bar, direction))
      change(id, { kind: 'asked', id: asked })
      if (asked !== null) setTimeout(() => change(id, { kind: 'silent', id: asked }), FIND_ANSWER_MS)
    },
    [presses, change],
  )

  const finds = useMemo<Omit<Finds, 'bars'>>(() => {
    const open = (id: string, how: { query?: string; step?: 'next' | 'prev' } = {}) => {
      const was = held.current[id] ?? CLOSED_BAR
      const bar = change(id, { kind: 'open', ...(how.query ? { query: how.query } : {}) })
      if (how.step) send(id, how.step)
      else if (bar.query && (!was.open || bar.query !== was.query || bar.asked === null)) send(id, 'first')
    }
    return {
      open,
      query(id, query) {
        change(id, { kind: 'query', query })
        send(id, 'first')
      },
      setCase(id, caseSensitive) {
        change(id, { kind: 'case', caseSensitive })
        send(id, 'first')
      },
      step(id, direction) {
        const bar = held.current[id] ?? CLOSED_BAR
        if (!bar.open) {
          open(id, { step: direction })
          return
        }
        send(id, bar.asked === null ? 'first' : direction)
      },
      close(id) {
        const bar = held.current[id] ?? CLOSED_BAR
        if (!bar.open) return
        if (askableRef.current(id) !== false) presses.find(id, { ...findAsk(bar, 'close'), query: '' })
        change(id, { kind: 'close' })
        /* Back to the page the search was in. */
        presses.focus(id)
      },
      result(id, said) {
        const result: FindResult = said.unsupported ? 'unsupported' : { total: said.total, current: said.current }
        change(id, { kind: 'result', id: said.id, result })
      },
    }
  }, [change, send, presses])

  /* ⌘F on the host's own page: the container focus is in, or the one picked out. A key pressed in a
     dialog is the dialog's; one with no container to search is left to whatever else hears it. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const key = findKeyOf(event, MAC)
      if (key === null) return
      if (document.querySelector(KEY_DIALOGS)) return
      const id = containerOf(document.activeElement) ?? targetRef.current()
      if (id === null) return
      event.preventDefault()
      if (key === 'open') finds.open(id)
      else finds.step(id, key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [finds])

  return useMemo(() => ({ bars, ...finds }), [bars, finds])
}

/** One container's bar and what its controls do, for `Container` and `Expanded`. */
export function findControls(finds: Finds, id: string): FindControls {
  return {
    bar: finds.bars[id] ?? CLOSED_BAR,
    mac: MAC,
    onQuery: (query) => finds.query(id, query),
    onCase: (caseSensitive) => finds.setCase(id, caseSensitive),
    onStep: (direction) => finds.step(id, direction),
    onClose: () => finds.close(id),
  }
}
