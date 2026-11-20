import {
  AlertTriangle,
  Bell,
  Blocks,
  Check,
  CircleDot,
  ClipboardCopy,
  ExternalLink,
  FolderGit2,
  FolderOpen,
  Hammer,
  HardDrive,
  MessagesSquare,
  Palette,
  Plug,
  Search,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { PACKAGE_VERSION } from 'kehikot-module-protocol'
import { useCallback, useEffect, useId, useRef, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react'
import { Loading } from '@/components/ui/loading.tsx'

import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Card } from '@/components/ui/card.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { ModalBody, ModalContent, ModalHeader } from '@/components/ui/modal.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { ScrollArea } from '@/components/ui/scroll-area.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import { cn } from '@/lib/utils'
import {
  active,
  chordSaid,
  heldSays,
  isSettingsChord,
  moduleOfPage,
  modulePage,
  onMac,
  onOpenSettings,
  openModuleSettings,
  scopeHeading,
  scopeLead,
  scopeOfPage,
  SKILL_STATE_SAYS,
  skillsSaid,
  START_HOOK_WHERE,
  toolSays,
  toolsSaid,
  type SettingsAnswer,
  type SetupHolder,
  type SettingsPage,
  type SettingsScope,
  type SettingsSection,
  SETTINGS_TARGETS,
  type SkillState,
  type ToolState,
} from '@/host/agentSettings.ts'
import { AUTO_UPDATES } from '@/host/autoUpdates.ts'
import { DevelopmentSetting } from './Development.tsx'
import { isGitReason } from '@/host/gitSaid.ts'
import { BASE_BRANCH_SAID, fetchBaseBranch, setBaseBranch, type BaseBranch, type Project } from '@/host/projects.ts'
import { notAnswering } from '@/host/reachable.ts'
import { BUILD_A_MODULE_GUIDE, OWN_SKILLS_MODULE } from '@/host/skills.ts'
import { SkillsDialog } from './Skills.tsx'
import { fetchSettings, postSettings, useAgentSettings, type Change } from '@/host/settingsClient.ts'
import { APP_NAME, APP_REPO, openExternal, releasePage } from '@/host/releaseNotes.ts'
import { openStorage } from '@/host/storage.ts'
import { TRACKERS_ARE_FOR } from '@/host/trackerSources.ts'
import { TRACKER_NEWS_WORDS } from '@/host/trackerNews.ts'
import { LIT_ROW, TrackerSourcesSettings, type TrackersDoor } from './TrackerSettings.tsx'
import { fetchUntracked, postRetrack } from '@/host/adoptClient.ts'
import { NOTICE_EVENTS, NOTICE_WORDS, type NoticeEvent, type NoticeScope, type NoticeSettings } from '@/host/trackerNotices.ts'
import { useShownVersion } from './AppVersion.tsx'
import { GitSaid } from './GitSaid.tsx'
import { KehikkoMark } from './Mark.tsx'
import { ModuleIcon } from './ModuleIcon.tsx'
import { GITHUB_SHARE, GITHUB_SHARE_TARGET, SHARE_PERCENT, shareFromInput } from '@/host/githubShare.ts'
import { revealTarget, TARGET_ATTR } from '@/host/settingsTarget.ts'
import { ModuleSettingsForm, type SettingsApi } from './ModuleSettings.tsx'
import { KEHIKKO_SECTION_SAID, KehikkoPage, kehikkoSectionsOf, type KehikkoRef, type RenameResult } from './KehikkoSettings.tsx'
import { onOpenKehikkoSettings, type KehikkoSection } from '@/host/kehikkoSettings.ts'
import { onOpenKehikkoSkills } from '@/host/kehikkoSkills.ts'
import { AppearanceSettings } from './AppearanceSettings.tsx'
import { announceShow, fetchShowSetting, onShowChanged, openWhatsNew, postWhatsNew } from '@/host/whatsNew.ts'

/* The settings client is `host/settingsClient.ts`, so a module's Tools and Skills windows
   need not import this one back; the page reads it from here too. */
export { fetchSettings, postSettings } from '@/host/settingsClient.ts'

/**
 * Settings: every setting, grouped by where its effect applies (`SettingsScope` in
 * `host/agentSettings.ts`): this computer, the project on screen, one kehikko, and
 * one module's own settings. A setting sits under the scope it is stored at, and
 * each page begins with one sentence of what it affects (`scopeLead`).
 * (`host/agentSettings.ts` has the shape and the words of the agent setup,
 * `server/agentSync.ts` what is done with it.) Whether the person's agent uses every module's tools and skills
 * outside Kehikot is the agent module's own setting (protocol 2.91.0,
 * `agent.setup`): the Module tools and Skills sections show what is set up, and
 * say where it is chosen.
 *
 * Three pieces, here and beside it so the words stay together:
 *
 *  - `AgentSettingsHost`, mounted once by the page: opens the dialog when anything
 *    calls `openSettings()` — the gear in the strip, ⌘, (Ctrl+, off a Mac), the
 *    projects menu, a module's Tools or Skills window, the sync's line in the
 *    Inbox, and the desktop shell's own event — at a module's page for
 *    `openModuleSettings` (its row in the modules menu), and at a kehikko's pages
 *    for `openKehikkoSettings` (the gear on a row of the kehikko menu).
 *  - `SettingsDialog` and its body: the nav on the left, one tab list per scope
 *    under that scope's heading, and one page at a time on the right — a summary
 *    card, then each setting as a row with its switch. A change is sent as it is
 *    made and said "Saved"; there is no Save button for a switch.
 *  - `KeptBySettings` (`./KeptBySettings.tsx`): the line a module's Tools or Skills window shows.
 *
 * Every state is a word, never a colour alone; every switch has its label, the
 * nav is a tab list a keyboard walks with the arrows, and focus is always ringed.
 */

/** The words of "Keep this project's modules running" (`server/keepRunning.ts`). */
export const KEEP_RUNNING = {
  label: 'Keep this project’s modules running',
  description:
    'Every module on any kehikko of this project is started in the background and kept running, so switching kehikko shows it at once. ' +
    'Each running module’s server takes roughly 100–300 MB of memory. Off, only the open kehikko’s modules run for it, and the others stop five minutes after you leave them. ' +
    'A module another project keeps running stays up for that project.',
  /** Said under the switch: it is this project's, not the computer's. */
  applies: (name: string) => `Applies only to the project ${name}.`,
} as const

/** The open project, as the Project section needs it. */
export type SettingsProject = Pick<Project, 'id' | 'name' | 'git' | 'home' | 'missing'>

/** How the Project section reads and sets the base branch; injectable for tests. */
export interface BaseBranchDoor {
  load: typeof fetchBaseBranch
  save: typeof setBaseBranch
}

const BASE_BRANCH_DOOR: BaseBranchDoor = { load: fetchBaseBranch, save: setBaseBranch }

/** Mounted once by the page: ⌘, and the dialog wherever it is asked for. */
export function AgentSettingsHost({
  load = fetchSettings,
  save = postSettings,
  project = null,
  modules = [],
  trackers = null,
  kehikot = [],
  kehikko = null,
  onRename = async () => ({ ok: false, why: 'Kehikot cannot rename a kehikko here.' }),
  kehikkoApi,
}: {
  kehikkoApi?: KehikkoApi
  load?: typeof fetchSettings
  save?: typeof postSettings
  project?: SettingsProject | null
  modules?: readonly ModuleRef[]
  /** The open project's tracker reading, for Settings › Trackers; null with no project open. */
  trackers?: TrackersDoor | null
  /** Every kehikko the page knows, for a link that names one (the gear on a kehikko menu row). */
  kehikot?: readonly KehikkoRef[]
  /** The kehikko on screen: the Kehikko pages are its own unless a link named another. */
  kehikko?: KehikkoRef | null
  onRename?(id: number, name: string): Promise<RenameResult>
} = {}) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<SettingsPage>('tools')
  /* Which kehikko a link named; null is the one on screen. */
  const [named, setNamed] = useState<number | null>(null)
  /* The control a link named, until it has been shown. */
  const [target, setTarget] = useState<string | null>(null)

  useEffect(() => {
    const off = [
      onOpenSettings((at, to, link) => {
        if (link.module) setPage(modulePage(link.module))
        else if (at) setPage(at)
        setNamed(null)
        setTarget(to)
        setOpen(true)
      }),
      onOpenKehikkoSettings((link) => {
        setNamed(link.kehikko)
        setPage(`kehikko-${link.section ?? 'general'}`)
        setTarget(link.target)
        setOpen(true)
      }),
      onOpenKehikkoSkills(() => {
        setNamed(null)
        setPage('kehikko-skills')
        setTarget(null)
        setOpen(true)
      }),
    ]
    return () => off.forEach((one) => one())
  }, [])

  /* ⌘, on a Mac, Ctrl+, elsewhere — in a text field too, where it types nothing. */
  useEffect(() => {
    const mac = onMac()
    const onKey = (event: KeyboardEvent) => {
      if (!isSettingsChord(event, mac)) return
      event.preventDefault()
      setNamed(null)
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const shownKehikko = (named !== null ? kehikot.find((one) => one.id === named) : null) ?? kehikko

  return (
    <>
      <SettingsDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setTarget(null)
        }}
        load={load}
        save={save}
        section={page}
        onSection={setPage}
        project={project}
        modules={modules}
        trackers={trackers}
        kehikko={shownKehikko}
        onRename={onRename}
        kehikkoApi={kehikkoApi}
        target={target}
        onTargetShown={() => setTarget(null)}
      />
    </>
  )
}

/** An icon slot: a Lucide icon, or Kehikot's own mark where Kehikot itself is meant. */
type IconLike = LucideIcon | ComponentType<{ className?: string }>

/** Kehikot's own mark, as an icon slot takes one: the same frame as the bar's, still. */
function KehikotMark({ className }: { className?: string }) {
  return <KehikkoMark working={false} className={className} />
}

/**
 * A registered module as Settings lists it. `settings`: it declared settings of its own, so it has
 * a page under Modules.
 */
export type ModuleRef = {
  id: string
  name: string
  icon?: string | null
  settings?: boolean
  events?: readonly { id: string; says: string; state: 'working' | 'attention' | 'done'; sound?: string }[]
}

const SECTION_SAID: Record<Exclude<SettingsSection, `kehikko-${string}`>, { title: string; icon: IconLike }> = {
  tools: { title: 'Module tools', icon: Plug },
  skills: { title: 'Skills', icon: Sparkles },
  hook: { title: 'Conversations', icon: MessagesSquare },
  notices: { title: 'Trackers', icon: Bell },
  modules: { title: 'Modules', icon: Blocks },
  development: { title: 'Development', icon: Hammer },
  appearance: { title: 'Appearance', icon: Palette },
  about: { title: 'About', icon: KehikotMark },
  project: { title: 'Base branch', icon: FolderGit2 },
  trackers: { title: 'Trackers', icon: CircleDot },
}

/** A page's title and icon in the nav. */
function pageSaid(page: SettingsPage, modules: readonly ModuleRef[]): { title: string; icon: IconLike; module?: ModuleRef } {
  const module = moduleOfPage(page)
  if (module !== null) {
    const ref = modules.find((one) => one.id === module) ?? { id: module, name: module }
    const icon: ComponentType<{ className?: string }> = ({ className }) => <ModuleIcon id={ref.id} icon={ref.icon ?? undefined} name={ref.name} className={className} />
    return { title: ref.name, icon, module: ref }
  }
  if (page.startsWith('kehikko-')) {
    const { title, icon } = KEHIKKO_SECTION_SAID[page.slice('kehikko-'.length) as KehikkoSection]
    return { title, icon }
  }
  return SECTION_SAID[page as keyof typeof SECTION_SAID]
}

/** The pages under each scope, as the nav lists them: a scope with none is not shown. */
export function pagesOf({
  answer,
  project,
  trackers,
  kehikko,
  modules,
}: {
  answer: SettingsAnswer | null
  project: SettingsProject | null
  trackers: TrackersDoor | null
  kehikko: KehikkoRef | null
  modules: readonly ModuleRef[]
}): { scope: SettingsScope; name: string | null; pages: SettingsPage[] }[] {
  const app: SettingsPage[] = ['tools', 'skills', 'hook', ...(answer?.notices || answer?.github ? (['notices'] as const) : []), 'modules', 'development', 'appearance', 'about']
  const inProject: SettingsPage[] = [...(project ? (['project'] as const) : []), ...(trackers ? (['trackers'] as const) : [])]
  const inKehikko: SettingsPage[] = kehikko ? kehikkoSectionsOf(kehikko).map((one) => `kehikko-${one}` as const) : []
  const ofModules: SettingsPage[] = modules
    .filter((one) => one.settings)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((one) => modulePage(one.id))
  return [
    { scope: 'app' as const, name: null, pages: app },
    { scope: 'project' as const, name: project?.name ?? null, pages: inProject },
    { scope: 'kehikko' as const, name: kehikko?.name ?? null, pages: inKehikko },
    { scope: 'module' as const, name: null, pages: ofModules },
  ].filter((group) => group.pages.length > 0)
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
  modules = [],
  target = null,
  onTargetShown,
  trackers = null,
  kehikko = null,
  onRename,
  modulesApi,
  kehikkoApi,
}: {
  kehikkoApi?: KehikkoApi
  /** The open project's tracker reading, for Settings › Trackers. */
  trackers?: TrackersDoor | null
  open: boolean
  onOpenChange(open: boolean): void
  /** A control to scroll to, focus and light once its page shows (`openSettings(section, target)`). */
  target?: string | null
  onTargetShown?(): void
  load?: typeof fetchSettings
  save?: typeof postSettings
  /** Which page is shown; the dialog keeps its own when not given. */
  section?: SettingsPage
  onSection?(section: SettingsPage): void
  /** The open project; the Project scope is shown only with one. */
  project?: SettingsProject | null
  baseBranch?: BaseBranchDoor
  modules?: readonly ModuleRef[]
  /** The kehikko the Kehikko scope is for; none, no Kehikko scope. */
  kehikko?: KehikkoRef | null
  onRename?(id: number, name: string): Promise<RenameResult>
  /** How a module's page asks the host; for tests. */
  modulesApi?: SettingsApi
}) {
  const { answer, trouble, busy, saved, read, change } = useAgentSettings(open, load, save)
  const [own, setOwn] = useState<SettingsPage>('tools')
  const section = given ?? own
  const setSection = setGiven ?? setOwn

  /*
   * A link named a control: show it as soon as it is on the page. What draws it may still be reading
   * (the answer, a module's form, a kehikko's agents), so it is looked for again for a while.
   */
  useEffect(() => {
    if (!open || !target) return
    let tries = 0
    let every: ReturnType<typeof setInterval> | undefined
    const look = () => {
      if (revealTarget(document, target)) {
        clearInterval(every)
        onTargetShown?.()
      } else if (++tries > 60) clearInterval(every)
    }
    const frame = requestAnimationFrame(() => {
      look()
      if (tries > 0) every = setInterval(look, 100)
    })
    return () => {
      cancelAnimationFrame(frame)
      clearInterval(every)
    }
  }, [open, target, answer, section, onTargetShown])

  /* What the sync finds lands a moment after a change; read again while the window is open. */
  useEffect(() => {
    if (!open) return
    const every = setInterval(() => void read(), 4000)
    return () => clearInterval(every)
  }, [open, read])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ModalContent
        className="h-[min(720px,calc(100dvh-2rem))] sm:max-w-4xl"
        data-settings=""
        onOpenAutoFocus={(event) => {
          /* Focus starts on the page's own tab, so a link's page is where the keyboard is. */
          const tab = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
          if (!tab) return
          event.preventDefault()
          tab.focus()
        }}
      >
        <ModalHeader
          icon={<KehikkoMark working={false} className="text-muted-foreground size-4" />}
          title="Settings"
          description="Grouped by what they apply to: this computer, the open project, this kehikko, and each module’s own."
          descriptionClassName="max-sm:sr-only"
        />
        <ModalBody scroll={false}>
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
          modules={modules}
          trackers={trackers}
          kehikko={kehikko}
          onRename={onRename}
          modulesApi={modulesApi}
          kehikkoApi={kehikkoApi}
          open={open}
        />
        </ModalBody>
      </ModalContent>
    </Dialog>
  )
}

