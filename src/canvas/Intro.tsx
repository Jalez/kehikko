import { ArrowLeft, ArrowRight, Compass, XIcon } from 'lucide-react'
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.tsx'
import { BUILT_IN_LAYOUTS } from '@/host/layouts.ts'
import { KehikkoMark } from './Mark.tsx'

/**
 * The introduction: a welcome, and what Kehikot brings — not a manual. How
 * the controls work is the tour's job (`src/host/tour.ts`); this says why a
 * person would want them.
 *
 * Each slide has a small picture drawn in the theme's own colours (inline SVG,
 * nothing to load, right in dark as in light) that moves a little: a play-once
 * entrance or a quiet loop, all of it CSS (`.intro-art` in `index.css`). With
 * `prefers-reduced-motion` the pictures stand still, and every one is drawn so
 * that its still frame says the same thing.
 *
 * Opened by itself once per `INTRO_VERSION` (`src/host/onboarding.ts`), and
 * again from Help → Introduction. Closing it any way — Skip, the ✕, Escape,
 * or either button on the last slide — counts as seen. The ✕ has a row of its
 * own above the picture, so it never sits on one.
 */

export interface IntroSlide {
  id: string
  title: string
  body: string
  art: () => ReactNode
}

/** The picture's frame: a rounded panel in the muted colour, the drawing inside it. */
function Art({ label, children }: { label: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 320 150"
      className="intro-art bg-muted/40 h-36 w-full rounded-md border sm:h-40"
      role="img"
      aria-label={label}
      data-intro-picture=""
    >
      {children}
    </svg>
  )
}

const box = 'fill-card stroke-border'
const strong = 'fill-primary/15 stroke-primary'
const line = 'fill-muted-foreground/35'
const head = 'fill-muted-foreground/25'

/** A delay for a CSS animation, as a style. */
const after = (seconds: number): CSSProperties => ({ animationDelay: `${seconds}s` })

/** A container: a box with a header strip, the way a kehikko draws one. */
function Pane({
  x,
  y,
  w,
  h,
  className = box,
  header = head,
  style,
}: {
  x: number
  y: number
  w: number
  h: number
  className?: string
  header?: string
  style?: CSSProperties
}) {
  return (
    <g className="ia-pop" style={style}>
      <rect x={x} y={y} width={w} height={h} rx="4" className={className} strokeWidth="1.25" />
      <rect x={x} y={y} width={w} height="7" rx="3.5" className={header} />
    </g>
  )
}

function Rows({ x, y, widths, gap = 9, className = line }: { x: number; y: number; widths: number[]; gap?: number; className?: string }) {
  return (
    <>
      {widths.map((w, i) => (
        <rect key={i} x={x} y={y + i * gap} width={w} height="4" rx="2" className={className} />
      ))}
    </>
  )
}

/** The five ways of working, and the built-in layout each starts from. */
export const WAYS = ['design', 'research', 'development', 'review', 'learning'] as const

