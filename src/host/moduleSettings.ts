import type { SettingField } from 'kehikot-module-protocol'

/**
 * A module's settings, as this host's page and its door say them (protocol 2.15.0). Pure: the
 * words, the control each type is drawn as, where the header's settings button goes, and the
 * answers the page reads. The form is `src/canvas/ModuleSettings.tsx`; the server is
 * `server/moduleSettings.ts`. The module is the only writer of its files.
 */

export type { SettingField }

/** One module as the Settings › Modules section lists it. */
export interface SettingsListed {
  id: string
  name: string
  icon: string | null
  /** Running and answering, so its settings can be read. */
  ready: boolean
  fields: readonly SettingField[]
}

/** What `/host/module-settings` answers for one module. */
export type SettingsAnswer =
  | {
      ok: true
      module: string
      name: string
      fields: readonly SettingField[]
      values: Record<string, unknown>
      file: string | null
      problem: string | null
    }
  | { ok: false; why: string }

/** What `/host/module-settings/set` answers. */
export type SetAnswer = { outcome: 'saved' | 'refused'; why: string; values?: Record<string, unknown> } | { ok: false; why: string }

/** The settings a module declared, or none. */
export function settingsOf(module: { declares?: { settings?: readonly SettingField[] } } | null | undefined): readonly SettingField[] {
  return module?.declares?.settings ?? []
}

/** The control a field is drawn as. */
export type SettingControl = 'switch' | 'text' | 'number' | 'select' | 'lines'

export function controlFor(field: Pick<SettingField, 'type'>): SettingControl {
  switch (field.type) {
    case 'boolean':
      return 'switch'
    case 'number':
      return 'number'
    case 'choice':
      return 'select'
    case 'list':
      return 'lines'
    default:
      return 'text'
  }
}

/** A list setting as the text a person edits: one line each. */
export function linesOf(value: unknown): string {
  return Array.isArray(value) ? value.filter((one) => typeof one === 'string').join('\n') : ''
}

/** The text a person typed into a list setting, as its value: one entry a non-empty line, trimmed. */
export function listOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** A number field's text as its value, or null when it is not a number. */
export function numberOf(text: string): number | null {
  if (!text.trim()) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/** What the form says after a change: "Saved", or the module's sentence for a refusal. */
export function savedSaid(answer: SetAnswer): { tone: 'saved' | 'refused'; text: string } {
  if ('ok' in answer) return { tone: 'refused', text: answer.why }
  if (answer.outcome === 'saved') return { tone: 'saved', text: 'Saved' }
  return { tone: 'refused', text: answer.why || 'Not saved.' }
}

/** The tooltip and label of a container's settings button. */
export const settingsHint = (name: string): string => `${name} settings`

/**
 * Where a container's settings button goes at a header's width (`MenuMode` of `modeFor`):
 * - `button`: a gear in the row, at 220 px and wider, folded or not;
 * - `more`: under 220, a "Settings…" row in the module's "⋯" menu, when its menus are drawn;
 * - `frame`: under 220 with no "⋯" (no menus, or folded): only the Frame menu's "Settings…",
 *   which is there at every width.
 * The gear never changes how the module's own menus are drawn: their mode is the width's.
 */
export type SettingsPlace = 'button' | 'more' | 'frame'

export function settingsPlaceFor(mode: 'words' | 'icons' | 'merged', menusDrawn: boolean): SettingsPlace {
  if (mode !== 'merged') return 'button'
  return menusDrawn ? 'more' : 'frame'
}

/** A value said in a line of text, for the door's read-only tool. */
export function valueSaid(field: Pick<SettingField, 'type' | 'choices'>, value: unknown): string {
  if (field.type === 'boolean') return value === true ? 'on' : 'off'
  if (field.type === 'list') return Array.isArray(value) && value.length ? value.map((one) => `"${String(one)}"`).join(', ') : '(none)'
  if (field.type === 'choice') {
    const choice = field.choices?.find((one) => one.value === value)
    return choice ? `${choice.label} (${choice.value})` : String(value)
  }
  if (field.type === 'string') return value === '' ? '(empty)' : `"${String(value)}"`
  return String(value)
}

/** One module's settings as `module_settings` says them: each label, value, scope and who may change it. */
export function settingsText(answer: SettingsAnswer, project: string | null): string {
  if (!answer.ok) return answer.why
  const out = [`${answer.name} (${answer.module})${project ? ` in ${project}` : ''}:`]
  for (const field of answer.fields) {
    const who = field.personOnly ? 'only the person may change it' : `an agent may change it at ${answer.name}'s own door`
    out.push(`- ${field.label} [${field.key}, ${field.type}, ${field.scope}]: ${valueSaid(field, answer.values[field.key])} — ${who}.`)
    if (field.description) out.push(`  ${field.description}`)
  }
  if (answer.file) out.push(`Kept in ${answer.file}, which ${answer.name} writes; this host never does.`)
  if (answer.problem) out.push(`It could not read its settings: ${answer.problem}`)
  return out.join('\n')
}