/** The dialog's inside: the nav, one tab list per scope, and the pages, drawn from one answer. Exported for tests. */
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
  modules = [],
  trackers = null,
  kehikko = null,
  onRename = async () => ({ ok: false, why: 'Kehikot cannot rename a kehikko here.' }),
  open = true,
  kehikkoApi,
}: {
  kehikkoApi?: KehikkoApi
  /** The open project's tracker reading, for Settings › Trackers; null with no project open. */
  trackers?: TrackersDoor | null
  answer: SettingsAnswer | null
  trouble?: string | null
  busy: boolean
  /** How many changes were taken; each new one says "Saved" for a moment. */
  saved?: number
  section: SettingsPage
  onSection(section: SettingsPage): void
  onChange(what: Change): void
  onClose?(): void
  project?: SettingsProject | null
  baseBranch?: BaseBranchDoor
  /** How a module's page asks the host; for tests. */
  modulesApi?: SettingsApi
  /** The modules the host knows: a page for each that declared settings, and a sound of one module's own. */
  modules?: readonly ModuleRef[]
  kehikko?: KehikkoRef | null
  onRename?(id: number, name: string): Promise<RenameResult>
  /** Whether the dialog is open: a module's form and a kehikko's skills read only then. */
  open?: boolean
}) {
  const groups = pagesOf({ answer, project, trackers, kehikko, modules })
  const every = groups.flatMap((group) => group.pages)
  const shown: SettingsPage = every.includes(section) ? section : moduleOfPage(section) !== null ? 'modules' : 'tools'
  const scope = scopeOfPage(shown)
  const said = pageSaid(shown, modules)
  const scopeName = scope === 'project' ? (project?.name ?? null) : scope === 'kehikko' ? (kehikko?.name ?? null) : scope === 'module' ? said.title : null
  const problems = answer?.status.problems.length ?? 0
  const page: Omit<PageProps, 'page'> = { shown, said, answer, trouble, onChange, onClose, project, baseBranch, modulesApi, modules, trackers, kehikko, onRename, open, kehikkoApi }

  return (
    <Tabs
      value={shown}
      onValueChange={(value) => onSection(value as SettingsPage)}
      /* One tab list per scope: Tab walks from list to list without changing the page; the arrows move
         within one, and Enter, Space or a click opens the page. */
      activationMode="manual"
      orientation="vertical"
      className="flex min-h-0 flex-1 flex-col gap-0 sm:flex-row"
    >
      <SettingsNav groups={groups} modules={modules} problems={problems} />

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" aria-busy={busy}>
        <SavedNote saved={saved} />
        <ScrollArea className="min-h-0 flex-1" data-modal-scroll="">
          <div className="flex min-w-0 flex-col gap-4 px-5 py-5 sm:px-6">
            {/* What the page shown applies to, in one sentence, above everything on it. */}
            <p className="text-muted-foreground -mb-1 pr-16 text-xs" data-scope-lead={scope}>
              <span className="text-foreground font-medium">{scopeHeading(scope, scope === 'module' ? null : scopeName)}</span>
              {' · '}
              {scopeLead(scope, scopeName)}
            </p>
            {trouble && scope === 'app' ? <Trouble>{trouble}</Trouble> : null}
            {every.map((key) => (
              <TabsContent key={key} value={key} forceMount className="flex min-w-0 flex-col gap-5 data-[state=inactive]:hidden">
                <PageView page={key} {...page} />
              </TabsContent>
            ))}
          </div>
        </ScrollArea>
      </div>
    </Tabs>
  )
}

