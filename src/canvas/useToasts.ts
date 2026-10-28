import { useRef } from 'react'

import { chimeNow } from '@/host/chimeStore.ts'
import { Gather, toastOf, type Arrival } from '@/host/toasts.ts'
import { useToastList } from './InboxToasts.tsx'

/**
 * The page's toast: arrivals in (`offer`), at most one toast out per burst.
 * It is told by the same news as the chime (`offer` is called beside
 * `chime.offer`), and at the moment of showing it asks the chime's own
 * question, `plays` — only the window that would sound shows the toast — and
 * the setting "Show a toast for new Inbox items". Mute is not asked: the
 * sound and the toast are separate switches.
 */
export function useToasts(plays: () => boolean) {
  const list = useToastList()
  const playsRef = useRef(plays)
  playsRef.current = plays
  const addRef = useRef(list.add)
  addRef.current = list.add
  const gather = useRef<Gather | null>(null)
  if (!gather.current) {
    gather.current = new Gather((batch) => {
      if (!chimeNow().toast) return
      if (!playsRef.current()) return
      addRef.current((id) => toastOf(id, batch))
    })
  }
  return { toasts: list.toasts, close: list.close, offer: (arrival: Arrival) => gather.current?.offer(arrival) }
}
