import {
  AppWindow,
  BookOpen,
  Bot,
  Check,
  CircleStop,
  Code,
  Columns2,
  Compass,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  File,
  FileDown,
  FileText,
  Folder,
  GitCommitHorizontal,
  History,
  Image,
  LayoutList,
  Link,
  List,
  ListTree,
  LoaderCircle,
  Maximize,
  MessageSquare,
  MessageSquareText,
  Monitor,
  MonitorPlay,
  PanelLeft,
  Pencil,
  Play,
  Plug,
  Presentation,
  Printer,
  RefreshCw,
  Rows3,
  Save,
  ScrollText,
  Search,
  Settings,
  Square,
  Terminal,
  Trash2,
  TriangleAlert,
  Unplug,
  Upload,
  WrapText,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from 'react'

import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import {
  HEADER_MENUS,
  type HeaderItem,
  type HeaderMenu,
  type PressValue,
} from 'kehikot-module-protocol'
import { focusAfter, menusOf, nested, staysOpen, type Closing, type ModuleMenu, type Pressed, type Pressing } from '@/host/header.ts'
import type { AgentAwareness } from '@/host/registry.ts'
import { DISARM_AFTER_MS } from './Clearing.tsx'
import { FeedbackDialog, FeedbackRows, useFeedback } from './Feedback.tsx'

/**
 * A container's menus: the module's own View, Go and Run, and the host's Frame.
 *
 * ## What a module declares, the host draws
 *
 * A module says which view switches, toggles, jumps and runs it has
 * (`kehikot.header`, protocol 1.1.0) and stops drawing a toolbar of its own.
 * What it declared is drawn here, in the container's header, as shadcn
 * dropdown menus: a `switch` is a radio group, a `toggle` a checkbox item, a
 * `go` a list of places, a `run` an item that says how it is going. The KIND
 * decides the menu — the rule is `menusOf` in `host/header.ts` and the table
 * is the protocol's — so every container reads the same: View, Go, Run, Frame.
 *
 * A module that declares nothing draws nothing here, and its header is the
 * header it had. An empty menu is not drawn.
 *
 * ## The module owns every bit of state
 *
 * Nothing in this file remembers which option a switch is on or whether a run
 * is busy. A press is sent (`onPress`), the module answers and declares its
 * header again, and the new list arrives as `items`. The rows are keyed by
 * the module's ids, so a re-declaration moves a tick or starts a spinner in
 * the menu that is open rather than drawing it again.
 *
 * What IS held here is the host's: which confirmed run has had its first
 * press, which presses are still out, and the sentence a refused press came
 * back with.
 *
 * ## Open, or closed, after a choice
 *
 * A toggle and a switch leave the menu open: they are settings, somebody may
 * set two, and the tick moves in front of them. A jump and a run close it, as
 * an ordinary shadcn item does — they act on the page the menu is standing
 * over. A run that needs confirming stays open for its second press.
 *
 * ## The keyboard, after a menu closes
 *
 * A press that was sent hands the keyboard to the module's page
 * (`onKeyboard`); Escape, and a press that was not taken, leave focus on the
 * trigger. `focusAfter` in `host/header.ts` is the rule and has the argument.
 * Focus that comes back to a trigger this way does not raise its tooltip —
 * the label would stand over the top of the module's page, which is what the
 * person closed the menu to look at. Tabbing to a trigger still does.
 *
 * ## Space
 *
 * The header is one row of thirty-two pixels and does not grow one. A
 * container is often 380 pixels wide, so the triggers are words at a small
 * size and nothing else; under 300 pixels they are icons, each twenty-four
 * pixels like every other control in the row; under 220 the three become one
 * "⋯" whose menu has View, Go and Run as labelled sections. Folded, a
 * container is a header and nothing else, and the module's menus are not
 * drawn at all — a switch for a page nobody can see is a press with no
 * visible effect. `modeFor` is the rule.
 *
 * Every label is one line, cut with an ellipsis and whole in its `title`.
 * The longest thing a module can say here is the reason a run is disabled,
 * which is a sentence: it is drawn under the row, small, and wraps inside the
 * menu — never in the header.
 *
 * ## A module's words are text, and its icon is a name
 *
 * Labels, groups, results and reasons are a stranger's strings. They are
 * rendered as text nodes and nothing else: never as markup, never as a link,
 * and no URL is opened from one. `icon` is looked up in `HEADER_ICONS`, a
 * fixed table in this file, and a name that is not in it draws no icon.
 */

/* ------------------------------------------------------------------ *
 * How wide
 * ------------------------------------------------------------------ */

/** How the module's menus are drawn at a width: as words, as icons, or as one "⋯". */
export type MenuMode = 'words' | 'icons' | 'merged'

/** Under this many pixels of header, a trigger is an icon. The width the header's own gaps close at. */
export const ICONS_BELOW = 300
/** Under this many, View, Go and Run are one menu. */
export const MERGE_BELOW = 220

/** The mode for a header this wide. `null` is "not measured yet", which is drawn as the widest. */
export function modeFor(width: number | null): MenuMode {
  if (width === null) return 'words'
  if (width < MERGE_BELOW) return 'merged'
  return width < ICONS_BELOW ? 'icons' : 'words'
}

/**
 * The mode for the header this is drawn in, kept as the container is resized.
 *
 * Measured rather than asked of a container query, which is how the header's
 * gaps are closed, because the two narrow modes are not the same elements
 * restyled: three menus become one. An observer is installed only for a
 * header that has module menus, which is a few containers, and it sets state
 * only when the mode changes — a drag across a hundred pixels is one render.
 */
function useMode(anchor: RefObject<HTMLElement | null>, active: boolean): MenuMode {
  const [mode, setMode] = useState<MenuMode>('words')
  useLayoutEffect(() => {
    if (!active) return
    const header = anchor.current?.closest<HTMLElement>('.container-grip')
    if (!header) return
    const measure = () => setMode(modeFor(header.offsetWidth || null))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watching = new ResizeObserver(measure)
    watching.observe(header)
    return () => watching.disconnect()
  }, [anchor, active])
  return mode
}

/* ------------------------------------------------------------------ *
 * Icons
 * ------------------------------------------------------------------ */

/**
 * The icon names a module's item can use, and what each draws.
 *
 * A fixed table, and the only way a module's `icon` reaches the screen: the
 * name is a key looked up here and never a path, a URL, a class or markup. A
 * `Map`, because the key is a stranger's string and a `Map` has no prototype
 * for `constructor` to find. The names are lucide's own (kebab-case), so a
 * module author can look one up; a name that is not here draws no icon, and
 * says nothing — a newer host may know it.
 */
export const HEADER_ICONS: ReadonlyMap<string, LucideIcon> = new Map<string, LucideIcon>([
  ['book-open', BookOpen],
  ['bot', Bot],
  ['check', Check],
  ['circle-stop', CircleStop],
  ['code', Code],
  ['columns-2', Columns2],
  ['compass', Compass],
  ['copy', Copy],
  ['download', Download],
  ['external-link', ExternalLink],
  ['eye', Eye],
  ['file', File],
  ['file-down', FileDown],
  ['file-text', FileText],
  ['folder', Folder],
  ['git-commit-horizontal', GitCommitHorizontal],
  ['history', History],
  ['image', Image],
  ['layout-list', LayoutList],
  ['link', Link],
  ['list', List],
  ['list-tree', ListTree],
  ['maximize', Maximize],
  ['monitor', Monitor],
  ['monitor-play', MonitorPlay],
  ['panel-left', PanelLeft],
  ['pencil', Pencil],
  ['play', Play],
  ['presentation', Presentation],
  ['printer', Printer],
  ['refresh-cw', RefreshCw],
  ['rows-3', Rows3],
  ['save', Save],
  ['scroll-text', ScrollText],
  ['search', Search],
  ['settings', Settings],
  ['square', Square],
  ['terminal', Terminal],
  ['trash-2', Trash2],
  ['upload', Upload],
  ['wrap-text', WrapText],
  ['zap', Zap],
])

function ItemIcon({ name }: { name: string | undefined }) {
  const Drawn = name === undefined ? undefined : HEADER_ICONS.get(name)
  return Drawn ? <Drawn className="text-muted-foreground size-3.5" data-icon={name} /> : null
}

const TRIGGER_ICONS: Record<HeaderMenu, LucideIcon> = { view: Eye, go: Compass, run: Play }

/* ------------------------------------------------------------------ *
 * The module's menus
 * ------------------------------------------------------------------ */

/** How long the sentence a press came back with stays on its trigger. Long enough to read one. */
export const SAID_FOR_MS = 6000

/** Something to say on a trigger for a moment: a refusal's reason, or that an agent pressed. */
interface Said {
  /** Which item it is about, so the row can say it too while its menu is open. */
  item: string
  menu: HeaderMenu
  text: string
  tone: 'refused' | 'noted'
}

/** What an agent's press came to, handed down so the container says it happened. See `App.tsx`. */
export interface PressNote {
  /** Counts up, so the same sentence twice is said twice. */
  n: number
  item: string
  text: string
}

/** What every row needs from the menus it is in. */
interface Pressable {
  armed: string | null
  pending: readonly string[]
  said: Said | null
  arm(item: HeaderItem): void
  press(item: HeaderItem, value?: PressValue): void
  /** How the menu that is open came to close, for `focusAfter`. Written by a press and by `useOpen`. */
  closing: MutableRefObject<Closing>
  /** Hand the keyboard to the module's page. */
  keyboard(): void
}

export function HeaderMenus({
  items,
  name,
  onPress,
  onKeyboard,
  note = null,
  mode: asked,
}: {
  /** What the module last declared. Empty draws nothing at all. */
  items: readonly HeaderItem[]
  /** The module's name, for the sentences somebody reads. */
  name: string
  /**
   * One item chosen. Answers what became of it: taken, or not and why. The
   * caller judges the press against the header as it stands and sends it —
   * `pressing` in `host/header.ts`.
   */
  onPress(press: Pressing): Promise<Pressed>
  /** Hand the keyboard to the module's page, after a press that closed its menu. Left out, focus stays put. */
  onKeyboard?(): void
  /** An agent pressed something here: said on the trigger for a moment. */
  note?: PressNote | null
  /** The mode, when the caller knows it. Left out, the header is measured. */
  mode?: MenuMode
}) {
  const anchor = useRef<HTMLSpanElement>(null)
  const menus = useMemo(() => menusOf(items), [items])
  const measured = useMode(anchor, menus.length > 0 && asked === undefined)
  const mode = asked ?? measured

  /*
   * The one confirmed run that has had its first press, and what it looked
   * like when it was armed.
   *
   * `Clearing.tsx` has the argument, and this is the same arm: the first
   * press changes what the row says and sends nothing, the second sends, and
   * it comes down on a timer, when the menu closes, and when the item is
   * declared differently — a Commit that went from "3 files" to "4 files"
   * between the two presses is not the commit somebody aimed at. One at a
   * time: two armed rows in one menu is a way to press the wrong one.
   */
  const [armed, setArmed] = useState<{ id: string; as: string } | null>(null)
  const standing = armed ? items.find((item) => item.id === armed.id) : undefined
  const armedStill = armed !== null && standing !== undefined && JSON.stringify(standing) === armed.as
  useEffect(() => {
    if (armed === null) return
    if (!armedStill) {
      setArmed(null)
      return
    }
    const timer = window.setTimeout(() => setArmed(null), DISARM_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [armed, armedStill])

  /* Presses that are out and not yet answered, so a second one is not sent on top. */
  const [pending, setPending] = useState<readonly string[]>([])
  const [said, setSaid] = useState<Said | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!said) return
    const timer = window.setTimeout(() => setSaid(null), SAID_FOR_MS)
    return () => window.clearTimeout(timer)
  }, [said])

  /* An agent's press, said where a person's refusal is said. */
  const noted = note?.n
  useEffect(() => {
    if (!note) return
    const item = items.find((one) => one.id === note.item)
    setSaid({ item: note.item, menu: item ? HEADER_MENUS[item.kind] : 'run', text: note.text, tone: 'noted' })
    /* Only when a new note arrives: `items` changes on every declaration. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noted])

  /* How the open menu closes, and which press said so: an answer to an older press must not speak for a newer one. */
  const closing = useRef<Closing>('dismissed')
  const sent = useRef(0)

  if (!menus.length) return null

  const rows: Pressable = {
    closing,
    keyboard: () => onKeyboard?.(),
    armed: armedStill ? armed.id : null,
    pending,
    said,
    arm: (item) => setArmed({ id: item.id, as: JSON.stringify(item) }),
    press: (item, value) => {
      setArmed(null)
      if (pending.includes(item.id)) return
      setPending((was) => [...was, item.id])
      setSaid((was) => (was?.item === item.id ? null : was))
      /* A jump and a run close the menu, and where focus goes then depends on
         what becomes of this press — see `focusAfter`. */
      const nth = ++sent.current
      if (!staysOpen(item.kind)) closing.current = 'pressed'
      void onPress({ item: item.id, ...(value === undefined ? {} : { value }) })
        .catch((): Pressed => ({ ok: false, why: `${name} could not be pressed.` }))
        .then((came) => {
          if (!came.ok && sent.current === nth && closing.current === 'pressed') closing.current = 'refused'
          if (!mounted.current) return
          setPending((was) => was.filter((id) => id !== item.id))
          if (!came.ok) setSaid({ item: item.id, menu: HEADER_MENUS[item.kind], text: came.why, tone: 'refused' })
        })
    },
  }
  const disarm = () => setArmed(null)

  return (
    /* One box for the three, with no gap of its own between them: the words
       carry their own padding, and the header's eight-pixel gap three times
       over is twenty-four pixels the module's name would rather have. */
    <span ref={anchor} className="flex shrink-0 items-center" data-header-menus={mode}>
      {mode === 'merged' ? (
        <Menu which="more" menus={menus} mode={mode} name={name} rows={rows} onClosed={disarm} word={said} />
      ) : (
        menus.map((menu) => (
          <Menu
            key={menu.menu}
            which={menu.menu}
            menus={[menu]}
            mode={mode}
            name={name}
            rows={rows}
            onClosed={disarm}
            word={said?.menu === menu.menu ? said : null}
          />
        ))
      )}
      {/* The same sentence for somebody who is not looking at the trigger. No box: it takes no room in the row. */}
      <span role="status" aria-live="polite" className="sr-only" data-testid="header-said">
        {said?.text ?? ''}
      </span>
    </span>
  )
}

/** One trigger and its menu: View, Go or Run, or all three as sections of "⋯". */
function Menu({
  which,
  menus,
  mode,
  name,
  rows,
  onClosed,
  word,
}: {
  which: HeaderMenu | 'more'
  menus: readonly ModuleMenu[]
  mode: MenuMode
  name: string
  rows: Pressable
  onClosed(): void
  word: Said | null
}) {
  const [open, setOpen] = useOpen(onClosed, rows.closing)
  const quiet = useRef(false)
  const busy = menus.some((menu) => menu.busy)
  const failed = !busy && menus.some((menu) => menu.failed)
  const title = which === 'more' ? 'Menus' : menus[0]!.title
  const Glyph = which === 'more' ? Ellipsis : TRIGGER_ICONS[which]
  const state = busy ? ' — running' : failed ? ' — the last run failed' : ''
  const hint =
    which === 'more'
      ? `${name}'s menus: ${menus.map((menu) => menu.title.toLowerCase()).join(', ')}${state}`
      : which === 'view'
        ? `view: what ${name} shows`
        : which === 'go'
          ? `go: jump to a place in ${name}`
          : `run: what ${name} can do${state}`

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Word hint={hint} word={open ? null : word} quiet={quiet}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            aria-label={`${which === 'more' ? 'menus' : title.toLowerCase()} of ${name}${state}`}
            data-menu={which}
            data-run={busy ? 'busy' : failed ? 'failed' : undefined}
            /* `pointer-events-auto` because the container is not, and the press
               is stopped before the grid reads it as the start of a drag — both
               as every control in this header does; see `Container.tsx`. */
            className={
              mode === 'words'
                ? `${failed ? 'text-destructive hover:text-destructive' : busy ? 'text-foreground' : 'text-muted-foreground hover:text-foreground data-[state=open]:text-foreground'} data-[state=open]:bg-accent pointer-events-auto relative h-6 shrink-0 cursor-default px-1.5 text-xs font-normal`
                : 'text-foreground data-[state=open]:bg-accent pointer-events-auto size-6 shrink-0 cursor-default p-0'
            }
            onMouseDown={(event) => event.stopPropagation()}
          >
            {mode === 'words' ? (
              <>
                {title}
                {/* A dot in the corner, not a glyph after the word: a run
                    going busy must not widen the trigger and push letters off
                    the module's name for as long as a compile takes. */}
                {busy || failed ? (
                  <span
                    className={`ring-card absolute top-0.5 right-0 size-1.5 rounded-full ring-1 ${failed ? 'bg-destructive' : 'bg-foreground animate-pulse'}`}
                    aria-hidden
                  />
                ) : null}
              </>
            ) : busy ? (
              <LoaderCircle className="size-3 animate-spin" aria-hidden />
            ) : failed ? (
              <TriangleAlert className="text-destructive size-3" aria-hidden />
            ) : (
              <Glyph className="size-3" aria-hidden />
            )}
          </Button>
        </DropdownMenuTrigger>
      </Word>

      <DropdownMenuContent
        align="end"
        className="max-w-64 min-w-44"
        data-menu-content={which}
        onCloseAutoFocus={(event) => {
          const to = focusAfter(rows.closing.current)
          rows.closing.current = 'dismissed'
          if (to === 'trigger') return returning(quiet)
          /* Not Radix's return to the trigger: the module has the keyboard, or is given it. */
          event.preventDefault()
          if (to === 'module') rows.keyboard()
        }}
      >
        {menus.map((menu, index) => (
          <DropdownMenuGroup key={menu.menu} data-section={menu.menu}>
            {which === 'more' ? (
              <>
                {index > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel className="text-foreground py-1 text-[11px] font-semibold">{menu.title}</DropdownMenuLabel>
              </>
            ) : null}
            {menu.groups.map((group, at) => (
              <DropdownMenuGroup key={group.name ?? ''} data-group={group.name ?? undefined}>
                {at > 0 ? <DropdownMenuSeparator /> : null}
                {group.name ? (
                  <DropdownMenuLabel className="truncate py-1 text-[11px] font-normal" title={group.name}>
                    {group.name}
                  </DropdownMenuLabel>
                ) : null}
                {group.items.map((item, nth) => {
                  const alone = which !== 'more' && menu.count === 1
                  const before = group.items[nth - 1]
                  return (
                    <div key={item.id} className="contents">
                      {/* A list of options drawn in the menu is fenced off from
                          its neighbours: a toggle straight after Source / PDF
                          reads as a third thing the pane could be. */}
                      {before && (listed(before, alone) || listed(item, alone)) ? <DropdownMenuSeparator /> : null}
                      <Row item={item} alone={alone} rows={rows} slot={slotted(menu)} />
                    </div>
                  )
                })}
              </DropdownMenuGroup>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Whether the runs of a menu keep a column for an icon: when any of them has
 * one to draw, or is saying it is busy or failed there. A run without one
 * then starts its words where the others do; a menu where none has one keeps
 * no column at all.
 */
function slotted(menu: ModuleMenu): boolean {
  return menu.groups.some((group) =>
    group.items.some(
      (item) => item.kind === 'run' && (item.state !== 'idle' || (item.icon !== undefined && HEADER_ICONS.has(item.icon))),
    ),
  )
}

/** Whether an item is drawn as its label and a list of options under it, in the menu itself. */
function listed(item: HeaderItem, alone: boolean): boolean {
  return (item.kind === 'switch' || item.kind === 'go') && !nested(item, alone)
}

/**
 * Whether a menu is open, closed by the two things Radix cannot see.
 *
 * Radix closes a menu on a press outside it and on Escape. A press INSIDE A
 * MODULE'S PAGE is neither, as far as this document can tell: the page is
 * another origin's iframe, and a pointer that goes down in one raises no
 * event here at all — the fact `Hint.tsx` and `Frames.tsx` each had to work
 * around. What this document does get is `blur` on its window, when focus
 * leaves for the frame. So that closes the menu: somebody who clicked into
 * the module is done with the menu over it.
 *
 * A drag needs nothing here. It starts with a press on the header, which is
 * outside the menu, and Radix has closed it before the grid moves anything.
 */
function useOpen(onClosed: () => void, closing: MutableRefObject<Closing>): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false)
  const closed = useRef(onClosed)
  closed.current = onClosed
  const set = (next: boolean) => {
    /* A menu that opens has not been closed by anything yet. */
    if (next) closing.current = 'dismissed'
    setOpen(next)
    if (!next) closed.current()
  }
  useEffect(() => {
    if (!open) return
    const away = () => {
      /* Focus is in a module's page now, and is not pulled back out of it. */
      closing.current = 'away'
      setOpen(false)
      closed.current()
    }
    window.addEventListener('blur', away)
    return () => window.removeEventListener('blur', away)
  }, [open])
  return [open, set]
}

/**
 * A trigger's tooltip, which is also where a press that was not taken says why.
 *
 * `Hint` with one more thing it can do: stand open for a few seconds holding
 * a sentence nobody hovered for. That is the header's transient word — the
 * floating label every control here already has — rather than a row under
 * the header or a toast over the canvas. `disableHoverableContent` for the
 * reason `Hint.tsx` gives.
 *
 * `quiet` is the one focus it does not open for: the menu handing focus back
 * to its trigger as it closes. Radix's tooltip opens on focus, which is right
 * for somebody tabbing along the header and wrong here — nobody asked what
 * the trigger is, they have just used it, and the label stands over the top
 * of the module's page until something else takes focus. Marking the focus
 * event as handled is how a Radix handler is told to stand down.
 */
function Word({
  hint,
  word,
  quiet,
  children,
}: {
  hint: string
  word: Said | null
  quiet: MutableRefObject<boolean>
  children: ReactNode
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <Tooltip disableHoverableContent open={word !== null || hovered} onOpenChange={setHovered}>
      <TooltipTrigger
        asChild
        onFocus={(event) => {
          if (quiet.current) event.preventDefault()
        }}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-64" data-word={word?.tone}>
        {word ? word.text : hint}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Mark the focus a closing menu is about to return to its trigger, so `Word`
 * does not open for it. The return is made in the same task, right after the
 * handler this is called from, so the mark is taken down in the next one.
 */
function returning(quiet: MutableRefObject<boolean>): void {
  quiet.current = true
  window.setTimeout(() => {
    quiet.current = false
  }, 0)
}

/** The sentence a refused press came back with, under the row it was about. */
function Why({ item, rows }: { item: HeaderItem; rows: Pressable }) {
  const said = rows.said
  if (!said || said.item !== item.id || said.tone !== 'refused') return null
  return (
    <span className="text-destructive text-[10px] leading-tight font-normal whitespace-normal" data-why={item.id}>
      {said.text}
    </span>
  )
}

/** A label on one line, cut with an ellipsis, whole in its title. */
function Cut({ children, className = '' }: { children: string; className?: string }) {
  return (
    <span className={`min-w-0 truncate ${className}`} title={children}>
      {children}
    </span>
  )
}

const ROW = 'cursor-default text-xs'

/** One declared item, drawn as its kind. */
function Row({ item, alone, rows, slot }: { item: HeaderItem; alone: boolean; rows: Pressable; slot: boolean }) {
  const waiting = rows.pending.includes(item.id)

  if (item.kind === 'toggle') {
    return (
      <DropdownMenuCheckboxItem
        className={ROW}
        checked={item.checked}
        disabled={waiting}
        data-item={item.id}
        /* The state WANTED, not "flip": a press delivered twice changes nothing. */
        onCheckedChange={(checked) => rows.press(item, checked === true)}
        onSelect={(event) => event.preventDefault()}
      >
        {/* No icon on a toggle: its tick stands where one would be, and a row
            with both starts its words further right than the row above it. */}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <Cut className="flex-1">{item.label}</Cut>
            {item.shortcut ? <DropdownMenuShortcut className="text-[10px]">{item.shortcut}</DropdownMenuShortcut> : null}
          </span>
          <Why item={item} rows={rows} />
        </span>
      </DropdownMenuCheckboxItem>
    )
  }

  if (item.kind === 'run') {
    const armed = rows.armed === item.id
    const busy = item.state === 'busy'
    return (
      <DropdownMenuItem
        /* A reason is read by hovering the row it is on, so a disabled row
           keeps the pointer; Radix still does not select it. */
        className={`${ROW} data-[disabled]:pointer-events-auto`}
        variant={armed ? 'destructive' : 'default'}
        disabled={item.disabled !== null || busy || waiting}
        title={item.disabled ?? undefined}
        data-item={item.id}
        data-armed={armed ? 'true' : undefined}
        data-state-run={item.state}
        onSelect={(event) => {
          if (item.confirm && !armed) {
            /* Kept open: the second press answers what the row just became. */
            event.preventDefault()
            rows.arm(item)
            return
          }
          rows.press(item)
        }}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            {busy ? (
              <LoaderCircle className="size-3.5 animate-spin" aria-label="running" />
            ) : item.state === 'failed' ? (
              <TriangleAlert className="text-destructive size-3.5" aria-label="failed" />
            ) : item.icon !== undefined && HEADER_ICONS.has(item.icon) ? (
              <ItemIcon name={item.icon} />
            ) : slot ? (
              <span className="size-3.5 shrink-0" aria-hidden />
            ) : null}
            <Cut className="flex-1">{item.label}</Cut>
            {item.result ? (
              <span
                className={`max-w-28 shrink-0 truncate text-[10px] ${item.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
                title={item.result}
                data-result
              >
                {item.result}
              </span>
            ) : null}
            {item.shortcut ? <DropdownMenuShortcut className="text-[10px]">{item.shortcut}</DropdownMenuShortcut> : null}
          </span>
          {armed ? (
            <span className="text-[10px] leading-tight font-medium whitespace-normal">Press again to confirm.</span>
          ) : item.disabled ? (
            <span className="text-[10px] leading-tight whitespace-normal" data-reason>
              {item.disabled}
            </span>
          ) : null}
          <Why item={item} rows={rows} />
        </span>
      </DropdownMenuItem>
    )
  }

  /* A switch and a go item are both a list of options under the item's own
     label; a switch has one of them on, and a go item holds nothing. */
  const options =
    item.kind === 'switch' ? (
      /* The press is each row's own, not the group's "value changed": the
         option a switch is ALREADY on is pressed like any other — "show the
         PDF" again is how somebody asks to be taken back to it — and whether
         that changes anything is the module's to say. */
      <DropdownMenuRadioGroup value={item.value}>
        {item.options.map((option) => (
          <DropdownMenuRadioItem
            key={option.id}
            value={option.id}
            className={ROW}
            disabled={waiting}
            data-item={item.id}
            data-option={option.id}
            onSelect={(event) => {
              if (staysOpen(item.kind)) event.preventDefault()
              rows.press(item, option.id)
            }}
          >
            <Cut className="flex-1">{option.label}</Cut>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    ) : (
      item.options.map((option) => (
        <DropdownMenuItem
          key={option.id}
          className={ROW}
          disabled={waiting}
          data-item={item.id}
          data-option={option.id}
          onSelect={() => rows.press(item, option.id)}
        >
          <Cut className="flex-1">{option.label}</Cut>
        </DropdownMenuItem>
      ))
    )

  if (nested(item, alone)) {
    const on = item.kind === 'switch' ? item.options.find((option) => option.id === item.value)?.label : undefined
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className={ROW} data-item={item.id} data-nested="true">
          <ItemIcon name={item.icon} />
          <Cut className="flex-1">{item.label}</Cut>
          {on ? <span className="text-muted-foreground max-w-24 shrink-0 truncate text-[10px]">{on}</span> : null}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-w-64 min-w-40">{options}</DropdownMenuSubContent>
      </DropdownMenuSub>
    )
  }

  return (
    <>
      <DropdownMenuLabel className="flex min-w-0 flex-col py-1 text-[11px] font-normal" data-item-label={item.id}>
        <span className="flex min-w-0 items-center gap-1.5">
          <ItemIcon name={item.icon} />
          <Cut>{item.label}</Cut>
        </span>
        <Why item={item} rows={rows} />
      </DropdownMenuLabel>
      {options}
    </>
  )
}

/* ------------------------------------------------------------------ *
 * The host's own menu
 * ------------------------------------------------------------------ */

/**
 * Frame: what the host offers about a module as a program.
 *
 * Three controls used to stand in the header one by one — the tools plug,
 * feedback, prompts — and each was a twenty-four pixel icon on every
 * container, whatever was in it. They are one trigger now and the row has
 * forty-eight pixels and two gaps back, which is what pays for a module's
 * own menus at the width people keep their containers.
 *
 * ## What had to stay visible, and does
 *
 * Two of the three said something at a glance, without being pressed.
 *
 * The plug was LOUD when a module offered tools and no agent had been told —
 * the one state in which somebody should do something. That is kept on the
 * trigger: it goes from muted to foreground and carries a dot, and its
 * tooltip is the sentence the plug had. A connected plug was quiet, and is
 * now a row saying "connected".
 *
 * The prompts icon was foreground for a module that uses a prompt. That is
 * kept as a word on its row. It is not on the trigger: it is a fact about
 * the module that never changes, not a thing to act on.
 *
 * Feedback said nothing until it was opened, and its list opens beside this
 * menu as it opened under its own button.
 *
 * Checkbox, dot and name stay direct on the left, and fold and remove on the
 * right: those are pressed without thinking, and a menu in front of them
 * would be a second press on the commonest things a person does here.
 *
 * Drawn on every container, folded too, as the three were.
 */
export function FrameMenu({
  module,
  name,
  agent,
  onTools,
  prompted,
  onPrompts,
  kehikko,
  epic,
}: {
  module: string
  name: string
  /** What the sweep read of the agent's configuration for this module. `none` or absent: no door, no row. */
  agent: AgentAwareness | undefined
  onTools(): void
  /** Whether this module has said it uses a prompt. */
  prompted: boolean
  onPrompts(): void
  /** The open kehikko's name and epic, written under feedback filed from here. */
  kehikko: string | null
  epic: string | null
}) {
  const feedback = useFeedback(module)
  const closing = useRef<Closing>('dismissed')
  const quiet = useRef(false)
  const [open, setOpen] = useOpen(() => {}, closing)
  const tools = toolsSaying(agent, name)

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <Word
          hint={tools?.loud ? tools.hint : `frame: ${name}'s tools, feedback and prompts`}
          word={null}
          quiet={quiet}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={tools?.loud ? `frame menu of ${name} — ${tools.state}` : `frame menu of ${name}`}
              data-menu="frame"
              data-tools={tools?.loud ? 'loud' : undefined}
              className={
                tools?.loud
                  ? 'text-foreground data-[state=open]:bg-accent pointer-events-auto relative size-6 shrink-0 cursor-default'
                  : 'text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground pointer-events-auto relative size-6 shrink-0 cursor-default'
              }
              onMouseDown={(event) => event.stopPropagation()}
            >
              <AppWindow className="size-3" aria-hidden />
              {tools?.loud ? (
                <span className="bg-foreground ring-card absolute top-0.5 right-0.5 size-1.5 rounded-full ring-1" aria-hidden />
              ) : null}
            </Button>
          </DropdownMenuTrigger>
        </Word>

        <DropdownMenuContent
          align="end"
          className="max-w-64 min-w-48"
          data-menu-content="frame"
          onCloseAutoFocus={(event) => {
            /* The host's own rows open a dialog or act in this document: focus
               returns to the trigger, quietly — unless it has gone to a module. */
            const to = focusAfter(closing.current)
            closing.current = 'dismissed'
            if (to === 'trigger') returning(quiet)
            else event.preventDefault()
          }}
        >
          <DropdownMenuLabel className="truncate py-1 text-[11px] font-normal" title={name}>
            {name}
          </DropdownMenuLabel>
          {tools ? (
            <DropdownMenuItem className={ROW} title={tools.hint} data-frame="tools" onSelect={onTools}>
              {tools.loud ? <Unplug className="size-3.5" /> : <Plug className="text-muted-foreground size-3.5" />}
              <span className="flex-1">Tools…</span>
              <span className={tools.loud ? 'text-[10px] font-medium' : 'text-muted-foreground text-[10px]'}>{tools.state}</span>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSub onOpenChange={feedback.opened}>
            <DropdownMenuSubTrigger className={ROW} data-frame="feedback">
              <MessageSquare className="text-muted-foreground size-3.5" />
              <span className="flex-1">Feedback</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-72 max-w-[calc(100vw-1rem)]">
              <FeedbackRows feedback={feedback} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            className={ROW}
            title={
              prompted
                ? 'prompts — this module uses one, and this is where it is written'
                : 'prompts — what this container says to another module, and what it is told'
            }
            data-frame="prompts"
            onSelect={onPrompts}
          >
            <MessageSquareText className="text-muted-foreground size-3.5" />
            <span className="flex-1">Prompts…</span>
            {prompted ? <span className="text-[10px] font-medium">uses one</span> : null}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <FeedbackDialog feedback={feedback} module={module} name={name} kehikko={kehikko} epic={epic} />
    </>
  )
}

/**
 * What the Frame menu says about a module's tools: the word on the row, the
 * sentence behind it, and whether it is the state somebody should act on.
 * `null` for a module with no MCP door, which has no row. The sentences are
 * the ones the plug had; see `ToolsMark` in `Tools.tsx`, which the host's own
 * strip still draws.
 */
export function toolsSaying(
  agent: AgentAwareness | undefined,
  name: string,
): { state: string; hint: string; loud: boolean } | null {
  if (!agent || agent.kind === 'none') return null
  if (agent.kind === 'untold') {
    return {
      state: 'not connected',
      loud: true,
      hint: `${name} offers tools to an agent, and no agent has been told about them. Open the frame menu to see the tools and to connect them.`,
    }
  }
  if (agent.kind === 'elsewhere') {
    return {
      state: 'points elsewhere',
      loud: true,
      hint: `An MCP server called "${agent.as}" is configured, and it points at ${agent.pointsAt} rather than at this module. An agent will reach that address and get nothing. Open the frame menu to repoint it.`,
    }
  }
  if (agent.kind === 'renamed') {
    return {
      state: 'connected under an old name',
      loud: true,
      hint: `${name}'s tools are connected as "${agent.as}", and the module now asks to be connected as "${agent.to}". Open the frame menu to reconnect it under that name.`,
    }
  }
  if (agent.kind === 'refused') {
    return { state: 'name refused', loud: true, hint: agent.why }
  }
  return {
    state: 'connected',
    loud: false,
    hint: `${name}'s tools are connected, as "${agent.as}". Open this to see what it offers, or to disconnect it.`,
  }
}