/** The dialog's nav: one tab list per scope, under the scope's heading, and the chord that opens Settings. */
function SettingsNav({ groups, modules, problems }: { groups: ReturnType<typeof pagesOf>; modules: readonly ModuleRef[]; problems: number }) {
  return (
    <aside className="bg-muted/40 flex max-h-40 shrink-0 flex-col overflow-y-auto border-b sm:max-h-none sm:min-h-0 sm:w-56 sm:border-r sm:border-b-0" data-settings-nav>
      {groups.map((group) => {
        const heading = `settings-scope-${group.scope}`
        return (
          <div key={group.scope} className="px-2 pt-2 last:pb-2" data-settings-scope={group.scope}>
            <h3 id={heading} className="text-muted-foreground truncate px-2.5 pt-1 pb-1 text-[11px] font-medium tracking-wide uppercase" title={scopeHeading(group.scope, group.name)}>
              {scopeHeading(group.scope, group.name)}
            </h3>
            <TabsList aria-labelledby={heading} className="h-auto w-full flex-wrap justify-start gap-0.5 rounded-none bg-transparent p-0 sm:flex-col sm:flex-nowrap sm:items-stretch">
              {group.pages.map((key) => (
                <NavTab key={key} page={key} modules={modules} problems={problems} />
              ))}
            </TabsList>
          </div>
        )
      })}
      <p className="text-muted-foreground mt-auto hidden px-4 pt-3 pb-4 text-[11px] sm:block">
        Open Settings with <kbd className="bg-background rounded border px-1 font-sans">{chordSaid(onMac())}</kbd>
      </p>
    </aside>
  )
}

