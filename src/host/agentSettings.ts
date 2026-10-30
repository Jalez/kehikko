import type { ChimeSettings } from './chime.ts'
import type { PickerSorts } from './pickerOrder.ts'
import type { NoticeSettings } from './trackerNotices.ts'

/**
 * How Kehikot works with a person's coding agents, chosen ONCE for every module
 * and every project: the words and the pure parts, shared by the page
 * (`src/canvas/Settings.tsx`) and the server (`server/agentSettings.ts`,
 * `server/agentSync.ts`).
 *
 * The person's words that started it: being made to connect the tools to each
 * module separately, in every project, is bad. So the choice is made here,
 * machine-wide, and a sync keeps every registered module's door and skills in
 * step with it (`server/agentSync.ts`).
 *
 * Nothing automatic happens before the person answered the one-time question
 * (`asked`). A setting is a choice the person made, not a default this host
 * made for them.
 */

/**
 * The agents Kehikot can set up. One is built; the shape is a map so another
 * is a key added here and a writer added on
 * the server, not a new settings shape.
 */
export interface Providers {
  claudeCode: { enabled: boolean }
}

export type ProviderKey = keyof Providers

/** One kind of thing kept set up: on for every module, except the ones named. */
export interface Automatic {
  auto: boolean
  /** Module ids left to the person. */
  except: string[]
}

export interface AgentSettings {
  providers: Providers
  /** Each module's MCP door in the agent's user-wide server list. */
  tools: Automatic
  /** Each module's skills in the agent's personal skills folder. */
  skills: Automatic
  /** Whether the one-time question was answered. Until it is, nothing automatic happens. */
  asked: boolean
}

export const DEFAULT_SETTINGS: AgentSettings = {
  providers: { claudeCode: { enabled: true } },
  tools: { auto: true, except: [] },
  skills: { auto: true, except: [] },
  asked: false,
}

/**
 * The agents listed in Settings, in order. Only the built ones. `name` is the
 * one place a person reads which program is set up — it is data, like the
 * official module list, and the sentences around it say "your agent".
 */
export const PROVIDERS: readonly { key: ProviderKey; name: string; says: string }[] = [
  {
    key: 'claudeCode',
    name: 'Claude Code',
    says: 'Its user-wide MCP server list (claude mcp add --scope user) and its personal skills folder.',
  },
]

export const MORE_AGENTS = 'More agents are coming. For now Kehikot sets up the one listed here.'

const EXCEPT_MAX = 500
const ID_MAX = 64

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= ID_MAX

function exceptIn(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > EXCEPT_MAX || !value.every(isId)) return null
  return [...new Set(value)].sort()
}

function automaticIn(value: unknown, was: Automatic): Automatic | null {
  if (value === undefined) return was
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as { auto?: unknown; except?: unknown }
  if (raw.auto !== undefined && typeof raw.auto !== 'boolean') return null
  const except = raw.except === undefined ? was.except : exceptIn(raw.except)
  if (except === null) return null
  return { auto: raw.auto ?? was.auto, except }
}

/**
 * A change to the settings, read strictly: a key this does not know, or a value
 * of the wrong kind, refuses the whole change. Absent keys keep what `was` has.
 */
export function settingsPatched(was: AgentSettings, raw: unknown): AgentSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const body = raw as Record<string, unknown>
  for (const key of Object.keys(body)) if (!['providers', 'tools', 'skills', 'asked'].includes(key)) return null
  let providers = was.providers
  if (body.providers !== undefined) {
    const given = body.providers as { claudeCode?: { enabled?: unknown } } | null
    if (!given || typeof given !== 'object' || Array.isArray(given)) return null
    for (const key of Object.keys(given)) if (key !== 'claudeCode') return null
    if (given.claudeCode !== undefined) {
      if (!given.claudeCode || typeof given.claudeCode.enabled !== 'boolean') return null
      providers = { ...providers, claudeCode: { enabled: given.claudeCode.enabled } }
    }
  }
  const tools = automaticIn(body.tools, was.tools)
  const skills = automaticIn(body.skills, was.skills)
  if (!tools || !skills) return null
  if (body.asked !== undefined && typeof body.asked !== 'boolean') return null
  return { providers, tools, skills, asked: (body.asked as boolean | undefined) ?? was.asked }
}

/** What is stored, read leniently: anything unreadable is the default. */
export function settingsStored(raw: unknown): AgentSettings {
  return settingsPatched(DEFAULT_SETTINGS, raw) ?? DEFAULT_SETTINGS
}

/** One module put on or taken off a list of exceptions. */
export function excepting(settings: AgentSettings, kind: 'tools' | 'skills', module: string, out: boolean): AgentSettings {
  const now = new Set(settings[kind].except)
  if (out) now.add(module)
  else now.delete(module)
  return { ...settings, [kind]: { ...settings[kind], except: [...now].sort() } }
}

/** Whether the sync may act on its own at all for this kind. */
export function active(settings: AgentSettings, kind: 'tools' | 'skills'): boolean {
  return settings.asked && settings.providers.claudeCode.enabled && settings[kind].auto
}

