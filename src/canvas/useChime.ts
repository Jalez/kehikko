import { useEffect, useRef } from 'react'

import { Burst, playsHere, soundFor, type Kind, type Peer } from '@/host/chime.ts'
import { playSound, unlockOnGesture } from '@/host/chimePlayer.ts'
import { adoptChime, chimeNow } from '@/host/chimeStore.ts'
import { fetchSettings } from './Settings.tsx'

const CHANNEL = 'kehikot-chime'
const HEARTBEAT_MS = 20_000

/**
 * The page's chime: events in (`offer`), at most one sound out. Four rules
 * live in `host/chime.ts` — the burst, the kinds, the module's own sound and
 * which window plays — and this only wires them to the page:
 *
 *  - the settings are read through `fetchSettings`, which the page already
 *    reads once at load, so the page asks the host for nothing more;
 *  - the sound is unlocked on the first pointer or key event;
 *  - windows of this app tell each other, over a BroadcastChannel (no storage),
 *    when they last had the focus, and only the most recent plays.
 */
export function useChime(): { offer(kind: Kind, module?: string): void; plays(): boolean } {
  const burst = useRef<Burst | null>(null)
  const self = useRef<Peer>({ id: Math.random().toString(36).slice(2, 10), focusedAt: 0, heardAt: 0 })
  const others = useRef(new Map<string, Peer>())

  if (!burst.current) {
    burst.current = new Burst((kind, module) => {
      const settings = chimeNow()
      if (!settings.on) return
      if (!plays()) return
      void playSound(soundFor(settings, kind, module), kind, settings)
    })
  }

  useEffect(() => {
    let cancelled = false
    void fetchSettings()
      .then((answer) => {
        if (!cancelled) adoptChime(answer.chime)
      })
      .catch(() => undefined)
    const lock = unlockOnGesture()

    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL)
    const tell = (hello = false) => {
      self.current.heardAt = Date.now()
      try {
        channel?.postMessage({ peer: self.current, hello })
      } catch {
        /* a closed channel */
      }
    }
    if (channel) {
      channel.onmessage = (event: MessageEvent) => {
        const data = event.data as { peer?: Peer; hello?: boolean; bye?: string } | null
        if (data?.bye) others.current.delete(data.bye)
        const peer = data?.peer
        if (peer && typeof peer.id === 'string' && peer.id !== self.current.id) {
          others.current.set(peer.id, { id: peer.id, focusedAt: Number(peer.focusedAt) || 0, heardAt: Date.now() })
          if (data?.hello) tell()
        }
      }
    }
    const focused = () => {
      self.current.focusedAt = Date.now()
      tell()
    }
    if (typeof document !== 'undefined' && document.hasFocus()) self.current.focusedAt = Date.now()
    window.addEventListener('focus', focused)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) focused()
    })
    tell(true)
    const beat = window.setInterval(() => tell(), HEARTBEAT_MS)
    const leave = () => {
      try {
        channel?.postMessage({ bye: self.current.id })
      } catch {
        /* closed */
      }
    }
    window.addEventListener('pagehide', leave)
    return () => {
      cancelled = true
      lock()
      window.clearInterval(beat)
      window.removeEventListener('focus', focused)
      window.removeEventListener('pagehide', leave)
      leave()
      channel?.close()
    }
  }, [])

  /* Whether this is the window that plays: the toast asks the same question. */
  const plays = () => playsHere(self.current, [...others.current.values()], Date.now())
  return { offer: (kind, module) => burst.current?.offer(kind, module), plays }
}
