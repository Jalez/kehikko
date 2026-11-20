import { useId, type ReactNode } from 'react'

import { active, automatic, type SettingsAnswer } from '@/host/agentSettings.ts'

/** A native checkbox and its label, as one target. Used by a module's Tools and Skills windows. */
function Box({ checked, onChange, disabled, children }: { checked: boolean; onChange(on: boolean): void; disabled?: boolean; children: ReactNode }) {
  const id = useId()
  return (
    <div className="flex min-w-0 items-start gap-2">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-3.5 shrink-0"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <label htmlFor={id} className="min-w-0 leading-snug">
        {children}
      </label>
    </div>
  )
}

/**
 * What a module's Tools or Skills window says about Settings: that this module
 * is kept set up (with a way to leave it out), that it is left out, or that
 * Settings could do this for every module.
 */
export function KeptBySettings({
  kind,
  module,
  name,
  answer,
  busy,
  onExcept,
  onSettings,
}: {
  kind: 'tools' | 'skills'
  module: string
  name: string
  answer: SettingsAnswer | null
  busy: boolean
  onExcept(out: boolean): void
  /** Close the window this sits in, then `openSettings()`. */
  onSettings(): void
}) {
  if (!answer) return null
  const settings = answer.settings
  const kept = kind === 'tools' ? 'Kept connected by Settings' : 'Kept installed and up to date by Settings'
  const change = (
    <button type="button" className="underline underline-offset-2" onClick={onSettings} data-press="settings">
      change
    </button>
  )
  if (!active(settings, kind)) {
    return (
      <p className="text-muted-foreground text-xs" data-kept="off">
        <button type="button" className="underline underline-offset-2" onClick={onSettings} data-press="settings">
          Do this for every module → Settings
        </button>
      </p>
    )
  }
  const on = automatic(settings, kind, module)
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-kept={on ? 'on' : 'excepted'}>
      <span>
        {on ? kept : `Left to you in Settings`} · {change}
      </span>
      <Box checked={!on} disabled={busy} onChange={onExcept}>
        Leave {name} out
      </Box>
    </div>
  )
}