/** Whether the sync keeps this module's tools or skills set up. */
export function automatic(settings: AgentSettings, kind: 'tools' | 'skills', module: string): boolean {
  return active(settings, kind) && !settings[kind].except.includes(module)
}

/* ---- the one-time question ---- */

export const FIRST_QUESTION = {
  title: 'Let Kehikot keep your agent set up?',
  lead: 'Kehikot can connect every module’s tools to your agent and keep each module’s skills installed and up to date — once, for every module and every project — so you do not press Connect or Install for each one.',
  writes: [
    'Your agent’s user-wide MCP server list, through its own command (claude mcp add --scope user). Only entries Kehikot adds are ever changed or removed.',
    'Folders under ~/.claude/skills/<name>, one per skill. A skill you changed, or a name another skill already has, is left alone.',
    'An agent module that installs skills itself keeps the same skills where its agent reads them, under the same rules.',
  ],
  after: 'Each change is one line in the Inbox. You can change this any time in Settings, and leave single modules out there.',
  keep: 'Save',
  self: 'I’ll do it myself',
  toolsBox: 'Connect every module’s tools',
  skillsBox: 'Install every module’s skills and keep them up to date',
} as const

/* ---- what the sync found ---- */

/**
 * Where one module's door stands for the agent.
 *
 * - `connected`: the agent's list has an entry pointing at it.
 * - `missing`: it has none (and the sync is not keeping it, or has not run yet).
 * - `excepted`: the person left this module out.
 * - `asleep`: the module is not answering and has never been seen running, so
 *   where its door is is not known. It is connected the next time it runs. A
 *   module that is not answering and HAS run is connected from the door it had
 *   then, and is `connected` (`toolSays` adds "not running now").
 * - `conflict`: an entry of its name points elsewhere and Kehikot did not make it.
 * - `refused`: the name its manifest asks for is taken (`nameRefusal`).
 * - `failed`: the claude command did not do it; tried again later.
 */
export type ToolState = 'connected' | 'missing' | 'excepted' | 'asleep' | 'conflict' | 'refused' | 'failed'

export const TOOL_STATE_SAYS: Record<ToolState, string> = {
  connected: 'Connected',
  missing: 'Not connected',
  excepted: 'Left to you',
  asleep: 'Not running',
  conflict: 'Name taken',
  refused: 'Name refused',
  failed: 'Failed, trying again',
}

/** Where one skill stands; the Skills window's statuses plus the two the sync adds. */
export type SkillState = 'absent' | 'installed' | 'outdated' | 'edited' | 'taken' | 'excepted' | 'failed' | 'bound' | 'agent'

export const SKILL_STATE_SAYS: Record<SkillState, string> = {
  absent: 'Not installed',
  installed: 'Installed',
  outdated: 'Outdated',
  edited: 'Changed by you',
  taken: 'Name taken',
  excepted: 'Left to you',
  failed: 'Failed, trying again',
  bound: 'On a kehikko only',
  agent: 'Kept by its module',
}

export interface ModuleSync {
  id: string
  name: string
  /** Null for a module with no MCP door. */
  tools: ToolState | null
  /**
   * `bound`, for a kehikko-bound skill (protocol 2.12.0): where it works, in words (`boundSays`),
   * whatever its state. Such a skill is never installed for every conversation.
   */
  skills: { name: string; state: SkillState; bound?: string; agent?: string }[]
  /** Whether it was answering, so its door and skills could be read. */
  answering: boolean
}

export interface SyncStatus {
  /** When the last run ended, or null before the first. */
  at: number | null
  running: boolean
  modules: ModuleSync[]
  /** The sentences of the one quiet Inbox item, if any. */
  problems: string[]
}

export const EMPTY_STATUS: SyncStatus = { at: null, running: false, modules: [], problems: [] }

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** One module's tools, in words: a connected module that is stopped says so. */
export function toolSays(row: Pick<ModuleSync, 'tools' | 'answering'>): string {
  if (!row.tools) return ''
  if (row.tools === 'connected' && !row.answering) return 'Connected (not running now)'
  return TOOL_STATE_SAYS[row.tools]
}

/** "14 connected (3 not running now), 1 left to you" — the tools section's status line. */
export function toolsSaid(status: SyncStatus): string {
  const states = status.modules.flatMap((one) => (one.tools ? [one.tools] : []))
  if (states.length === 0) return status.at === null ? 'Not looked yet.' : 'No module offers tools.'
  const by = (state: ToolState) => states.filter((one) => one === state).length
  const stopped = status.modules.filter((one) => one.tools === 'connected' && !one.answering).length
  const parts = [`${by('connected')} connected${stopped ? ` (${stopped} not running now)` : ''}`]
  if (by('missing')) parts.push(`${by('missing')} not connected`)
  if (by('excepted')) parts.push(`${by('excepted')} left to you`)
  if (by('asleep')) parts.push(`${by('asleep')} not running`)
  const trouble = by('conflict') + by('refused') + by('failed')
  if (trouble) parts.push(`${count(trouble, 'problem')}`)
  return parts.join(', ')
}