/** One page's tab in the nav: its icon and title, and on Tools how many were left alone. */
function NavTab({ page, modules, problems }: { page: SettingsPage; modules: readonly ModuleRef[]; problems: number }) {
  const { title, icon: Icon } = pageSaid(page, modules)
  return (
    <TabsTrigger
      value={page}
      data-section={page}
      className="text-muted-foreground hover:text-foreground data-[state=active]:text-foreground h-8 min-w-0 flex-none justify-start gap-2 px-2.5 text-[13px] font-normal data-[state=active]:font-medium"
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{title}</span>
      {page === 'tools' && problems > 0 ? (
        <span className="ml-auto rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-700 tabular-nums dark:text-amber-300">
          {problems}
          <span className="sr-only"> left alone</span>
        </span>
      ) : null}
    </TabsTrigger>
  )
}

interface PageProps {
  /** The page this is. */
  page: SettingsPage
  /** The page shown now: some pages draw only while they are. */
  shown: SettingsPage
  said: ReturnType<typeof pageSaid>
  answer: SettingsAnswer | null
  trouble: string | null
  onChange(what: Change): void
  onClose(): void
  project: SettingsProject | null
  baseBranch: BaseBranchDoor
  modulesApi: SettingsApi | undefined
  modules: readonly ModuleRef[]
  trackers: TrackersDoor | null
  kehikko: KehikkoRef | null
  onRename(id: number, name: string): Promise<RenameResult>
  open: boolean
  kehikkoApi: KehikkoApi | undefined
}