export const INTRO_SLIDES: readonly IntroSlide[] = [
  {
    id: 'welcome',
    title: 'Welcome to Kehikot',
    body: 'One window for everything a piece of work needs: your tools, your AI agents and the project they are about, side by side.',
    art: () => (
      <Art label="a frame drawing itself, and the tools of a piece of work filling it">
        <rect x="30" y="14" width="260" height="122" rx="8" pathLength="1000" className="ia-draw stroke-primary fill-none" strokeWidth="2" />
        <Pane x={42} y={26} w={96} h={98} style={after(0.7)} header="fill-primary/30" />
        <Pane x={146} y={26} w={132} h={45} style={after(0.9)} />
        <Pane x={146} y={79} w={62} h={45} style={after(1.1)} />
        <Pane x={216} y={79} w={62} h={45} style={after(1.3)} />
        <g className="ia-rise" style={after(1.2)}>
          <Rows x={52} y={42} widths={[70, 52, 62, 40, 66, 48]} gap={12} />
        </g>
        <g className="ia-rise" style={after(1.4)}>
          <Rows x={156} y={42} widths={[96, 74, 84]} />
        </g>
        {/* An agent at work, arriving last. */}
        <g className="ia-pop" style={after(1.6)}>
          <circle cx="266" cy="40" r="4.5" className="ia-pulse fill-emerald-500" style={after(2.1)} />
        </g>
      </Art>
    ),
  },
  {
    id: 'together',
    title: 'Every tool for one piece of work, together',
    body: 'Your agent, your issues, your notes and your editor sit on one kehikko, all on the same project and epic. Pick a part of the work and every one of them narrows to it.',
    art: () => (
      <Art label="the bar's project, epic and part above three modules; picking the part narrows all three">
        <rect x="20" y="10" width="280" height="20" rx="4" className={box} strokeWidth="1.25" />
        <rect x="28" y="17" width="40" height="6" rx="3" className="fill-foreground/50" />
        <rect x="76" y="17" width="56" height="6" rx="3" className="fill-foreground/35" />
        <rect x="140" y="14" width="50" height="12" rx="6" className="fill-muted-foreground/15" />
        <rect x="140" y="14" width="50" height="12" rx="6" className="ia-chip fill-primary/25 stroke-primary" strokeWidth="1" />
        <rect x="149" y="18" width="32" height="4" rx="2" className="fill-foreground/60" />
        {[20, 116, 212].map((x, i) => (
          <g key={x}>
            <Pane x={x} y={38} w={88} h={102} style={after(0.15 * i)} header={i === 0 ? 'fill-primary/30' : head} />
            {[0, 1, 2, 3, 4, 5].map((r) => (
              <rect
                key={r}
                x={x + 9}
                y={54 + r * 13}
                width={[60, 44, 52, 66, 38, 56][(r + i) % 6]}
                height="5"
                rx="2.5"
                className={r % 3 === 1 ? 'fill-foreground/55' : `${line} ia-narrow`}
              />
            ))}
          </g>
        ))}
      </Art>
    ),
  },
  {
    id: 'keep-working',
    title: 'Switch projects — the others keep working',
    body: 'Move to another project and the one you left carries on: its modules keep running and its agents keep at it. The Inbox tells you when one of them needs you.',
    art: () => (
      <Art label="a project in front, another behind it still working, and a dot in the Inbox when it needs you">
        {/* Behind: the project you left, still busy. */}
        <g className="ia-rise">
          <rect x="24" y="12" width="200" height="96" rx="6" className="fill-muted stroke-border" strokeWidth="1.25" />
          <path d="M34 20 h18 l4 4 h22 v8 h-44 z" className="fill-muted-foreground/30" />
          <rect x="166" y="22" width="48" height="6" rx="3" className="fill-muted-foreground/20" />
          <rect x="166" y="22" width="48" height="6" rx="3" className="ia-fill fill-sky-500/80" />
          <g transform="translate(152 25)">
            <circle r="5" className="fill-none stroke-sky-500/30" strokeWidth="2" />
            <path d="M0 -5 a5 5 0 0 1 5 5" className="ia-spin stroke-sky-500 fill-none" strokeWidth="2" strokeLinecap="round" />
          </g>
        </g>
        {/* In front: where you are now. */}
        <g className="ia-rise" style={after(0.3)}>
          <rect x="76" y="44" width="220" height="96" rx="6" className={box} strokeWidth="1.5" />
          <path d="M86 52 h18 l4 4 h22 v8 h-44 z" className="fill-primary/40" />
          <Rows x={88} y={76} widths={[120, 90, 104, 70]} gap={13} />
          {/* The Inbox, and the dot that comes when the other project needs you. */}
          <rect x="262" y="51" width="24" height="14" rx="4" className="fill-muted stroke-border" strokeWidth="1" />
          <path d="M268 55 h12 l-2 6 h-8 z" className="fill-muted-foreground/50" />
          <circle cx="285" cy="51" r="4.5" className="ia-ping fill-amber-500" />
        </g>
      </Art>
    ),
  },
  {
    id: 'ways',
    title: 'A kehikko for every way you work',
    body: 'Design, research, development, review, learning: start each from a layout made for it, keep as many as you like, and make each one your own.',
    art: () => <WaysArt />,
  },
  {
    id: 'agents',
    title: 'Agents that know where they are',
    body: 'Put an agent module such as Claude on a kehikko, and every conversation it starts already knows the project, epic and parts, with the tools and skills of the modules beside it. The skills follow what’s there: /journey with Journeys, /factory with Factory, /review-factory where Review and Factory both are.',
    art: () => (
      <Art label="an agent conversation connected to the modules beside it">
        <Pane x={16} y={12} w={132} h={126} header="fill-primary/30" />
        <rect x="26" y="28" width="92" height="16" rx="5" className="fill-muted stroke-border" strokeWidth="1" />
        <text x="32" y="39.5" className="fill-foreground font-mono" fontSize="9">
          /journey
        </text>
        <rect x="27" y="29" width="90" height="14" rx="4" className="ia-uncover fill-muted" />
        <g className="ia-rise" style={after(1.6)}>
          <rect x="40" y="52" width="98" height="30" rx="5" className="fill-primary/10 stroke-primary/40" strokeWidth="1" />
          <Rows x={48} y={59} widths={[76, 58]} gap={9} className="fill-foreground/45" />
        </g>
        <g transform="translate(34 104)">
          {[0, 1, 2].map((i) => (
            <circle key={i} cx={i * 9} cy="0" r="2.6" className="ia-dot fill-muted-foreground" style={after(i * 0.18)} />
          ))}
        </g>
        {[18, 60, 102].map((y, i) => (
          <g key={y}>
            <path d={`M148 75 C 176 75, 176 ${y + 15}, 204 ${y + 15}`} className="ia-flow stroke-primary/60 fill-none" strokeWidth="1.5" />
            <Pane x={204} y={y} w={100} h={30} style={after(0.2 + i * 0.15)} />
            <rect x={212} y={y + 15} width={[52, 64, 44][i]} height="4" rx="2" className={line} />
            <circle cx={292} cy={y + 17} r="3" className="ia-blink fill-emerald-500" style={after(i * 0.5)} />
          </g>
        ))}
      </Art>
    ),
  },
  {
    id: 'inbox',
    title: 'One Inbox for what needs you',
    body: 'Approvals, change requests and finished work from every module, in every project, arrive in one list. Alt+Shift+N takes you to the next thing that needs you.',
    art: () => (
      <Art label="an Inbox filling with what needs you, what is working and what has finished">
        <rect x="70" y="10" width="180" height="130" rx="6" className={box} strokeWidth="1.5" />
        <rect x="80" y="19" width="44" height="6" rx="3" className="fill-foreground/55" />
        <rect x="206" y="17" width="34" height="10" rx="5" className="fill-amber-500/20" />
        <rect x="214" y="20" width="18" height="4" rx="2" className="fill-amber-600/80" />
        {(
          [
            ['fill-amber-500', 96],
            ['fill-sky-500', 78],
            ['fill-emerald-500', 108],
            ['fill-amber-500', 64],
          ] as const
        ).map(([dot, w], i) => (
          <g key={i} className="ia-drop" style={after(i * 0.55)}>
            <rect x="80" y={36 + i * 25} width="160" height="20" rx="4" className="fill-muted/60" />
            <circle cx="91" cy={46 + i * 25} r="3.5" className={dot} />
            <rect x="101" y={40 + i * 25} width={w} height="4" rx="2" className="fill-foreground/50" />
            <rect x="101" y={48 + i * 25} width={w - 30} height="3.5" rx="1.75" className={line} />
          </g>
        ))}
      </Art>
    ),
  },
  {
    id: 'modules',
    title: 'Modules that keep up, and modules of your own',
    body: 'Every module updates from its releases, and you can read what is new before you take it. Your own private modules sit right beside the official ones.',
    art: () => (
      <Art label="a module moving to its newer release beside a private module of your own">
        <Pane x={24} y={20} w={150} h={110} header="fill-primary/30" />
        <Rows x={36} y={62} widths={[110, 84, 120, 70]} gap={14} />
        <rect x="112" y="31" width="52" height="16" rx="8" className="fill-muted stroke-border" strokeWidth="1" />
        <text x="138" y="42" textAnchor="middle" className="ia-swap-old fill-muted-foreground font-mono" fontSize="8.5">
          1.5.0
        </text>
        <text x="138" y="42" textAnchor="middle" className="ia-swap-new font-mono fill-emerald-600 dark:fill-emerald-400" fontSize="8.5">
          1.6.0
        </text>
        <g transform="translate(40 39)">
          <path d="M-5 0 a5 5 0 1 1 1.5 3.6" className="ia-turn stroke-emerald-500 fill-none" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M-7 -1 l2 2 l2 -2" className="stroke-emerald-500 fill-none" strokeWidth="1.4" strokeLinecap="round" />
        </g>
        {/* Yours: dashed, with a lock. */}
        <g className="ia-pop" style={after(0.5)}>
          <rect x="190" y="20" width="106" height="110" rx="4" className="fill-card stroke-muted-foreground/60" strokeDasharray="4 3" strokeWidth="1.25" />
          <rect x="202" y="68" width="70" height="4" rx="2" className={line} />
          <rect x="202" y="82" width="54" height="4" rx="2" className={line} />
          <g transform="translate(243 42)">
            <rect x="-8" y="-2" width="16" height="12" rx="2" className={strong} strokeWidth="1.2" />
            <path d="M-5 -2 v-3 a5 5 0 0 1 10 0 v3" className="stroke-primary fill-none" strokeWidth="1.2" />
          </g>
        </g>
      </Art>
    ),
  },
  {
    id: 'yours',
    title: 'Yours, and easy to share',
    body: 'Your data stays in your project’s folder and on your computer. A kehikko’s layout travels with the project, so your team can start from it, while what you pick and fold stays your own view.',
    art: () => (
      <Art label="a layout carried from your project's folder to a teammate, while your own view stays with you">
        {/* The project folder, holding .kehikot/. */}
        <path
          d="M24 40 h36 l8 8 h66 a5 5 0 0 1 5 5 v72 a5 5 0 0 1 -5 5 H29 a5 5 0 0 1 -5 -5 V45 a5 5 0 0 1 5 -5 z"
          className={box}
          strokeWidth="1.5"
        />
        <rect x="36" y="62" width="48" height="12" rx="2" className={strong} strokeWidth="1" />
        <text x="60" y="71" textAnchor="middle" className="fill-foreground font-mono" fontSize="7">
          .kehikot
        </text>
        <rect x="36" y="84" width="80" height="5" rx="2.5" className={line} />
        <rect x="36" y="96" width="62" height="5" rx="2.5" className={line} />
        {/* Your view stays with you. */}
        <g transform="translate(70 118)" className="ia-rise" style={after(0.4)}>
          <path d="M-13 0 q13 -11 26 0 q-13 11 -26 0 z" className="fill-muted stroke-muted-foreground/60" strokeWidth="1.2" />
          <circle r="3.4" className="fill-foreground/60" />
        </g>
        {/* A teammate's own copy of the project. */}
        <g transform="translate(266 34)">
          <circle r="11" className="fill-muted stroke-border" strokeWidth="1.25" />
          <circle cy="-3" r="4" className="fill-muted-foreground/50" />
          <path d="M-7 7 a7 6 0 0 1 14 0" className="fill-muted-foreground/50" />
        </g>
        <rect x="236" y="54" width="60" height="78" rx="4" className={box} strokeWidth="1.25" />
        <path d="M150 85 h70" className="ia-flow stroke-primary/50 fill-none" strokeWidth="1.5" />
        {/* The layout, carried across. */}
        <g className="ia-carry" style={{ ['--dx' as string]: '140px', ['--dy' as string]: '6px' }}>
          <rect x="102" y="66" width="44" height="32" rx="3" className="fill-card stroke-primary" strokeWidth="1.25" />
          <rect x="105" y="69" width="16" height="26" rx="1.5" className="fill-primary/25" />
          <rect x="124" y="69" width="19" height="12" rx="1.5" className="fill-primary/25" />
          <rect x="124" y="83" width="19" height="12" rx="1.5" className="fill-primary/25" />
        </g>
      </Art>
    ),
  },
]

