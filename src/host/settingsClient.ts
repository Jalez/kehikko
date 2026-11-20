import { AGENT_SETUP_KEYS } from 'kehikot-module-protocol'
import { useCallback, useEffect, useRef, useState } from 'react'

import { openSettings, type SettingsAnswer, type SettingsSection } from './agentSettings.ts'
import type { Appearance, AppearancePatch } from './appearance.ts'
import { adoptAppearance } from './appearanceStore.ts'
import { forgetRead, hostRead, keepRead } from './hostRead.ts'
import { adoptSorts, adoptVisits } from './pickerStore.ts'
import { notAnswering } from './reachable.ts'
import type { NoticeEvent, NoticeScope } from './trackerNotices.ts'

/**
 * How the page reads and changes the host's settings (`/host/settings`), shared by
 * the Settings window (`canvas/Settings.tsx`), a module's Tools and Skills windows,
 * the one-time question and the tour, so none of them imports another's window.
 */
export type Change =
  | { except: { kind: 'tools' | 'skills'; module: string; out: boolean } }
  | { notices: { on?: boolean; scope?: NoticeScope; events?: Partial<Record<NoticeEvent, boolean>> } }
  | { modules: { project: number; keep: boolean } }
  | { updates: { auto: boolean } }
  | { github: { share: number } }
  | { appearance: AppearancePatch }

/**
 * The settings, read once per page load whoever asks (the one-time question, the introduction),
 * and afresh when the Settings window is opened or re-reads (`fresh`). See `hostRead`.
 */
export function fetchSettings(signal?: AbortSignal, fresh = false): Promise<SettingsAnswer> {
  return hostRead(
    'settings',
    async () => {
      const response = await fetch('/host/settings', { cache: 'no-store' })
      const body = (await response.json()) as SettingsAnswer | { ok: false; why?: string }
      if (!response.ok || !body.ok || !body.settings || !body.status) throw new Error(('why' in body && body.why) || 'Kehikot could not read its settings. Close Settings and open it again.')
      adoptSorts(body.picker)
      adoptVisits(body.visits)
      adoptAppearance(body.appearance, migrateAppearance)
      return body
    },
    { signal, fresh },
  )
}

export async function postSettings(change: Change): Promise<SettingsAnswer> {
  if ('except' in change) return postExcept(change.except)
  const response = await fetch('/host/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(change),
  })
  const body = (await response.json()) as SettingsAnswer | { ok: false; why?: string }
  if (!response.ok || !body.ok || !body.settings) throw new Error(('why' in body && body.why) || 'Kehikot did not save that change. Try again.')
  adoptSorts(body.picker)
  if ('appearance' in change) adoptAppearance(body.appearance, migrateAppearance)
  if (body.status) keepRead('settings', body)
  else forgetRead('settings')
  return body
}

/**
 * One module left out of the agent setup, or put back: a change of the agent module's own setting
 * (protocol 2.91.0, `AGENT_SETUP_KEYS`), made as the person through the one route that mints their
 * pass (`/host/module-settings/set`). The host never relays it. The list is read afresh first, so two
 * windows each changing one module do not undo each other.
 */
async function postExcept(except: { kind: 'tools' | 'skills'; module: string; out: boolean }): Promise<SettingsAnswer> {
  const now = await fetchSettings(undefined, true)
  const holder = now.setup
  if (!holder) throw new Error('No agent module that holds this choice is running, so it cannot be changed now. Start it and try again.')
  const list = new Set(now.settings[except.kind].except)
  if (except.out) list.add(except.module)
  else list.delete(except.module)
  const response = await fetch('/host/module-settings/set', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module: holder.module, project: null, key: except.kind === 'tools' ? AGENT_SETUP_KEYS.toolsExcept : AGENT_SETUP_KEYS.skillsExcept, value: [...list].sort() }),
  })
  const body = (await response.json().catch(() => null)) as { ok?: boolean; outcome?: string; why?: string } | null
  if (!response.ok || !body || body.ok === false || body.outcome !== 'saved') throw new Error(body?.why || `${holder.name} did not take that change. Try again.`)
  return fetchSettings(undefined, true)
}

/** A machine with no Appearance row yet is given what the cookies said (the bar's old buttons), once. */
function migrateAppearance(now: Appearance): void {
  void postSettings({ appearance: now }).catch(() => {})
}

/**
 * The settings as the server has them, read when `open`, and the way to change
 * them. Changes go one after another, in the order they were made, so a quick
 * second press is never lost to the first; `saved` counts the ones taken.
 */
export function useAgentSettings(open: boolean, load = fetchSettings, save = postSettings) {
  const [answer, setAnswer] = useState<SettingsAnswer | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(0)
  const queue = useRef<Promise<void>>(Promise.resolve())

  /* Open, the window reads the settings afresh: what the sync found may have moved. */
  const read = useCallback(async () => {
    try {
      setAnswer(await load(undefined, true))
      setTrouble(null)
    } catch (error) {
      setTrouble(notAnswering(error))
    }
  }, [load])

  useEffect(() => {
    if (open) void read()
  }, [open, read])

  const change = useCallback(
    (what: Change) => {
      const next = queue.current.then(async () => {
        setBusy(true)
        try {
          setAnswer(await save(what))
          setTrouble(null)
          setSaved((n) => n + 1)
        } catch (error) {
          setTrouble(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      })
      queue.current = next
      return next
    },
    [save],
  )

  return { answer, trouble, busy, saved, read, change }
}

/** Close a window, then open Settings over where it was; at one section when named. */
export function toSettings(close: () => void, section?: SettingsSection): void {
  close()
  setTimeout(() => openSettings(section), 0)
}