/** What one page of the dialog holds. */
function PageView({ page, shown, said, answer, trouble, onChange, onClose, project, baseBranch, modulesApi, modules, trackers, kehikko, onRename, open, kehikkoApi }: PageProps) {
  const module = moduleOfPage(page)
  if (module !== null) {
    /* Only while it is shown: its form asks the module. */
    const shownModule = moduleOfPage(shown)
    if (shownModule !== module) return null
    return <ModulePage module={said.module ?? { id: shownModule!, name: shownModule! }} project={project} api={modulesApi} open={open} onOpened={onClose} />
  }
  if (page.startsWith('kehikko-')) {
    if (shown !== page || !kehikko) return null
    return <KehikkoPage kehikko={kehikko} section={page.slice('kehikko-'.length) as KehikkoSection} active={open} onRename={onRename} {...kehikkoApi} />
  }
  switch (page) {
    case 'about':
      return <About onClose={onClose} />
    case 'appearance':
      /* Only while it is shown, like Modules: its controls are nobody else's to find. */
      return shown === 'appearance' ? <AppearanceSettings onChange={onChange} modules={modules} /> : null
    case 'trackers':
      return <ProjectTrackers door={trackers} projectName={project?.name ?? null} projectId={project?.id ?? null} />
    case 'project':
      return project ? (
        <>
          <ProjectSettings project={project} door={baseBranch} />
          <ProjectModules project={project} answer={answer} onChange={onChange} />
        </>
      ) : null
    case 'modules':
      return <ModulesPage answer={answer} onChange={onChange} modules={modules} />
    case 'development':
      /* Where the official modules run from: Kehikot's releases, or your own folders. Machine-wide. */
      return shown === 'development' ? <DevelopmentPage /> : null
  }
  if (answer) return <Section which={page as SectionKey} answer={answer} onChange={onChange} />
  return !trouble ? <Loading className="text-sm" label="Reading the settings…" /> : null
}

type SectionKey = 'tools' | 'skills' | 'hook' | 'notices'

/** How the Kehikko pages read and write; for tests. */
export type KehikkoApi = Pick<ComponentProps<typeof KehikkoPage>, 'load' | 'save' | 'skills'>

/**
 * App › Modules: how modules are kept on this computer — updated by themselves, and kept running —
 * and where each module's own settings are.
 */
function ModulesPage({ answer, onChange, modules }: { answer: SettingsAnswer | null; onChange(what: Change): void; modules: readonly ModuleRef[] }) {
  const own = modules.filter((one) => one.settings).length
  return (
    <>
      <Heading id="modules" lead="How Kehikot keeps your modules on this computer. Install, update, stop or uninstall one from Kehikko modules in the bar.">
        Modules
      </Heading>
      {answer?.updates ? (
        <Rows>
          {answer.updates ? (
            /* Machine-wide, like the rest of this scope; mirrored at the top of the Updates menu. */
            <div data-auto-updates-setting>
              <SettingRow label={AUTO_UPDATES.label} description={AUTO_UPDATES.description} checked={answer.updates.auto} onChange={(auto) => onChange({ updates: { auto } })} />
            </div>
          ) : null}
        </Rows>
      ) : !answer ? (
        <Loading className="text-sm" label="Reading the settings…" />
      ) : null}
      <p className="text-muted-foreground text-xs leading-relaxed" data-modules-own>
        {own
          ? `A module’s own settings are on its page under Modules (${own} module${own === 1 ? ' has' : 's have'} settings), behind the gear on its container, and behind “Settings…” on its row in Kehikko modules.`
          : 'No module here has settings of its own. A module that has them gets a page under Modules, a gear on its container and “Settings…” on its row in Kehikko modules.'}
      </p>
    </>
  )
}