const PILL_FONT = 8
/** Width of the picture the pills sit in (the `viewBox` of `Art`), the room kept at each end, and between pills. */
const PILL_ROW = { width: 320, edge: 14, gap: 10, perChar: 4.6, padding: 7 }

/**
 * The layout name pills: each as wide as its name needs plus padding, a fixed
 * gap between, the row centred. Sized to the text (not five equal boxes), so
 * "Development" has the room it needs; the whole picture scales down as one at
 * narrow widths, so nothing can overlap there either.
 */
export function pillRow(names: readonly string[]): { x: number; width: number }[] {
  const widths = names.map((name) => Math.round((name.length * PILL_ROW.perChar + PILL_ROW.padding * 2) * 10) / 10)
  const total = widths.reduce((sum, one) => sum + one, 0) + PILL_ROW.gap * (names.length - 1)
  let x = Math.max(PILL_ROW.edge, (PILL_ROW.width - total) / 2)
  return widths.map((width) => {
    const at = { x, width }
    x += width + PILL_ROW.gap
    return at
  })
}

/** "A kehikko for every way you work": the five layouts in turn, each name lit while its picture shows. */
function WaysArt() {
  const layouts = WAYS.map((id) => BUILT_IN_LAYOUTS.find((one) => one.id === id)!)
  const pills = pillRow(layouts.map((one) => one.name)).map((pill, i) => ({ ...pill, layout: layouts[i]! }))
  /* The canvas the schematics are drawn on: 12 columns by 28 rows into 190 by 100. */
  const X = 65
  const Y = 12
  const cw = 190 / 12
  const rh = 100 / 28
  return (
    <Art label="design, research, development, review and learning, each with its own layout">
      <rect x={X - 4} y={Y - 4} width="198" height="108" rx="6" className="fill-background stroke-border" strokeWidth="1.25" />
      {layouts.map((layout, i) => (
        <g key={layout.id} className={i === 0 ? 'ia-cycle ia-first' : 'ia-cycle'} style={after(i * 2)} data-way={layout.id}>
          {layout.containers.map((c) => (
            <g key={c.module}>
              <rect
                x={X + c.x * cw + 1.5}
                y={Y + c.y * rh + 1.5}
                width={c.w * cw - 3}
                height={c.h * rh - 3}
                rx="3"
                className={c.optional ? 'fill-card stroke-muted-foreground/50' : box}
                strokeDasharray={c.optional ? '3 2' : undefined}
                strokeWidth="1"
              />
              <rect x={X + c.x * cw + 1.5} y={Y + c.y * rh + 1.5} width={c.w * cw - 3} height="4" rx="2" className="fill-primary/30" />
            </g>
          ))}
        </g>
      ))}
      {pills.map(({ layout, x, width }, i) => (
        <g key={layout.id} data-way-pill={layout.id}>
          <rect x={x} y="124" width={width} height="17" rx="8.5" className="fill-muted-foreground/10" />
          <rect
            x={x}
            y="124"
            width={width}
            height="17"
            rx="8.5"
            className={`${i === 0 ? 'ia-cycle ia-first' : 'ia-cycle'} fill-primary/20 stroke-primary`}
            strokeWidth="1"
            style={after(i * 2)}
          />
          <text x={x + width / 2} y="135" textAnchor="middle" className="fill-foreground" fontSize={PILL_FONT} fontWeight="500">
            {layout.name}
          </text>
        </g>
      ))}
    </Art>
  )
}

