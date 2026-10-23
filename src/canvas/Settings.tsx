import {
  AlertTriangle,
  Bell,
  Blocks,
  Bot,
  Check,
  ExternalLink,
  FolderGit2,
  Hammer,
  HardDrive,
  MessagesSquare,
  Plug,
  Search,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { PACKAGE_VERSION } from 'kehikot-module-protocol'
import { useCallback, useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from 'react'

import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Card } from '@/components/ui/card.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { ScrollArea } from '@/components/ui/scroll-area.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import { cn } from '@/lib/utils'
import {
  active,
  automatic,
  chordSaid,
  FIRST_QUESTION,
  isSettingsChord,
  MORE_AGENTS,
  onMac,
  onOpenSettings,
  openSettings,
  PROVIDERS,
  SKILL_STATE_SAYS,
  skillsSaid,
  START_HOOK_WHERE,
  toolSays,
  toolsSaid,
  type AgentSettings,
  type SettingsAnswer,
  type SettingsSection,
  SETTINGS_SECTIONS,
  type SkillState,
  type ToolState,
} from '@/host/agentSettings.ts'
import { isGitReason } from '@/host/gitSaid.ts'
import { BASE_BRANCH_SAID, fetchBaseBranch, setBaseBranch, type BaseBranch, type Project } from '@/host/projects.ts'
import { notAnswering } from '@/host/reachable.ts'
import { BUILD_A_MODULE_GUIDE, OWN_SKILLS_MODULE } from '@/host/skills.ts'
import { SkillsDialog } from './Skills.tsx'
import { APP_NAME, APP_REPO, openExternal, releasePage } from '@/host/releaseNotes.ts'
import { openStorage } from '@/host/storage.ts'
import { NOTICE_EVENTS, NOTICE_WORDS, type NoticeEvent, type NoticeScope, type NoticeSettings } from '@/host/trackerNotices.ts'
import { useShownVersion } from './AppVersion.tsx'
import { GitSaid } from './GitSaid.tsx'
import { KehikkoMark } from './Mark.tsx'
import { ModuleIcon } from './ModuleIcon.tsx'
import { ModulesSettings, type SettingsApi } from './ModuleSettings.tsx'
import { announceShow, fetchShowSetting, onShowChanged, openWhatsNew, postWhatsNew } from '@/host/whatsNew.ts'

/**
 * Settings: how Kehikot works with the person's coding agents, chosen once for
 * every module and every project (`host/agentSettings.ts` has the shape and the
 * words, `server/agentSync.ts` what is done with them).
 *
 * Three pieces, all here so the words stay together:
 *
 *  - `AgentSettingsHost`, mounted once by the page: asks the one-time question
 *    while it is unanswered, and opens the dialog when anything calls
 *    `openSettings()` — the gear in the strip, ⌘, (Ctrl+, off a Mac), the
 *    projects menu, a module's Tools or Skills window, the sync's line in the
 *    Inbox, and the desktop shell's own event.
 *  - `SettingsDialog` and its body: a section nav on the left (Agents, Module
 *    tools, Skills, Tracker notices, Conversations, Project, About) and one section at a
 *    time on the right — a summary card, then each setting as a row with its
 *    switch. A change is sent as it is made and said "Saved"; there is no Save
 *    button for a switch.
 *  - `KeptBySettings`: the line a module's Tools or Skills window shows.
 *
 * Every state is a word, never a colour alone; every switch has its label, the
 * nav is a tab list a keyboard walks with the arrows, and focus is always ringed.
 */

/** The words of "Keep this project's modules running" (`server/keepRunning.ts`). */
export const KEEP_RUNNING = {
  label: 'Keep this project’s modules running',
  description:
    'Every module on any kehikko of the open project is started in the background and kept running, so switching kehikko shows it at once. ' +
    'Each running module’s server takes roughly 100–300 MB of memory. Off, only the open kehikko’s modules run, and the others stop five minutes after you leave them.',
} as const

type Change =
  | { settings: Partial<Record<keyof AgentSettings, unknown>> }
  | { except: { kind: 'tools' | 'skills'; module: string; out: boolean } }
  | { notices: { on?: boolean; scope?: NoticeScope; events?: Partial<Record<NoticeEvent, boolean>> } }
  | { modules: { keep: boolean } }

export async function fetchSettings(signal?: AbortSignal): Promise<SettingsAnswer> {
  const response = await fetch('/host/settings', { cache: 'no-store', signal })
  const body = (await response.json()) as SettingsAnswer | { ok: false; why?: string }
  if (!response.ok || !body.ok || !body.settings || !body.status) throw new Error(('why' in body && body.why) || 'The host would not say its settings.')
  return body
}

export async function postSettings(change: Change): Promise<SettingsAnswer> {
  const response = await fetch('/host/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(change),
  })
  const body = (await response.json()) as SettingsAnswer | { ok: false; why?: string }
  if (!response.ok || !body.ok || !body.settings) throw new Error(('why' in body && body.why) || 'The host did not take that change.')
  return body
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

  const read = useCallback(async () => {
    try {
      setAnswer(await load())
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

/** The open project, as the Project section needs it. */
export type SettingsProject = Pick<Project, 'id' | 'name' | 'git' | 'home' | 'missing'>

/** How the Project section reads and sets the base branch; injectable for tests. */
export interface BaseBranchDoor {
  load: typeof fetchBaseBranch
  save: typeof setBaseBranch
}

const BASE_BRANCH_DOOR: BaseBranchDoor = { load: fetchBaseBranch, save: setBaseBranch }

/** Mounted once by the page: the one-time question, ⌘, and the dialog wherever it is asked for. */
export function AgentSettingsHost({
  load = fetchSettings,
  save = postSettings,
  project = null,
}: { load?: typeof fetchSettings; save?: typeof postSettings; project?: SettingsProject | null } = {}) {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<SettingsSection>('agents')
  const [question, setQuestion] = useState(false)

  useEffect(
    () =>
      onOpenSettings((at) => {
        if (at) setSection(at)
        setOpen(true)
      }),
    [],
  )

  /* ⌘, on a Mac, Ctrl+, elsewhere — in a text field too, where it types nothing. */
  useEffect(() => {
    const mac = onMac()
    const onKey = (event: KeyboardEvent) => {
      if (!isSettingsChord(event, mac)) return
      event.preventDefault()
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* Asked once per page load while unanswered. Closing it without answering asks again next time. */
  useEffect(() => {
    const stop = new AbortController()
    load(stop.signal)
      .then((answer) => setQuestion(!answer.settings.asked))
      .catch(() => {})
    return () => stop.abort()
  }, [load])

  return (
    <>
      <FirstQuestion
        open={question && !open}
        onOpenChange={setQuestion}
        onAnswer={async (choice) => {
          await save({
            settings: { asked: true, tools: { auto: choice?.tools ?? false }, skills: { auto: choice?.skills ?? false } },
          })
          setQuestion(false)
        }}
      />
      <SettingsDialog open={open} onOpenChange={setOpen} load={load} save={save} section={section} onSection={setSection} project={project} />
    </>
  )
}

/**
 * The one-time question. Both switches on to start; "Save" takes what is on,
 * "I'll do it myself" turns both off. Either answer is kept.
 */
export function FirstQuestion({
  open,
  onOpenChange,
  onAnswer,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  /** `null`: the person will do it themselves. */
  onAnswer(choice: { tools: boolean; skills: boolean } | null): Promise<void>
}) {
  const [tools, setTools] = useState(true)
  const [skills, setSkills] = useState(true)
  const [busy, setBusy] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)

  const answer = async (choice: { tools: boolean; skills: boolean } | null) => {
    setBusy(true)
    setTrouble(null)
    try {
      await onAnswer(choice)
    } catch (error) {
      setTrouble(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-[calc(100%-2rem)] gap-5 overflow-y-auto sm:max-w-lg" data-first-question>
        <DialogHeader className="pr-6">
          <DialogTitle className="flex items-center gap-2">
            <KehikkoMark working={false} className="text-muted-foreground size-4 shrink-0" />
            {FIRST_QUESTION.title}
          </DialogTitle>
          <DialogDescription>{FIRST_QUESTION.lead}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4 text-sm">
          <Rows>
            <SettingRow label={FIRST_QUESTION.toolsBox} checked={tools} onChange={setTools} disabled={busy} />
            <SettingRow label={FIRST_QUESTION.skillsBox} checked={skills} onChange={setSkills} disabled={busy} />
          </Rows>
          <div className="bg-muted/50 rounded-lg px-4 py-3">
            <p className="text-xs font-medium">What Kehikot will write</p>
            <ul className="text-muted-foreground mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed">
              {FIRST_QUESTION.writes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">{FIRST_QUESTION.after}</p>
          {trouble ? <Trouble>{trouble}</Trouble> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} data-answer="self" onClick={() => void answer(null)}>
              {FIRST_QUESTION.self}
            </Button>
            <Button size="sm" disabled={busy} data-answer="keep" onClick={() => void answer({ tools, skills })}>
              {FIRST_QUESTION.keep}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** An icon slot: a Lucide icon, or Kehikot's own mark where Kehikot itself is meant. */
type IconLike = LucideIcon | ComponentType<{ className?: string }>

/** Kehikot's own mark, as an icon slot takes one: the same frame as the bar's, still. */
function KehikotMark({ className }: { className?: string }) {
  return <KehikkoMark working={false} className={className} />
}

const SECTION_SAID: Record<SettingsSection, { title: string; icon: IconLike }> = {
  agents: { title: 'Agents', icon: Bot },
  tools: { title: 'Module tools', icon: Plug },
  skills: { title: 'Skills', icon: Sparkles },
  notices: { title: 'Tracker notices', icon: Bell },
  hook: { title: 'Conversations', icon: MessagesSquare },
  project: { title: 'Project', icon: FolderGit2 },
  modules: { title: 'Modules', icon: Blocks },
  about: { title: 'About', icon: KehikotMark },
}

export function SettingsDialog({
  open,
  onOpenChange,
  load = fetchSettings,
  save = postSettings,
  section: given,
  onSection: setGiven,
  project = null,
  baseBranch = BASE_BRANCH_DOOR,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  load?: typeof fetchSettings
  save?: typeof postSettings
  /** Which section is shown; the dialog keeps its own when not given. */
  section?: SettingsSection
  onSection?(section: SettingsSection): void
  /** The open project; the Project section is shown only with one. */
  project?: SettingsProject | null
  baseBranch?: BaseBranchDoor
}) {
  const { answer, trouble, busy, saved, read, change } = useAgentSettings(open, load, save)
  const [own, setOwn] = useState<SettingsSection>('agents')
  const section = given ?? own
  const setSection = setGiven ?? setOwn

  /* What the sync finds lands a moment after a change; read again while the window is open. */
  useEffect(() => {
    if (!open) return
    const every = setInterval(() => void read(), 4000)
    return () => clearInterval(every)
  }, [open, read])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(720px,calc(100dvh-2rem))] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        data-settings
      >
        <SettingsBody
          answer={answer}
          trouble={trouble}
          busy={busy}
          saved={saved}
          section={section}
          onSection={setSection}
          onChange={(what) => void change(what)}
          onClose={() => onOpenChange(false)}
          project={project}
          baseBranch={baseBranch}
        />
      </DialogContent>
    </Dialog>
  )
}

/** The dialog's inside: the section nav and the sections, drawn from one answer. Exported for tests. */
export function SettingsBody({
  answer,
  trouble = null,
  busy,
  saved = 0,
  section,
  onSection,
  onChange,
  onClose = () => {},
  project = null,
  baseBranch = BASE_BRANCH_DOOR,
  modulesApi,
}: {
  answer: SettingsAnswer | null
  trouble?: string | null
  busy: boolean
  /** How many changes were taken; each new one says "Saved" for a moment. */
  saved?: number
  section: SettingsSection
  onSection(section: SettingsSection): void
  onChange(what: Change): void
  onClose?(): void
  project?: SettingsProject | null
  baseBranch?: BaseBranchDoor
  /** How Settings › Modules asks the host; for tests. */
  modulesApi?: SettingsApi
}) {
  const sections = SETTINGS_SECTIONS.filter((one) => (one !== 'notices' || answer?.notices) && (one !== 'project' || project))
  const shown = sections.includes(section) ? section : 'agents'
  const problems = answer?.status.problems.length ?? 0

  return (
    <Tabs
      value={shown}
      onValueChange={(value) => onSection(value as SettingsSection)}
      orientation="vertical"
      className="flex min-h-0 flex-1 flex-col gap-0 sm:flex-row"
    >
      <aside className="bg-muted/40 flex shrink-0 flex-col border-b sm:w-56 sm:border-r sm:border-b-0">
        <DialogHeader className="gap-0.5 px-4 pt-4 pb-2 pr-12 sm:pr-4 sm:pb-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <KehikkoMark working={false} className="text-muted-foreground size-4" />
            Settings
          </DialogTitle>
          <DialogDescription className="text-xs leading-snug max-sm:sr-only">
            How Kehikot works with your coding agents, and what the Inbox tells you, for every module and every project on this computer; and the open project’s own.
          </DialogDescription>
        </DialogHeader>
        <TabsList
          aria-label="Settings sections"
          className="h-auto w-full justify-start gap-0.5 overflow-x-auto rounded-none bg-transparent px-2 pb-2 sm:flex-col sm:items-stretch sm:overflow-visible"
        >
          {sections.map((key) => {
            const { title, icon: Icon } = SECTION_SAID[key]
            return (
              <TabsTrigger
                key={key}
                value={key}
                data-section={key}
                className="text-muted-foreground hover:text-foreground data-[state=active]:text-foreground h-8 flex-none justify-start gap-2 px-2.5 text-[13px] font-normal data-[state=active]:font-medium"
              >
                <Icon className="size-4" aria-hidden />
                {title}
                {key === 'agents' && problems > 0 ? (
                  <span className="ml-auto rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-700 tabular-nums dark:text-amber-300">
                    {problems}
                    <span className="sr-only"> left alone</span>
                  </span>
                ) : null}
              </TabsTrigger>
            )
          })}
        </TabsList>
        <p className="text-muted-foreground mt-auto hidden px-4 pb-4 text-[11px] sm:block">
          Open Settings with <kbd className="bg-background rounded border px-1 font-sans">{chordSaid(onMac())}</kbd>
        </p>
      </aside>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" aria-busy={busy}>
        <SavedNote saved={saved} />
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex min-w-0 flex-col gap-4 px-5 py-5 sm:px-6">
            {trouble ? <Trouble>{trouble}</Trouble> : null}
            {answer && !answer.settings.asked && shown !== 'about' ? (
              <p className="bg-muted/60 rounded-lg px-3 py-2 text-xs leading-relaxed" data-unasked>
                You have not chosen yet, so nothing is done for you automatically. Any choice here counts as your answer.
              </p>
            ) : null}
            {sections.map((key) => (
              <TabsContent key={key} value={key} forceMount className="flex min-w-0 flex-col gap-5 data-[state=inactive]:hidden">
                {key === 'about' ? (
                  <About onClose={onClose} />
                ) : key === 'project' ? (
                  project ? <ProjectSettings project={project} door={baseBranch} /> : null
                ) : key === 'modules' ? (
                  /* Only while it is shown: listing asks every module, and each form asks its own. */
                  shown === 'modules' ? <ModulesSettings api={modulesApi} project={project ? { id: project.id, name: project.name } : null} /> : null
                ) : answer ? (
                  <Section which={key} answer={answer} onChange={onChange} />
                ) : !trouble ? (
                  <p className="text-muted-foreground text-sm">Reading the settings…</p>
                ) : null}
              </TabsContent>
            ))}
          </div>
        </ScrollArea>
      </div>
    </Tabs>
  )
}

/** "Saved", for a moment after each change the host took. Said politely to a reader. */
function SavedNote({ saved }: { saved: number }) {
  const [showing, setShowing] = useState(false)
  useEffect(() => {
    if (saved === 0) return
    setShowing(true)
    const hide = setTimeout(() => setShowing(false), 1800)
    return () => clearTimeout(hide)
  }, [saved])
  return (
    <p
      role="status"
      aria-live="polite"
      data-saved={showing ? 'shown' : 'hidden'}
      className={cn(
        'text-muted-foreground pointer-events-none absolute top-4 right-12 z-10 flex items-center gap-1 text-xs transition-opacity duration-300',
        showing ? 'opacity-100' : 'opacity-0',
      )}
    >
      {showing ? (
        <>
          <Check className="size-3.5" aria-hidden />
          Saved
        </>
      ) : null}
    </p>
  )
}

function Section({ which, answer, onChange }: { which: Exclude<SettingsSection, 'about' | 'project'>; answer: SettingsAnswer; onChange(what: Change): void }) {
  const { settings, status, hook } = answer
  /* Any choice made here is an answer to the one-time question too. */
  const set = (patch: Partial<Record<keyof AgentSettings, unknown>>) => onChange({ settings: { ...patch, asked: true } })
  const claude = settings.providers.claudeCode.enabled
  const needsClaude = claude ? null : 'Turn on Claude Code under Agents first.'

  if (which === 'agents') {
    return (
      <>
        <Heading id="agents" lead="Which coding agents Kehikot sets up for you. Everything else here acts through them.">
          Agents
        </Heading>
        <Summary icon={Bot} title="Status">
          <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Claude Code</dt>
            <dd>{claude ? 'Set up by Kehikot' : 'Off — Kehikot sets nothing up'}</dd>
            <dt className="text-muted-foreground">Module tools</dt>
            <dd>{toolsSaid(status)}</dd>
            <dt className="text-muted-foreground">Skills</dt>
            <dd>{skillsSaid(status)}</dd>
            <dt className="text-muted-foreground">Last looked</dt>
            <dd>{status.running ? 'Looking now…' : status.at === null ? 'Not yet' : new Date(status.at).toLocaleTimeString()}</dd>
          </dl>
        </Summary>
        <Rows>
          {PROVIDERS.map((provider) => (
            <SettingRow
              key={provider.key}
              label={`Set up ${provider.name}`}
              description={provider.says}
              checked={settings.providers[provider.key].enabled}
              onChange={(on) => set({ providers: { [provider.key]: { enabled: on } } })}
            />
          ))}
        </Rows>
        <p className="text-muted-foreground text-xs">{MORE_AGENTS}</p>
        {status.problems.length ? (
          <section aria-labelledby="settings-problems" className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
            <h4 id="settings-problems" className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />
              Left alone
            </h4>
            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs leading-relaxed">
              {status.problems.map((line) => (
                <li key={line} className="break-words">
                  {line}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </>
    )
  }

  if (which === 'tools') {
    const doors = status.modules.filter((one) => one.tools !== null)
    return (
      <>
        <Heading id="tools" lead="Each module’s MCP tools, in Claude Code’s user-wide server list.">
          Module tools
        </Heading>
        <Summary icon={Plug} title="Status">
          <p className="text-sm" data-status="tools">
            {toolsSaid(status)}
            {!active(settings, 'tools') ? ' Nothing is connected for you while this is off.' : ''}
          </p>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            Only entries Kehikot added are re-pointed or removed; a server you added is never touched.
          </p>
        </Summary>
        <Rows>
          <SettingRow
            label="Connect every module’s tools to Claude Code, and keep them connected"
            description={needsClaude ?? 'A new module is connected when it first runs, and re-pointed when it moves.'}
            checked={settings.tools.auto}
            disabled={!claude}
            onChange={(on) => set({ tools: { auto: on } })}
          />
        </Rows>
        {doors.length ? (
          <ModuleExceptions
            kind="tools"
            rows={doors.map((one) => ({
              id: one.id,
              name: one.name,
              out: settings.tools.except.includes(one.id),
              chips: [{ text: toolSays(one), tone: toolTone(one.tools!, one.answering) }],
            }))}
            keep="keep connected"
            disabled={!active(settings, 'tools')}
            onOut={(module, out) => onChange({ except: { kind: 'tools', module, out } })}
          />
        ) : null}
        {answer.modules ? (
          <Rows>
            <SettingRow
              label={KEEP_RUNNING.label}
              description={KEEP_RUNNING.description}
              checked={answer.modules.keep}
              onChange={(keep) => onChange({ modules: { keep } })}
            />
          </Rows>
        ) : null}
      </>
    )
  }

  if (which === 'skills') {
    /* Kehikot's own skills (the host's row) apart from the modules': `server/ownSkills.ts`. */
    const own = status.modules.find((one) => one.id === OWN_SKILLS_MODULE && one.skills.length > 0)
    const offering = status.modules.filter((one) => one.id !== OWN_SKILLS_MODULE && one.skills.length > 0)
    return (
      <>
        <Heading id="skills" lead="Kehikot’s own and each module’s Claude Code skills, in your personal skills folder.">
          Skills
        </Heading>
        <Summary icon={Sparkles} title="Status">
          <p className="text-sm" data-status="skills">
            {skillsSaid(status)}
            {!active(settings, 'skills') ? ' Nothing is installed for you while this is off.' : ''}
          </p>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            Written to <span className="font-mono break-all">{answer.skillsAt}</span>. A skill you changed, or a name another skill already has, is left alone.
          </p>
        </Summary>
        <Rows>
          <SettingRow
            label="Install every module’s skills, and keep them up to date"
            description={needsClaude ?? 'A module’s new skill is installed, and a changed one updated, as soon as it is seen.'}
            checked={settings.skills.auto}
            disabled={!claude}
            onChange={(on) => set({ skills: { auto: on } })}
          />
        </Rows>
        {own ? (
          <OwnSkills
            row={{
              id: own.id,
              name: 'Kehikot',
              out: settings.skills.except.includes(own.id),
              ...skillChips(own.skills),
            }}
            disabled={!active(settings, 'skills')}
            onOut={(module, out) => onChange({ except: { kind: 'skills', module, out } })}
          />
        ) : null}
        {offering.length ? (
          <ModuleExceptions
            kind="skills"
            rows={offering.map((one) => ({
              id: one.id,
              name: one.name,
              out: settings.skills.except.includes(one.id),
              ...skillChips(one.skills),
            }))}
            keep="keep installed"
            disabled={!active(settings, 'skills')}
            onOut={(module, out) => onChange({ except: { kind: 'skills', module, out } })}
          />
        ) : null}
      </>
    )
  }

  if (which === 'notices') {
    return answer.notices ? <TrackerNotices notices={answer.notices} onChange={(notices) => onChange({ notices })} /> : null
  }

  return (
    <>
      <Heading id="hook" lead="Whether Claude Code tells Kehikot about a session started somewhere else. Kehikot only reads this; it never writes the file.">
        Conversations started outside Kehikot
      </Heading>
      <Summary icon={MessagesSquare} title="Status">
        <div className="mb-1.5">
          <Chip tone={hook.on === true ? 'ok' : hook.on === false ? 'quiet' : 'warn'}>
            {hook.on === true ? 'Reported' : hook.on === false ? 'Not reported' : 'Cannot say'}
          </Chip>
        </div>
        <p className="text-sm leading-relaxed" data-hook={hook.on === null ? 'unknown' : hook.on ? 'on' : 'off'}>
          {hook.on === true
            ? 'Reported: when a Claude Code session starts anywhere — a terminal, an editor — the Claude module hears of it.'
            : hook.on === false
              ? 'Not reported: a session started in a terminal or an editor is not known to Kehikot until you attach it.'
              : `Kehikot could not read ${hook.file}, so it cannot say.`}
        </p>
      </Summary>
      {hook.on !== true ? (
        <div className="rounded-lg border px-4 py-3">
          <p className="text-sm font-medium">How to turn it on</p>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{START_HOOK_WHERE}</p>
        </div>
      ) : null}
      <p className="text-muted-foreground font-mono text-[11px] break-all">{hook.file}</p>
    </>
  )
}

/** Tracker notices: on or off, how wide, and which events. Every choice a labelled control. */
function TrackerNotices({
  notices,
  onChange,
}: {
  notices: NoticeSettings
  onChange(change: { on?: boolean; scope?: NoticeScope; events?: Partial<Record<NoticeEvent, boolean>> }): void
}) {
  const name = useId()
  const off = !notices.on
  const told = NOTICE_EVENTS.filter((event) => notices.events[event]).length
  return (
    <>
      <Heading id="notices" lead={NOTICE_WORDS.lead}>
        {NOTICE_WORDS.title}
      </Heading>
      <Summary icon={Bell} title="Status">
        <p className="text-sm" data-status="notices">
          {notices.on
            ? `On · ${notices.scope === 'roles' ? 'only where you have a role' : 'also everything your epics name'} · ${told} of ${NOTICE_EVENTS.length} events`
            : 'Off · nothing from the trackers is told in the Inbox'}
        </p>
      </Summary>
      <Rows>
        <SettingRow label={NOTICE_WORDS.on} checked={notices.on} onChange={(on) => onChange({ on })} />
      </Rows>
      <fieldset className="min-w-0" data-notices-scope={notices.scope} disabled={off}>
        <legend className="mb-2 text-sm font-medium">Which items</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(['roles', 'epics'] as const).map((scope) => (
            <label
              key={scope}
              className={cn(
                'hover:bg-accent/50 has-[:checked]:border-primary has-[:checked]:bg-accent/60 has-[:focus-visible]:ring-ring/50 flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs leading-snug has-[:focus-visible]:ring-[3px]',
                off && 'cursor-not-allowed opacity-50',
              )}
            >
              <input
                type="radio"
                name={name}
                className="accent-primary mt-0.5 size-3.5 shrink-0 outline-none"
                checked={notices.scope === scope}
                disabled={off}
                onChange={() => onChange({ scope })}
              />
              <span className="min-w-0">{NOTICE_WORDS.scopes[scope]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <section aria-labelledby="settings-notice-events" className="min-w-0">
        <h4 id="settings-notice-events" className="mb-2 text-sm font-medium">
          Tell me when
        </h4>
        <ul className="grid overflow-hidden rounded-lg border sm:grid-cols-2">
          {NOTICE_EVENTS.map((event) => (
            <li key={event} className="min-w-0 border-b px-4 last:border-b-0 sm:[&:nth-last-child(2):nth-child(odd)]:border-b-0 sm:odd:border-r" data-notice-event={event}>
              <SettingRow label={NOTICE_WORDS.events[event]} checked={notices.events[event]} disabled={off} onChange={(on) => onChange({ events: { [event]: on } })} compact />
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground mt-2 text-xs leading-relaxed">{NOTICE_WORDS.needs}</p>
      </section>
    </>
  )
}

/**
 * Project: the open project's own settings, kept in its `.kehikot/host/settings.json`
 * so everyone working on it shares them. Its base branch is a field and a
 * Save, since the host checks the branch on origin before it takes it.
 */
function ProjectSettings({ project, door }: { project: SettingsProject; door: BaseBranchDoor }) {
  const field = useId()
  const [base, setBase] = useState<BaseBranch | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const asked = useRef<string | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const unavailable = project.home
    ? 'No project is picked yet. Pick one to set its base branch.'
    : project.missing
      ? `${project.name} is not where it was, so its settings cannot be read.`
      : !project.git
        ? `${project.name} is not a git repository, so it has no base branch.`
        : null

  useEffect(() => {
    setBase(null)
    setTrouble(null)
    setSaid(null)
    if (unavailable) return
    const stop = new AbortController()
    door
      .load(project.id, stop.signal)
      .then((read) => {
        if (stop.signal.aborted) return
        setBase(read)
        setTyped(read.set ?? '')
      })
      .catch((error) => !stop.signal.aborted && setTrouble(notAnswering(error)))
    return () => stop.abort()
  }, [project.id, door, unavailable])

  const submit = async (branch: string | null) => {
    asked.current = branch
    setBusy(true)
    setTrouble(null)
    setSaid(null)
    try {
      const done = await door.save(project.id, branch)
      if (!done.ok) {
        setTrouble(done.why)
        return
      }
      setBase(done.base)
      setTyped(done.base.set ?? '')
      setSaid(done.said)
    } catch (error) {
      setTrouble(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const wanted = typed.trim()
  const unchanged = base !== null && wanted === (base.set ?? '')
  const inForce = base === null
    ? 'Reading…'
    : base.set
      ? `${base.set} is set for this project.${base.origin && base.origin !== base.set ? ` Origin’s default is ${base.origin}.` : ''}`
      : base.origin
        ? `Nothing is set, so origin’s default is used: ${base.origin}.`
        : 'Nothing is set, and origin does not say its default branch. Name one.'

  return (
    <>
      <Heading id="project" lead={`Settings for ${project.name}, kept in the project’s own .kehikot/host/settings.json so everyone working on it shares them.`}>
        Project
      </Heading>
      {unavailable ? (
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-3 text-xs" data-base-branch="unavailable">
          {unavailable}
        </p>
      ) : (
        <form
          className="min-w-0 space-y-2 rounded-lg border px-4 py-3.5"
          data-base-branch={base === null ? 'reading' : base.set ? 'set' : 'default'}
          onSubmit={(event) => {
            event.preventDefault()
            if (wanted) void submit(wanted)
            else if (base?.set) void submit(null)
          }}
        >
          <div className="space-y-1">
            <Label htmlFor={field} className="text-sm">
              Base branch
            </Label>
            <p id={`${field}-about`} className="text-muted-foreground text-xs leading-relaxed">
              {BASE_BRANCH_SAID}
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Input
              id={field}
              value={typed}
              onChange={(event) => setTyped(event.currentTarget.value)}
              placeholder={base?.origin ?? 'main'}
              aria-describedby={`${field}-about ${field}-now`}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={busy || base === null}
              className="h-8 w-full font-mono text-xs sm:w-64"
            />
            <Button type="submit" size="sm" className="h-8" disabled={busy || base === null || unchanged}>
              {busy ? 'Checking origin…' : 'Save'}
            </Button>
            {base?.set ? (
              <Button type="button" variant="ghost" size="sm" className="h-8" disabled={busy} onClick={() => void submit(null)}>
                Use origin’s default
              </Button>
            ) : null}
          </div>
          <p id={`${field}-now`} className="text-muted-foreground text-xs" data-base-branch-now>
            {inForce}
          </p>
          {said ? (
            <p role="status" className="text-xs" data-base-branch-said>
              {said}
            </p>
          ) : null}
          {trouble ? (
            <Trouble>
              <GitSaid said={trouble} />
              {isGitReason(trouble) ? (
                <Button type="button" variant="outline" size="sm" className="ml-2 h-6" disabled={busy} onClick={() => void submit(asked.current)}>
                  Retry
                </Button>
              ) : null}
            </Trouble>
          ) : null}
        </form>
      )}
    </>
  )
}

/** About: which Kehikot this is, the protocol it speaks, and where its notes and its data are. */
function About({ onClose }: { onClose(): void }) {
  const { shown } = useShownVersion()
  const whatsNew = useWhatsNewSetting()
  return (
    <>
      <Heading id="about" lead="Which Kehikot this is, and where to read more.">
        About
      </Heading>
      <Summary icon={KehikotMark} title={APP_NAME}>
        <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_1fr]" data-about>
          <dt className="text-muted-foreground">Version</dt>
          <dd className="font-mono" data-version={shown?.kind ?? 'unknown'}>
            {shown ? (shown.kind === 'app' ? shown.version : `${shown.text} (a development host, not an app release)`) : 'Not known yet'}
          </dd>
          <dt className="text-muted-foreground">Protocol</dt>
          <dd className="font-mono" data-protocol>
            kehikot-module-protocol {PACKAGE_VERSION}
          </dd>
          <dt className="text-muted-foreground">Settings kept</dt>
          <dd>On this computer, for every project; the Project section’s in the project itself.</dd>
        </dl>
      </Summary>
      <div data-whats-new-setting className="divide-y rounded-lg border px-4">
        <SettingRow
          label="Show What’s new after updates"
          description="After Kehikot or a module updates, say what changed — once, when nothing else is open."
          checked={whatsNew.show ?? true}
          disabled={whatsNew.show === null}
          onChange={whatsNew.set}
        />
      </div>
      <Rows>
        <LinkRow
          icon={KehikotMark}
          label="What’s new"
          description="Kehikot and every module: the notes of what you have, and what changed since you last looked."
          onPress={() => {
            onClose()
            setTimeout(openWhatsNew, 0)
          }}
        />
        <LinkRow
          icon={ExternalLink}
          label="All release notes"
          description={`${APP_NAME}’s releases on GitHub, newest first.`}
          onPress={() => openExternal(releasePage(APP_REPO))}
        />
        <LinkRow
          icon={Hammer}
          label="Build your own module"
          description="The guide to making a Kehikot module, from the first question to its first release. In Claude Code, /kehikot-module walks you through it."
          onPress={() => openExternal(BUILD_A_MODULE_GUIDE)}
        />
        <LinkRow
          icon={HardDrive}
          label="Storage overview"
          description="What every module’s data takes in every project, and Kehikot’s own."
          onPress={() => {
            onClose()
            setTimeout(openStorage, 0)
          }}
        />
      </Rows>
    </>
  )
}

/** "Show What's new after updates": read from the host, changed there, and told to whoever shows it. Null until read. */
function useWhatsNewSetting(): { show: boolean | null; set(on: boolean): void } {
  const [show, setShow] = useState<boolean | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    void fetchShowSetting(abort.signal).then((got) => !abort.signal.aborted && setShow(got ?? true))
    const off = onShowChanged(setShow)
    return () => {
      abort.abort()
      off()
    }
  }, [])
  const set = useCallback((on: boolean) => {
    setShow(on)
    void postWhatsNew({ show: on }).then((record) => {
      if (record) announceShow(record.show)
    })
  }, [])
  return { show, set }
}

/**
 * Kehikot's own skills: offered by the host, kept installed by the same sync and
 * the same rules as a module's. "Read and install…" opens the Skills window for
 * them, where the person reads the text before anything is written.
 */
function OwnSkills({
  row,
  disabled,
  onOut,
}: {
  row: RowData
  disabled: boolean
  onOut(module: string, out: boolean): void
}) {
  const [reading, setReading] = useState(false)
  return (
    <section aria-labelledby="settings-own-skills" className="min-w-0 space-y-2" data-own-skills>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h4 id="settings-own-skills" className="flex items-center gap-2 text-sm font-medium">
            <KehikkoMark working={false} className="text-muted-foreground size-3.5 shrink-0" />
            Kehikot’s own skills
          </h4>
          <p className="text-muted-foreground text-xs">Skills Kehikot itself offers, such as /kehikot-module to build a module of your own.</p>
        </div>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setReading(true)}>
          Read and install…
        </Button>
      </div>
      <ul className="divide-y rounded-lg border">
        <ModuleRow row={row} keep="keep installed" disabled={disabled} onOut={onOut} />
      </ul>
      {reading ? <SkillsDialog open onOpenChange={setReading} module={OWN_SKILLS_MODULE} name="Kehikot" /> : null}
    </section>
  )
}

/* ---- the pieces every section is made of ---- */

function Heading({ id, lead, children }: { id: string; lead: string; children: ReactNode }) {
  return (
    <header className="min-w-0 space-y-1 pr-16">
      <h3 id={`settings-${id}`} className="text-base font-semibold">
        {children}
      </h3>
      <p className="text-muted-foreground text-xs leading-relaxed">{lead}</p>
    </header>
  )
}

/** The small card at the top of a section: what is so now. */
function Summary({ icon: Icon, title, children }: { icon: IconLike; title: string; children: ReactNode }) {
  return (
    <Card className="gap-0 rounded-lg px-4 py-3 shadow-none">
      <div className="flex min-w-0 items-start gap-3">
        <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md" aria-hidden>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-muted-foreground mb-0.5 text-[11px] font-medium tracking-wide uppercase">{title}</p>
          {children}
        </div>
      </div>
    </Card>
  )
}

/** A group of rows in one bordered box, a hairline between each. */
function Rows({ children }: { children: ReactNode }) {
  return <div className="divide-y rounded-lg border px-4">{children}</div>
}

/** One setting: its label and one line about it on the left, its switch on the right. */
function SettingRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  compact = false,
}: {
  label: ReactNode
  description?: ReactNode
  checked: boolean
  onChange(on: boolean): void
  disabled?: boolean
  compact?: boolean
}) {
  const id = useId()
  return (
    <div className={cn('flex min-w-0 items-start justify-between gap-4', compact ? 'py-2.5' : 'py-3.5')} data-disabled={disabled ? 'true' : undefined}>
      <div className={cn('min-w-0 space-y-1', disabled && 'opacity-60')}>
        <Label htmlFor={id} className={cn('leading-snug', compact ? 'text-xs font-normal' : 'text-sm')}>
          {label}
        </Label>
        {description ? (
          <p id={`${id}-about`} className="text-muted-foreground text-xs leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-describedby={description ? `${id}-about` : undefined}
        className="mt-0.5"
      />
    </div>
  )
}

/** A row that opens something: the About section's links. */
function LinkRow({ icon: Icon, label, description, onPress }: { icon: IconLike; label: string; description: string; onPress(opener: HTMLElement): void }) {
  return (
    <button
      type="button"
      onClick={(event) => onPress(event.currentTarget)}
      className="hover:bg-accent/50 focus-visible:ring-ring/50 -mx-4 flex w-[calc(100%+2rem)] min-w-0 items-center gap-3 px-4 py-3 text-left outline-none first:rounded-t-lg last:rounded-b-lg focus-visible:ring-[3px]"
    >
      <span className="text-muted-foreground flex shrink-0" aria-hidden>
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="text-muted-foreground block text-xs">{description}</span>
      </span>
    </button>
  )
}

type Tone = 'ok' | 'quiet' | 'warn' | 'bad'

const TONE_CLASS: Record<Tone, string> = {
  ok: 'border-emerald-600/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  quiet: 'text-muted-foreground',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
  bad: 'border-destructive/40 bg-destructive/10 text-destructive',
}

/** A status in words, tinted; the words alone say it. */
function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Badge variant="outline" className={cn('h-5 rounded-full px-2 text-[11px] font-normal', TONE_CLASS[tone])} data-tone={tone}>
      {children}
    </Badge>
  )
}

function toolTone(state: ToolState, answering: boolean): Tone {
  if (state === 'connected') return answering ? 'ok' : 'quiet'
  if (state === 'failed') return 'bad'
  if (state === 'conflict' || state === 'refused') return 'warn'
  return 'quiet'
}

const SKILL_TONE: Record<SkillState, Tone> = {
  installed: 'ok',
  absent: 'quiet',
  excepted: 'quiet',
  outdated: 'warn',
  edited: 'warn',
  taken: 'warn',
  failed: 'bad',
  bound: 'quiet',
}

/** One module's row in a "Which modules" list: its statuses as chips, and any longer sentences under them. */
interface RowData {
  id: string
  name: string
  out: boolean
  chips: { text: string; tone: Tone }[]
  notes?: string[]
}

/**
 * A module's skills as chips. A kehikko-bound skill (protocol 2.12.0) is said in
 * a sentence of its own instead — where it works — since it is never installed
 * for every conversation; one the person changed keeps its chip too.
 */
function skillChips(skills: readonly { name: string; state: SkillState; bound?: string }[]): Pick<RowData, 'chips' | 'notes'> {
  return {
    chips: skills
      .filter((skill) => skill.state !== 'bound')
      .map((skill) => ({ text: `/${skill.name} · ${SKILL_STATE_SAYS[skill.state]}`, tone: SKILL_TONE[skill.state] })),
    notes: skills.flatMap((skill) => (skill.bound ? [`/${skill.name} · ${skill.bound}`] : [])),
  }
}

/** Which modules: a searchable list, each with its status in chips and a switch to keep it or leave it out. */
function ModuleExceptions({
  kind,
  rows,
  keep,
  disabled,
  onOut,
}: {
  kind: 'tools' | 'skills'
  rows: RowData[]
  keep: string
  disabled: boolean
  onOut(module: string, out: boolean): void
}) {
  const [query, setQuery] = useState('')
  const heading = useId()
  const wanted = query.trim().toLowerCase()
  const shown = wanted ? rows.filter((row) => row.name.toLowerCase().includes(wanted) || row.id.toLowerCase().includes(wanted)) : rows
  const out = rows.filter((row) => row.out).length
  return (
    <section aria-labelledby={heading} className="min-w-0 space-y-2" data-exceptions={kind}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h4 id={heading} className="text-sm font-medium">
            Which modules
          </h4>
          <p className="text-muted-foreground text-xs">
            {disabled
              ? 'Turn on the setting above to choose modules.'
              : `Turn one off to leave it to you.${out ? ` ${out} of ${rows.length} left to you.` : ''}`}
          </p>
        </div>
        <div className="relative w-full sm:w-56">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" aria-hidden />
          <Input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search modules" aria-label="Search modules" className="h-8 pl-8 text-xs" />
        </div>
      </div>
      {shown.length ? (
        <ul className="divide-y rounded-lg border" aria-labelledby={heading}>
          {shown.map((row) => (
            <ModuleRow key={row.id} row={row} keep={keep} disabled={disabled} onOut={onOut} />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-3 text-xs">No module matches “{query.trim()}”.</p>
      )}
    </section>
  )
}

function ModuleRow({
  row,
  keep,
  disabled,
  onOut,
}: {
  row: RowData
  keep: string
  disabled: boolean
  onOut(module: string, out: boolean): void
}) {
  const id = useId()
  return (
    <li className="flex min-w-0 items-center gap-3 px-4 py-2.5" data-module={row.id}>
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className="text-sm">
          <ModuleIcon id={row.id} name={row.name} className="text-muted-foreground size-3.5" />
          {row.name}
        </Label>
        <div className="mt-1 flex flex-wrap gap-1">
          {row.out ? <Chip tone="quiet">Left to you</Chip> : row.chips.map((chip) => <Chip key={chip.text} tone={chip.tone}>{chip.text}</Chip>)}
        </div>
        {row.notes?.map((note) => (
          <p key={note} className="text-muted-foreground mt-1 min-w-0 text-[11px] leading-snug break-words" data-note>
            {note}
          </p>
        ))}
      </div>
      {/* Named with what it does, "Browser: keep connected": the visible name alone would not say. */}
      <Switch id={id} aria-label={`${row.name}: ${keep}`} checked={!row.out} disabled={disabled} onCheckedChange={(on) => onOut(row.id, !on)} />
    </li>
  )
}

function Trouble({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="border-destructive/40 bg-destructive/5 text-destructive flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

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

/** Close a window, then open Settings over where it was; at one section when named. */
export function toSettings(close: () => void, section?: SettingsSection): void {
  close()
  setTimeout(() => openSettings(section), 0)
}
