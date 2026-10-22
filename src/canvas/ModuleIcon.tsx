import {
  Bell,
  Blocks,
  BookOpen,
  Bot,
  Box,
  Bug,
  Calendar,
  ChartColumn,
  Cloud,
  Code,
  Cpu,
  Database,
  Factory,
  File,
  FileCode,
  FilePen,
  FileText,
  FlaskConical,
  Folder,
  FolderTree,
  GitBranch,
  GitCompare,
  GitPullRequest,
  Globe,
  GraduationCap,
  History,
  Image,
  Inbox,
  Kanban,
  Layers,
  LayoutDashboard,
  Lightbulb,
  Link,
  ListChecks,
  ListTodo,
  Lock,
  Mail,
  Map as MapIcon,
  MessageCircle,
  MessageSquareCode,
  Network,
  NotebookPen,
  Package,
  PenTool,
  Presentation,
  Puzzle,
  Quote,
  Rocket,
  Route,
  Search,
  Server,
  Settings,
  Shield,
  SquareTerminal,
  Star,
  Table,
  Tag,
  Timer,
  Users,
  Video,
  Workflow,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { moduleIconParts, type LUCIDE_MODULE_ICONS, type ModuleIcon as IconKey } from 'kehikot-module-protocol'
import { useSyncExternalStore } from 'react'

import { initialOf, moduleIconFor } from '../host/moduleIcon.ts'
import { BRAND_MARKS } from './brandMarks.ts'
import { KehikkoMark } from './Mark.tsx'

/**
 * The id the host's own things go by where modules are listed — its door, its skills, its data
 * (`HOST_ID` in `server/kehikot.ts`, `OWN_SKILLS_MODULE`). Never a module's: module ids are
 * `kehikot.<name>`. Drawn with Kehikot's own mark.
 */
export const KEHIKOT_ITSELF = 'kehikko'

/**
 * The one way a module's icon is drawn, wherever the module is listed: the modules menu, What's
 * new, the Updates menu, Settings, the Skills and Tools windows, a container's header, the layout
 * picker, Storage.
 *
 * The icon is a KEY (protocol 2.14.0, `MODULE_ICONS`), never a path or URL: `lucide:<name>` is
 * drawn from the Lucide components below, `brand:<slug>` from `BRAND_MARKS`, both in
 * `currentColor`. Which key a module has is `moduleIconFor` (its manifest's, then the official
 * list's). A module with none — or one this host cannot draw — gets the neutral frame with its
 * initial, never Kehikot's own marks: Kehikot itself is drawn with `KehikkoMark`.
 */

/** Every Lucide name the protocol lets a module count on, to its component. A test holds the two to each other. */
export const LUCIDE_DRAWN: Record<(typeof LUCIDE_MODULE_ICONS)[number], LucideIcon> = {
  bell: Bell,
  blocks: Blocks,
  'book-open': BookOpen,
  bot: Bot,
  box: Box,
  bug: Bug,
  calendar: Calendar,
  'chart-column': ChartColumn,
  cloud: Cloud,
  code: Code,
  cpu: Cpu,
  database: Database,
  factory: Factory,
  file: File,
  'file-code': FileCode,
  'file-pen': FilePen,
  'file-text': FileText,
  'flask-conical': FlaskConical,
  folder: Folder,
  'folder-tree': FolderTree,
  'git-branch': GitBranch,
  'git-compare': GitCompare,
  'git-pull-request': GitPullRequest,
  globe: Globe,
  'graduation-cap': GraduationCap,
  history: History,
  image: Image,
  inbox: Inbox,
  kanban: Kanban,
  layers: Layers,
  'layout-dashboard': LayoutDashboard,
  lightbulb: Lightbulb,
  link: Link,
  'list-checks': ListChecks,
  'list-todo': ListTodo,
  lock: Lock,
  mail: Mail,
  map: MapIcon,
  'message-circle': MessageCircle,
  'message-square-code': MessageSquareCode,
  network: Network,
  'notebook-pen': NotebookPen,
  package: Package,
  'pen-tool': PenTool,
  presentation: Presentation,
  puzzle: Puzzle,
  quote: Quote,
  rocket: Rocket,
  route: Route,
  search: Search,
  server: Server,
  settings: Settings,
  shield: Shield,
  'square-terminal': SquareTerminal,
  star: Star,
  table: Table,
  tag: Tag,
  timer: Timer,
  users: Users,
  video: Video,
  workflow: Workflow,
  wrench: Wrench,
  zap: Zap,
}

/* What the page knows of each module's icon, by id: the server's resolved `icon` on each presence
   (`setRegisteredIcons`, from the registry), and the official list's (`setListedIcons`, when the
   modules menu has read it). Kept beside the component so every listing reads the same answer
   without each being handed the registry. */
let registered = new Map<string, string | null>()
let listed = new Map<string, string | null>()
let version = 0
const listeners = new Set<() => void>()

function changed(): void {
  version += 1
  for (const listener of listeners) listener()
}

function same(a: Map<string, string | null>, b: Map<string, string | null>): boolean {
  if (a.size !== b.size) return false
  for (const [id, icon] of a) if (b.get(id) !== icon) return false
  return true
}

/** The registry's answer: each presence's `icon`, already resolved by the server. */
export function setRegisteredIcons(entries: Iterable<{ id: string; icon?: string | null }>): void {
  const next = new Map<string, string | null>()
  for (const one of entries) next.set(one.id, one.icon ?? null)
  if (same(next, registered)) return
  registered = next
  changed()
}

/** The official list's icon for each entry, for a module that is not registered here. */
export function setListedIcons(entries: Iterable<{ id: string; icon?: string | null }>): void {
  const next = new Map(listed)
  for (const one of entries) next.set(one.id, one.icon ?? null)
  if (same(next, listed)) return
  listed = next
  changed()
}

/** The icon this page draws for a module id: its own (as the registry says it), then the list's. */
export function iconOfModule(id: string): IconKey | null {
  return moduleIconFor(registered.get(id), listed.get(id))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** `iconOfModule`, re-read when either list changes. */
export function useModuleIconKey(id: string | undefined): IconKey | null {
  useSyncExternalStore(subscribe, () => version, () => version)
  return id === undefined ? null : iconOfModule(id)
}

/**
 * One module's icon.
 *
 * - `id`: whose; the icon is looked up by it. `icon` instead (or as well) draws that key, for a row
 *   that already holds one — an official entry not installed here. A declared key beats it.
 * - `name`: the module's name. It is the icon's accessible label when the icon stands `alone` (an
 *   icon-only width, a button with no words), and its tooltip then. Beside the written name the
 *   icon is decorative and hidden from assistive technology, so the name is not read twice.
 * - Kehikot itself (`id` is `KEHIKOT_ITSELF`) is drawn with its own mark, the bar's.
 */
export function ModuleIcon({
  id,
  icon,
  name,
  alone = false,
  className = 'size-3.5',
}: {
  id?: string
  icon?: string | null
  name: string
  alone?: boolean
  className?: string
}) {
  const fromStore = useModuleIconKey(id)
  const key = moduleIconFor(fromStore, icon)
  const label = alone ? { role: 'img' as const, 'aria-label': name } : { 'aria-hidden': true as const }
  const classes = `shrink-0 ${className}`
  if (id === KEHIKOT_ITSELF) {
    return (
      <span className="inline-flex shrink-0" data-module-icon="kehikot" title={alone ? name : undefined} {...label}>
        <KehikkoMark working={false} className={className} />
      </span>
    )
  }
  if (key) {
    const { set, name: which } = moduleIconParts(key)
    if (set === 'lucide') {
      const Drawn = LUCIDE_DRAWN[which as keyof typeof LUCIDE_DRAWN]
      if (Drawn) {
        return (
          <Drawn className={classes} data-module-icon={key} {...label}>
            {alone ? <title>{name}</title> : null}
          </Drawn>
        )
      }
    } else {
      const mark = BRAND_MARKS[which as keyof typeof BRAND_MARKS]
      if (mark) {
        return (
          <svg viewBox="0 0 24 24" fill="currentColor" className={classes} data-module-icon={key} {...label}>
            {alone ? <title>{name}</title> : null}
            <path d={mark.path} />
          </svg>
        )
      }
    }
  }
  return (
    <svg viewBox="0 0 24 24" className={classes} data-module-icon="fallback" {...label}>
      {alone ? <title>{name}</title> : null}
      <rect x="3" y="3" width="18" height="18" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <text
        x="12"
        y="12.5"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="12"
        fontWeight="700"
        fill="currentColor"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        {initialOf(name)}
      </text>
    </svg>
  )
}