/** The skills section's status line, edited and taken names said. */
export function skillsSaid(status: SyncStatus): string {
  const states = status.modules.flatMap((one) => one.skills.map((skill) => skill.state))
  if (states.length === 0) return status.at === null ? 'Not looked yet.' : 'No running module offers skills.'
  const by = (state: SkillState) => states.filter((one) => one === state).length
  const parts = [`${by('installed')} installed`]
  if (by('outdated')) parts.push(`${by('outdated')} outdated`)
  if (by('absent')) parts.push(`${by('absent')} not installed`)
  if (by('excepted')) parts.push(`${by('excepted')} left to you`)
  if (by('edited')) parts.push(`${by('edited')} changed by you`)
  if (by('taken')) parts.push(`${by('taken')} name taken`)
  if (by('failed')) parts.push(`${by('failed')} failed`)
  if (by('bound')) parts.push(`${by('bound')} only on a kehikko`)
  if (by('agent')) parts.push(`${by('agent')} kept by ${by('agent') === 1 ? 'its module' : 'their modules'}`)
  return parts.join(', ')
}

/* ---- the Inbox ---- */

/** The module id the sync's Inbox lines and its one problem item are filed under. */
export const SETTINGS_INBOX_MODULE = 'kehikko.settings'
/** The one quiet item's id. */
export const SYNC_TROUBLE_ID = 'agent-setup'

/* ---- reaching Settings from anywhere on the page ---- */

/**
 * The window event that opens Settings. Also the desktop shell's way in: an app
 * menu "Settings…" item can `eval` `window.dispatchEvent(new Event('kehikot:settings'))`
 * into the page, and nothing else is needed from the host.
 */
export const OPEN_EVENT = 'kehikot:settings'

/**
 * ⌘, on a Mac and Ctrl+, elsewhere: the shortcut every Mac program uses for its
 * settings. By `key`, with no Shift or Alt, so it never meets Alt+Shift+N
 * (`App.tsx`). Keys pressed inside a module's page stay in its frame and never
 * reach here; that is the frame's boundary, not a choice.
 */
export function isSettingsChord(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, mac: boolean): boolean {
  if (event.key !== ',' || event.altKey || event.shiftKey) return false
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

/** Whether this page runs on a Mac, for the chord and how it is written. */
export function onMac(): boolean {
  if (typeof navigator === 'undefined') return true
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? ''
  return /mac/i.test(platform) || (!platform && /Mac OS X/.test(navigator.userAgent ?? ''))
}

/** "⌘," or "Ctrl+,", as a tooltip writes it. */
export function chordSaid(mac: boolean): string {
  return mac ? '⌘,' : 'Ctrl+,'
}

/** The sections of the Settings dialog, in the order its nav lists them. */
export const SETTINGS_SECTIONS = ['agents', 'tools', 'skills', 'notices', 'sounds', 'hook', 'project', 'modules', 'about'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

const isSection = (value: unknown): value is SettingsSection => (SETTINGS_SECTIONS as readonly unknown[]).includes(value)

/** Open the Settings dialog, wherever it is mounted; at one section when named. */
export function openSettings(section?: SettingsSection): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: section ?? null }))
}

/** Listen for `openSettings` (and the shell's bare event, which names no section). Returns the unlisten. */
export function onOpenSettings(then: (section: SettingsSection | null) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const heard = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail
    then(isSection(detail) ? detail : null)
  }
  window.addEventListener(OPEN_EVENT, heard)
  return () => window.removeEventListener(OPEN_EVENT, heard)
}

/* ---- the start hook, read only ---- */

/**
 * Whether the agent reports sessions started outside Kehikot (an agent
 * module's SessionStart hook). `on` is null when the settings file could not
 * be read. The host never writes that file.
 */
export interface StartHook {
  file: string
  on: boolean | null
}

export const START_HOOK_WHERE =
  'The agent module that offers it turns it on: open that module on a kehikko, and in its list of conversations press “Report them” beside “Sessions started outside Kehikot are not reported here.”'

/** What `GET /host/settings` answers. */
export interface SettingsAnswer {
  ok: true
  settings: AgentSettings
  status: SyncStatus
  hook: StartHook
  /** Where skills are written, for the words. */
  skillsAt: string
  /** Tracker notices in the Inbox (`trackerNotices.ts`). Absent from an older host. */
  notices?: NoticeSettings
  /** "Keep this project's modules running" (`server/keepRunning.ts`). Absent from an older host. */
  modules?: { keep: boolean }
  /** "Keep modules up to date automatically" (`server/autoUpdates.ts`). Absent from an older host. */
  updates?: { auto: boolean }
  /** The Inbox chime (`server/chime.ts`). Absent from an older host. */
  chime?: ChimeSettings
  /** How the project, epic and kehikko pickers are ordered (`server/pickerOrder.ts`). Absent from an older host. */
  picker?: PickerSorts
}