/** Does the person ask for less motion? Read on each open; a test stubs `matchMedia`. */
export function prefersStill(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function IntroDialog({
  open,
  onOpenChange,
  onTour,
  onExplore,
}: {
  open: boolean
  /** Closing in any way — Skip, ✕, Escape, or one of the last slide's buttons — is `false`. */
  onOpenChange(open: boolean): void
  /** "Show me around": the tour, from the first thing not done yet. */
  onTour(): void
  /** "I'll explore myself". */
  onExplore(): void
}) {
  const [at, setAt] = useState(0)
  const [still, setStill] = useState(false)
  useEffect(() => {
    if (!open) return
    setAt(0)
    setStill(prefersStill())
  }, [open])
  const slide = INTRO_SLIDES[at]!
  const last = at === INTRO_SLIDES.length - 1

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showClose={false}
        className="max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0 sm:max-w-lg [&>*]:min-w-0"
        data-intro={slide.id}
        data-motion={still ? 'still' : 'moving'}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && !last) setAt((n) => n + 1)
          if (event.key === 'ArrowLeft' && at > 0) setAt((n) => n - 1)
        }}
      >
        {/* The close has this row to itself: the picture starts below it. */}
        <div className="flex h-11 items-center gap-2 pr-2 pl-4" data-intro-top="">
          <KehikkoMark working={false} className="size-4" />
          <span className="text-muted-foreground text-xs font-medium">Kehikot</span>
          <span className="flex-1" />
          <span className="text-muted-foreground text-[11px] tabular-nums" aria-hidden>
            {at + 1} / {INTRO_SLIDES.length}
          </span>
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-7"
              aria-label="Close the introduction"
              data-intro-close=""
            >
              <XIcon className="size-4" />
            </Button>
          </DialogClose>
        </div>

        <div className="px-4" data-intro-art="">
          {/* Keyed, so each slide's picture plays from its start. */}
          <div key={slide.id}>{slide.art()}</div>
        </div>

        <div className="flex flex-col gap-1.5 px-5 pt-4">
          <DialogTitle className={at === 0 ? 'text-lg' : undefined}>{slide.title}</DialogTitle>
          <DialogDescription>{slide.body}</DialogDescription>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 px-5 pt-4 pb-4">
          <div className="flex min-w-24 flex-1 items-center gap-1.5" role="group" aria-label={`slide ${at + 1} of ${INTRO_SLIDES.length}`}>
            {INTRO_SLIDES.map((one, i) => (
              <button
                key={one.id}
                type="button"
                aria-label={one.title}
                aria-current={i === at ? 'step' : undefined}
                onClick={() => setAt(i)}
                data-intro-dot=""
                className={`h-1.5 rounded-full transition-all ${i === at ? 'bg-primary w-4' : 'bg-muted-foreground/30 hover:bg-muted-foreground/60 w-1.5'}`}
              />
            ))}
          </div>
          {last ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                data-intro-explore=""
                onClick={() => {
                  onOpenChange(false)
                  onExplore()
                }}
              >
                I’ll explore myself
              </Button>
              <Button
                size="sm"
                data-intro-tour=""
                onClick={() => {
                  onOpenChange(false)
                  onTour()
                }}
              >
                <Compass className="size-3.5" />
                Show me around
              </Button>
            </>
          ) : (
            <>
              {at === 0 ? (
                <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} data-intro-skip="">
                  Skip
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setAt((n) => n - 1)} aria-label="back">
                  <ArrowLeft className="size-3.5" />
                  Back
                </Button>
              )}
              <Button size="sm" onClick={() => setAt((n) => n + 1)} data-intro-next="">
                Next
                <ArrowRight className="size-3.5" />
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
