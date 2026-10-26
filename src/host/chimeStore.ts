import { useSyncExternalStore } from 'react'

import { DEFAULT_CHIME, chimeFrom, type ChimeSettings } from './chime.ts'
import { forgetRead } from './hostRead.ts'

/**
 * The page's one copy of the chime settings, so the Inbox's mute button, the
 * Settings window and the thing that plays all see the same switch. The host
 * keeps the truth (`server/chime.ts`); this is what it last said. Nothing here
 * is written to the browser.
 */

let held: ChimeSettings = DEFAULT_CHIME
const listeners = new Set<() => void>()

export const chimeNow = (): ChimeSettings => held
export function setChime(next: ChimeSettings): void {
  held = next
  for (const one of [...listeners]) one()
}
export function subscribeChime(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
export const useChimeSettings = (): ChimeSettings => useSyncExternalStore(subscribeChime, chimeNow, chimeNow)

/** The settings answer's chime, kept; an older host that says none leaves the default. */
export function adoptChime(stored: unknown): void {
  if (stored !== undefined) setChime(chimeFrom(stored))
}

interface Answer {
  ok?: boolean
  why?: string
  said?: string
  chime?: unknown
}

async function send(path: string, body: unknown): Promise<Answer> {
  const response = await globalThis.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const answer = (await response.json().catch(() => null)) as Answer | null
  if (!response.ok || !answer?.ok) throw new Error(answer?.why ?? 'The host did not take that change.')
  forgetRead('settings')
  adoptChime(answer.chime)
  return answer
}

/** A change of the chime settings (`POST /host/settings`, `{ chime }`). The answer replaces the copy. */
export const postChime = (change: object): Promise<Answer> => send('/host/settings', { chime: change })

/**
 * Mute or unmute. The copy changes at once so the button answers the press; if the host does not take it, the
 * copy goes back and the error is thrown.
 */
export async function setMuted(muted: boolean): Promise<void> {
  const was = held
  setChime({ ...held, on: !muted })
  try {
    await postChime({ on: !muted })
  } catch (error) {
    setChime(was)
    throw error
  }
}

/** Add a clip: its bytes, as the page decoded them, and how long they are. */
export async function addSound(name: string, bytes: ArrayBuffer, seconds: number): Promise<{ id: string }> {
  let binary = ''
  const view = new Uint8Array(bytes)
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000))
  const answer = (await send('/host/sounds', { name, data: btoa(binary), seconds })) as Answer & { sound?: { id: string } }
  return { id: answer.sound?.id ?? '' }
}
export const renameSound = (id: string, name: string) => send('/host/sounds/rename', { id, name })
/** Remove a clip; the answer's `said` tells what went back to a default. */
export const removeSound = (id: string) => send('/host/sounds/remove', { id })