/** App › Development: where the official modules run from. */
function DevelopmentPage() {
  return (
    <>
      <Heading id="development" lead="Whether modules run from Kehikot’s releases or from your own folders, and where each one runs from now.">
        Development
      </Heading>
      <DevelopmentSetting />
    </>
  )
}

/** Modules › <name>: one module's own settings, for the open project, saved by the module. */
function ModulePage({ module, project, api, open, onOpened }: { module: ModuleRef; project: SettingsProject | null; api?: SettingsApi; open: boolean; onOpened(): void }) {
  return (
    <section className="flex min-w-0 flex-col gap-4" aria-labelledby={`settings-module-${module.id}`} data-settings-module={module.id}>
      <header className="min-w-0 space-y-1 pr-16">
        <h3 id={`settings-module-${module.id}`} className="flex items-center gap-2 text-base font-semibold">
          <ModuleIcon id={module.id} icon={module.icon ?? undefined} name={module.name} className="text-muted-foreground size-4" />
          {module.name}
        </h3>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {project ? `For ${project.name}, where a setting is the project’s; a setting marked “for this computer” is the same everywhere. ` : ''}
          Each change is saved by {module.name} as you make it.
        </p>
      </header>
      {open ? <ModuleSettingsForm module={module.id} name={module.name} project={project?.id ?? null} api={api} onOpened={onOpened} /> : null}
    </section>
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

function Section({ which, answer, onChange }: { which: SectionKey; answer: SettingsAnswer; onChange(what: Change): void }) {
  const { settings, status, hook } = answer

  if (which === 'tools') {
    const doors = status.modules.filter((one) => one.tools !== null)
    return (
      <>
        <Heading id="tools" lead="Each module’s MCP tools, in your agent’s user-wide server list.">
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
        <HeldBy holder={answer.setup} on={active(settings, 'tools')} what="Every module’s tools are kept connected" />
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
      </>
    )
  }

  if (which === 'skills') {
    /* Kehikot's own skills (the host's row) apart from the modules': `server/ownSkills.ts`. */
    const own = status.modules.find((one) => one.id === OWN_SKILLS_MODULE && one.skills.length > 0)
    const offering = status.modules.filter((one) => one.id !== OWN_SKILLS_MODULE && one.skills.length > 0)
    return (
      <>
        <Heading id="skills" lead="Kehikot’s own and each module’s agent skills, in your personal skills folder.">
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
        <HeldBy holder={answer.setup} on={active(settings, 'skills')} what="Every module’s skills are kept installed and up to date" />
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
    /* Trackers, as this computer keeps them: what the Inbox tells you, and Kehikot's share of the GitHub limit. */
    return (
      <>
        {answer.notices ? <TrackerNotices notices={answer.notices} onChange={(notices) => onChange({ notices })} /> : null}
        {answer.github ? (
          <section className="min-w-0 space-y-2" data-trackers-machine>
            <h4 className="text-sm font-medium">GitHub limit</h4>
            <div className="divide-y rounded-lg border px-4">
              <GithubShareRow percent={answer.github.share} onChange={(share) => onChange({ github: { share } })} />
            </div>
          </section>
        ) : null}
      </>
    )
  }

  return (
    <>
      <Heading id="hook" lead="Whether your agent tells Kehikot about a session started somewhere else. Kehikot only reads this; it never writes the file.">
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
            ? 'Reported: when an agent session starts anywhere — a terminal, an editor — the agent module hears of it.'
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

/**
 * Where the agent setup is chosen: the agent module that holds it (protocol 2.91.0, `agent.setup`),
 * with a press that opens its page under Settings › Modules. Its name and program are data from it.
 */
function HeldBy({ holder, on, what }: { holder: SetupHolder | null | undefined; on: boolean; what: string }) {
  return (
    <div className="rounded-lg border px-4 py-3" data-held-by={holder?.module ?? ''}>
      <p className="text-sm font-medium">{on ? `${what}.` : 'Off: nothing is set up for you.'}</p>
      <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{heldSays(holder)}</p>
      {holder ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 h-7"
          data-press="setup-settings"
          onClick={() => openModuleSettings(holder.module)}
        >
          Open {holder.name}’s settings
        </Button>
      ) : null}
    </div>
  )
}

/** Items the person said not to track in this project, each with "Track again" (`inbox.untrack`'s undo). */
function UntrackedItems({ project }: { project: number }) {
  const [list, setList] = useState<{ id: string; ref: string; title: string; at: number }[] | null>(null)
  useEffect(() => {
    let live = true
    void fetchUntracked(project).then((got) => live && setList(got))
    return () => {
      live = false
    }
  }, [project])
  if (!list) return null
  return (
    <section aria-labelledby="settings-untracked" className="min-w-0" data-untracked={list.length}>
      <h4 id="settings-untracked" className="mb-1 text-sm font-medium">
        {NOTICE_WORDS.untracked}
      </h4>
      <p className="text-muted-foreground mb-2 text-xs leading-relaxed">{NOTICE_WORDS.untrackedLead}</p>
      {list.length ? (
        <ul className="overflow-hidden rounded-lg border">
          {list.map((one) => (
            <li key={one.id} className="flex items-center gap-2 border-b px-3 py-2 text-xs last:border-b-0" data-untracked-item={one.id}>
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{one.ref}</span> {one.title}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void postRetrack(project, one.id).then(() => setList((was) => (was ?? []).filter((x) => x.id !== one.id)))}
              >
                {NOTICE_WORDS.retrack}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-xs">None.</p>
      )}
    </section>
  )
}

/** Tracker notices: on or off, how wide, and which events. Every choice a labelled control. */
function TrackerNotices({
  notices,
  onChange,
}: {
  notices: NoticeSettings
  onChange(change: { on?: boolean; scope?: NoticeScope; events?: Partial<Record<NoticeEvent, boolean>>; outside?: boolean }): void
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
            ? `On · ${notices.scope === 'roles' ? 'only where you have a role' : 'also everything your spaces name'} · ${told} of ${NOTICE_EVENTS.length} events`
            : 'Off · the Inbox says nothing from your issue trackers'}
        </p>
      </Summary>
      <Rows>
        <SettingRow label={NOTICE_WORDS.on} checked={notices.on} onChange={(on) => onChange({ on })} />
        <SettingRow label={NOTICE_WORDS.outside} checked={notices.outside !== false} disabled={off} onChange={(outside) => onChange({ outside })} />
      </Rows>
      <fieldset className="min-w-0" data-notices-scope={notices.scope} disabled={off}>
        <legend className="mb-2 text-sm font-medium">Which issues and changes</legend>
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
 * Project › Trackers: where the open project's issues and changes are read from — its sources, how
 * they are read, the news to agents — and the items the person said not to track in it. Kehikot's
 * share of the GitHub limit and the Inbox's tracker notices are this computer's (App › Trackers).
 * The bar's Trackers menu only says what was read and links here (`TrackerReading.tsx`).
 */
function ProjectTrackers({ door, projectName, projectId }: { door: TrackersDoor | null; projectName: string | null; projectId: number | null }) {
  return (
    <>
      <Heading id="trackers" lead={TRACKERS_ARE_FOR}>
        Trackers
      </Heading>
      {door ? (
        <section className="flex min-w-0 flex-col gap-4" data-trackers-project>
          <p className="text-muted-foreground text-xs" data-trackers-for>
            {projectName ? `For ${projectName}. ` : 'For the open project. '}
            Its sources are kept in the project folder; the news switch is saved on this computer, for this project only.
          </p>
          <TrackerSourcesSettings door={door} />
          {door.news ? (
            <section className="min-w-0 space-y-2">
              <h4 className="text-sm font-medium">Agents</h4>
              <div {...{ [TARGET_ATTR]: SETTINGS_TARGETS.trackerNews.target }} className={cn('divide-y rounded-lg border px-4', LIT_ROW)} data-tracker-news={door.news.on ? 'on' : 'off'}>
                <SettingRow
                  label={TRACKER_NEWS_WORDS.title}
                  description={`${TRACKER_NEWS_WORDS.lead} ${door.news.on ? TRACKER_NEWS_WORDS.on : TRACKER_NEWS_WORDS.off} ${TRACKER_NEWS_WORDS.kept}`}
                  checked={door.news.on}
                  onChange={door.news.onChange}
                />
              </div>
            </section>
          ) : null}
        </section>
      ) : (
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-3 text-xs" data-trackers-project="none">
          No project is open. Open one to see and change its sources.
        </p>
      )}
      {projectId !== null ? <UntrackedItems project={projectId} /> : null}
    </>
  )
}

/**
 * Project › Modules: whether this project's modules are kept running. Saved on this computer for this
 * project only (`server/keepRunning.ts`), so it is the person's memory choice for one project and
 * never the project's own file, which everyone working on it shares.
 */
function ProjectModules({ project, answer, onChange }: { project: SettingsProject; answer: SettingsAnswer | null; onChange(what: Change): void }) {
  const said = answer?.modules
  if (!said) return null
  const keep = said.projects[String(project.id)] ?? said.default
  return (
    <>
      <Heading id="project-modules" lead="Which of this project’s modules Kehikot keeps running in the background.">
        Running modules
      </Heading>
      <Rows>
        <div data-keep-running-setting>
          <SettingRow
            label={KEEP_RUNNING.label}
            description={`${KEEP_RUNNING.description} ${KEEP_RUNNING.applies(project.name)}`}
            checked={keep}
            onChange={(next) => onChange({ modules: { project: project.id, keep: next } })}
          />
        </div>
      </Rows>
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
    ? <Loading label="Reading…" />
    : base.set
      ? `${base.set} is set for this project.${base.origin && base.origin !== base.set ? ` Origin’s default is ${base.origin}.` : ''}`
      : base.origin
        ? `Nothing is set, so origin’s default is used: ${base.origin}.`
        : 'Nothing is set, and origin does not say its default branch. Name one.'

  return (
    <>
      <Heading id="project" lead={`Kept in ${project.name}’s folder, so everyone working on it shares it.`}>
        Base branch
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

/** What the module protocol number means, in one line, beneath it in About. */
export const PROTOCOL_MEANING = 'The version of the language Kehikot and its modules use to talk to each other; a module needs a Kehikot at least as new as the one it asks for.'

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
            {shown ? (shown.kind === 'app' ? shown.version : `${shown.text} (a development build, not an app release)`) : 'Not known yet'}
          </dd>
          <dt className="text-muted-foreground">Module protocol</dt>
          <dd data-protocol>
            <span className="font-mono">{PACKAGE_VERSION}</span>
            <span className="text-muted-foreground block" data-protocol-meaning>
              {PROTOCOL_MEANING}
            </span>
          </dd>
          <dt className="text-muted-foreground">Settings kept</dt>
          <dd>On this computer, for every project. The Project section’s settings are kept in the project itself.</dd>
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
      {whatsNew.trouble ? (
        <p role="status" className="text-destructive text-xs" data-whats-new-trouble>
          {whatsNew.trouble}
        </p>
      ) : null}
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
          description="The guide to making a Kehikot module, from the first question to its first release. In your agent, /kehikot-module walks you through it."
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
      <Diagnostics />
    </>
  )
}

/**
 * Kehikot's own logs, for when something went wrong: the folder they are in, and the last lines
 * of the host's and the page's with the versions, copied to paste into a report (`server/readLogs.ts`).
 */
function Diagnostics() {
  const [said, setSaid] = useState<string | null>(null)
  const openFolder = async () => {
    setSaid(null)
    const response = await fetch('/host/logs/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null)
    const body = (await response?.json().catch(() => null)) as { ok?: boolean; error?: string; dir?: string } | null
    setSaid(body?.ok ? `Opened ${body.dir ?? 'the logs folder'}.` : (body?.error ?? 'The logs folder could not be opened.'))
  }
  const copy = async () => {
    setSaid(null)
    try {
      const response = await fetch('/host/diagnostics', { cache: 'no-store' })
      if (!response.ok) throw new Error(String(response.status))
      await navigator.clipboard.writeText(await response.text())
      setSaid('Copied: the versions and the last lines of the host’s and the page’s logs. Secrets are left out.')
    } catch {
      setSaid('The diagnostics could not be copied.')
    }
  }
  return (
    <div data-diagnostics>
      <Rows>
        <LinkRow
          icon={FolderOpen}
          label="Open logs folder"
          description="Kehikot’s own log, the page’s, and every module’s output, kept on this computer."
          onPress={() => void openFolder()}
        />
        <LinkRow
          icon={ClipboardCopy}
          label="Copy recent diagnostics"
          description="The versions and the last lines of Kehikot’s and the page’s logs, to paste into a report."
          onPress={() => void copy()}
        />
      </Rows>
      {said ? (
        <p className="text-muted-foreground mt-2 text-xs" role="status" data-diagnostics-said>
          {said}
        </p>
      ) : null}
    </div>
  )
}

/** "Show What's new after updates": read from the host, changed there, and told to whoever shows it. Null until read. */
function useWhatsNewSetting(): { show: boolean | null; set(on: boolean): void; trouble: string | null } {
  const [show, setShow] = useState<boolean | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    void fetchShowSetting(abort.signal).then((got) => !abort.signal.aborted && setShow(got ?? true))
    const off = onShowChanged(setShow)
    return () => {
      abort.abort()
      off()
    }
  }, [])
  const kept = useRef<boolean | null>(null)
  kept.current = show
  const set = useCallback((on: boolean) => {
    const was = kept.current
    setShow(on)
    void postWhatsNew({ show: on }).then((record) => {
      if (record) {
        setTrouble(null)
        announceShow(record.show)
      } else {
        /* The switch says what is kept: it goes back, and the person is told in words. */
        setShow(was)
        setTrouble('Not saved: Kehikot did not answer. The switch is as it was. Try again.')
      }
    })
  }, [])
  return { show, set, trouble }
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
/** Kehikot's share of the GitHub limit, in whole percent; the control a "Change limit" button opens Settings at. */
function GithubShareRow({ percent, onChange }: { percent: number; onChange(share: number): void }) {
  const id = useId()
  const [text, setText] = useState(String(percent))
  useEffect(() => setText(String(percent)), [percent])
  const commit = () => {
    const next = shareFromInput(text)
    if (next === null) return setText(String(percent))
    setText(String(next))
    if (next !== percent) onChange(next)
  }
  return (
    <div
      {...{ [TARGET_ATTR]: GITHUB_SHARE_TARGET }}
      className="flex min-w-0 items-start justify-between gap-4 py-3.5 transition-colors data-[lit=true]:bg-amber-500/10 data-[lit=true]:ring-2 data-[lit=true]:ring-amber-500/50"
    >
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id} className="text-sm leading-snug">
          {GITHUB_SHARE.label}
        </Label>
        <p id={`${id}-about`} className="text-muted-foreground text-xs leading-relaxed">
          {GITHUB_SHARE.description} From {SHARE_PERCENT.min}% to {SHARE_PERCENT.max}%; {SHARE_PERCENT.default}% unless you change it.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={SHARE_PERCENT.min}
          max={SHARE_PERCENT.max}
          step={1}
          value={text}
          aria-describedby={`${id}-about`}
          className="h-8 w-16 text-right tabular-nums"
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
          }}
        />
        <span className="text-muted-foreground text-xs">%</span>
      </div>
    </div>
  )
}

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
  agent: 'quiet',
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
function skillChips(skills: readonly { name: string; state: SkillState; bound?: string; agent?: string }[]): Pick<RowData, 'chips' | 'notes'> {
  return {
    chips: skills
      .filter((skill) => skill.state !== 'bound' && skill.state !== 'agent')
      .map((skill) => ({ text: `/${skill.name} · ${SKILL_STATE_SAYS[skill.state]}`, tone: SKILL_TONE[skill.state] })),
    notes: skills.flatMap((skill) => (skill.bound ? [`/${skill.name} · ${skill.bound}`] : skill.agent ? [`${skill.name} · ${skill.agent}`] : [])),
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
              ? 'Turn it on in the agent module’s settings to choose modules.'
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
