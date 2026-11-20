import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { ComponentProps } from 'react'
import { Responsive, type Layout } from 'react-grid-layout'
import { Absent } from '@/canvas/Arriving.tsx'
import { Container } from '@/canvas/Container.tsx'
import { cornerHandle } from '@/canvas/CornerHandle.tsx'
import type { PressNote } from '@/canvas/HeaderMenus.tsx'
import { findControls, type Finds } from '@/canvas/useFinds.ts'
import type { useInbox } from '@/canvas/useInbox.ts'
import type { useRestarts } from '@/canvas/useRestarts.ts'
import { collapseFor } from '@/host/appearance.ts'
import type { useAppearance } from '@/host/appearanceStore.ts'
import type { rememberedModules } from '@/host/arriving.ts'
import { COLUMNS, type Placement } from '@/host/canvases.ts'
import type { Expanded as ExpandedOne } from '@/host/expand.ts'
import { chosen } from '@/host/filters.ts'
import { CANVAS_ROWS } from '@/host/fit.ts'
import { signedBy } from '@/host/folds.ts'
import type { FooterStore } from '@/host/footerStore.ts'
import { NO_HEADER, type Headers } from '@/host/header.ts'
import { offersInboxUse } from '@/host/inboxUse.ts'
import { offersMessagesUse } from '@/host/messagesUse.ts'
import type { Presses } from '@/host/presses.ts'
import type { useRects } from '@/host/rects.ts'
import type { Presence, RegistryView } from '@/host/registry.ts'
import { PINNED_VERSION } from '@/host/restartModule.ts'
import type { Reveals } from '@/host/reveal.ts'
import { coveredForScope, scopeOfContainer } from '@/host/scope.ts'
import { showing } from '@/host/standing.ts'
import type { subjectOf } from '@/host/subject.ts'
import { pinnedPresence, type PinView } from '@/host/versions.ts'
import { openWhatsNew } from '@/host/whatsNew.ts'
import type { Live } from './live.ts'
import type { useAgentMarks } from './useAgentMarks.ts'
import type { useDialogs } from './useDialogs.ts'
import type { useDragResize } from './useDragResize.ts'

/**
 * The grid, told its width rather than left to measure it.
 *
 * It used to be `WidthProvider(Responsive)`. `WidthProvider` renders once at a
 * hardcoded 1280 pixels, measures the element it rendered into, and renders
 * again at the real width — and the grid is keyed by kehikko, so that happened
 * on EVERY switch, not once a load: every container drawn in the wrong column,
 * then moved. Its own answer, `measureBeforeMount`, was a trap of a different
 * kind: with it on, the measurement never arrived and the grid stayed at 1280
 * for the life of the page.
 *
 * The canvas already measures its own surface (`useRects`, for `room`), so the
 * width comes from there, and the grid is not drawn until there is one. A new
 * grid is born at its real width. See `host/switching.ts` for what that and the
 * rest of the switch cost before.
 */
const Grid = Responsive

/*
 * Grid geometry. The gaps, and only the gaps.
 *
 * There is no `ROW_HEIGHT` here any more. A row is not a size this file
 * chooses; it is `room / CANVAS_ROWS`, decided in `fit.ts` for the same reason
 * a column is `room / COLUMNS` — see the essay there, and the two wrong answers it
 * records. What is left in this constant is the one piece of vertical geometry
 * that really is fixed: the eight pixels of air between rows, above the first
 * and below the last, which the fit has to subtract before it divides.
 */
export const MARGIN: [number, number] = [8, 8]

type ContainerProps = ComponentProps<typeof Container>
/** A container's handler, as the page holds it: the same, with the module it is for first. */
type ForModule<K extends keyof ContainerProps> = NonNullable<ContainerProps[K]> extends (...args: infer A) => infer R ? (id: string, ...args: A) => R : never

/**
 * Everything the page hands each container on the grid: what is known about
 * its module, the open kehikko, and the page's handlers. Gathered in `App.tsx`
 * and read here exactly as the loop read them there.
 */
export interface CanvasWiring {
  byId: ReadonlyMap<string, Presence>
  registry: RegistryView | null
  lastModules: ReturnType<typeof rememberedModules>
  pinViews: ReadonlyMap<string, PinView>
  live: Readonly<Record<string, Live>>
  staleOf: (id: string, found: Live | undefined) => boolean
  drawing: ReadonlySet<string>
  loadingCovers: ReadonlyMap<string, string | null>
  askedFor: number | null
  restarts: ReturnType<typeof useRestarts>
  setGenerations: Dispatch<SetStateAction<Record<string, number>>>
  /** A sweep; `true` asks every manifest again. */
  look: (fresh: boolean) => unknown
  open: { id: number; name: string } | null
  openId: number | null
  about: ReturnType<typeof subjectOf>
  drawn: ReturnType<typeof useAppearance>
  signed: ReturnType<typeof useAgentMarks>['signed']
  arrangeMark: ReturnType<typeof useAgentMarks>['arrangeMark']
  body: ReturnType<typeof useRects>['body']
  headers: Headers
  footerStore: FooterStore
  reveals: Reveals
  presses: Presses
  pressNotes: Readonly<Record<string, PressNote>>
  inbox: ReturnType<typeof useInbox>
  messagesMuted: ReadonlySet<string>
  muteMessages: (module: string, muted: boolean) => void
  expandedNow: { module: { id: string } } | null
  setExpanded: (next: ExpandedOne | null) => void
  finds: Finds
  dialogs: Pick<ReturnType<typeof useDialogs>, 'openPrompts' | 'openTools' | 'openSkills' | 'openHelp' | 'openIntro' | 'openSettings'>
  onUnplace: (id: string) => void
  onGrow: ForModule<'onGrow'>
  onPin: ForModule<'onPin'>
  onCollapse: ForModule<'onCollapse'>
  onTile: ForModule<'onTile'>
  onPressItem: ForModule<'onPress'>
  onFooterPressItem: ForModule<'onFooterPress'>
  onChooseFilter: ForModule<'onChoose'>
  onEverything: ForModule<'onEverything'>
  onRefreshEvery: ForModule<'onRefreshEvery'>
  onSelect: ForModule<'onSelect'>
}

/**
 * The grid of containers on the open kehikko: `react-grid-layout`, told its
 * width, its rows and its gestures (`useDragResize`), and one container per
 * placement. Moved out of `App.tsx` as it was drawn there; the layer it sits
 * in, and the pages beneath it, stay in `App.tsx`.
 */
export function CanvasGrid({
  openId,
  width,
  moving,
  gliding,
  laid,
  rowHeight,
  onLayoutChange,
  gestures,
  containers,
  wiring,
}: {
  openId: number | null
  width: number
  moving: string | null
  gliding: number
  laid: Layout[]
  rowHeight: number
  onLayoutChange: (next: Layout[]) => void
  gestures: ReturnType<typeof useDragResize>['gestures']
  containers: readonly Placement[]
  wiring: CanvasWiring
}): ReactNode {
  return (
    <Grid
      style={{ position: 'relative' }}
      /* Keyed by the canvas, so switching them is a new grid rather than
         the same grid being told every container moved at once. */
      key={openId ?? 'none'}
      /* Told, not measured: see `Grid` above. */
      width={width}
      /* Animated only for a person's own drag or resize, and a fold. */
      className={moving !== null || gliding ? 'min-h-full in-motion' : 'min-h-full'}
      layouts={{ lg: laid }}
      breakpoints={{ lg: 0 }}
      cols={{ lg: COLUMNS }}
      rowHeight={rowHeight}
      /*
       * The canvas has a bottom, the way it has always had a right-hand
       * edge, and this is the line that gives it one.
       *
       * `cols` and `maxRows` are the same kind of statement: the axis has a
       * fixed number of divisions and nothing may exceed them. That is what
       * makes a column's width `room / 24` regardless of the content, and
       * with this it is what makes a row's height `room / 56` regardless of
       * the content — which is the whole of the fix in `fit.ts`.
       *
       * Verified in the library rather than assumed: `maxRows` reaches
       * `calcXY` and `calcWH` in `calculateUtils.js`, which clamp a DRAG to
       * `maxRows - h` and a RESIZE to `maxRows - y`. So a person feels the
       * bottom of the canvas while dragging, rather than discovering
       * afterwards that something was clipped.
       *
       * What it does NOT reach is the compaction that runs when the host
       * writes a placement itself, which is why `roomBelow` exists and why
       * `onHeight` calls it. A module asking to grow is the host writing a
       * placement, and this prop would not have stopped it.
       */
      maxRows={CANVAS_ROWS}
      margin={MARGIN}
      containerPadding={MARGIN}
      draggableHandle=".container-grip"
      onLayoutChange={onLayoutChange}
      /* A drag by the grip and a pull on a corner, measured as they move: `gestures`, see
         `app/useDragResize.ts`. */
      {...gestures}
      /* A container cannot be dropped into another container's space; the grid pushes
         instead. Free placement would let one module hide another, and a
         module a person cannot find is worse than one they have to arrange
         around. */
      compactType="vertical"
      resizeHandles={['se', 'sw', 'ne', 'nw']}
      resizeHandle={cornerHandle}
    >
      {containers.map((placement) => (
        /* The grid's own child, keyed by the container: what it positions. */
        <div key={placement.i}>
          <CanvasContainer placement={placement} wiring={wiring} />
        </div>
      ))}
    </Grid>
  )
}

/** One placement: its module's container, or what stands in for a module this computer does not have. */
function CanvasContainer({ placement, wiring }: { placement: Placement; wiring: CanvasWiring }) {
  const {
    byId, registry, lastModules, pinViews, live, staleOf, drawing, loadingCovers, askedFor, restarts, setGenerations, look,
    open, openId, about, drawn, signed, arrangeMark, body, headers, footerStore, reveals, presses, pressNotes,
    inbox, messagesMuted, muteMessages, expandedNow, setExpanded, finds, onUnplace, onGrow, onPin, onCollapse, onTile,
    onPressItem, onFooterPressItem, onChooseFilter, onEverything, onRefreshEvery, onSelect,
  } = wiring
  const { openPrompts, openTools, openSkills, openHelp, openIntro, openSettings: openModuleSettings } = wiring.dialogs
  /* A pinned container shows its version's presence, or the pin's
     sentence while the version is on its way — never the latest
     copy's page. See `pinnedPresence`. */
  const { presence, waiting } = pinnedPresence(
    byId.get(placement.i),
    placement.version ?? null,
    open ? pinViews.get(`${open.id}|${placement.i}`) : undefined,
  )
  if (!presence) {
    /* Missing only once a reading of the whole registry says so; until then, on its way. */
    return <Absent id={placement.i} reading={registry} name={lastModules.get(placement.i)?.name ?? null} onRemove={() => onUnplace(placement.i)} />
  }
  const found = waiting ? undefined : live[presence.id]
  return (
    <Container
      presence={presence}
      /* The page, the cover, or a notice. Nothing found yet is a
         module that has been framed and has not spoken, which
         `condition` alone cannot express: discovery said `ready`
         because the manifest read, not because the page answered. */
      showing={showing(presence, found && { ...found, stale: staleOf(presence.id, found), held: drawing.has(presence.id), label: loadingCovers.get(presence.id) ?? null }, askedFor === openId, restarts.of(presence.id))}
      loading={!drawing.has(presence.id) && loadingCovers.has(presence.id) ? { label: loadingCovers.get(presence.id) ?? null } : null}
      restart={restarts.of(presence.id)}
      onRestart={() => restarts.restart(presence.id)}
      /* A pinned version's process is the version's, not the module's own copy a restart names. */
      restartBlocked={placement.version ? PINNED_VERSION : undefined}
      /* "Reload page" on a page that went silent or failed: a new document, as a restart gives. */
      onReload={() => setGenerations((was) => ({ ...was, [presence.id]: (was[presence.id] ?? 0) + 1 }))}
      coverDetail={waiting ? presence.line : undefined}
      fault={found?.fault ?? null}
      body={body(presence.id)}
      grow={placement.grow}
      onGrow={(grow) => onGrow(presence.id, grow)}
      pinned={placement.pinned}
      onPin={(pinned) => onPin(presence.id, pinned)}
      collapsed={placement.collapsed}
      onCollapse={(collapsed) => onCollapse(presence.id, collapsed)}
      tiled={placement.tiled === true}
      onTile={(tiled) => onTile(presence.id, tiled)}
      /* What the collapse button does: Settings › Appearance's, the same for every container. */
      collapseMakes={collapseFor(drawn, presence.id)}
      /* How far a fold goes, and when the rows show: Settings › Appearance's, the same for every container. */
      foldRows={drawn.foldRows}
      rowsMode={drawn.rows}
      foldedBy={signedBy(signed && signed.kehikko === openId ? signed.marks : null, placement)}
      arrangedBy={arrangeMark && arrangeMark.kehikko === openId && arrangeMark.changed.includes(placement.i) ? arrangeMark.by : null}
      header={headers[presence.id] ?? NO_HEADER}
      /* A press on whichever frame is standing, judged against
         what is declared now — see `onPressItem`. */
      onPress={(press) => onPressItem(presence.id, press)}
      /* Its declared footer (protocol 2.38.0), pressed the same way with `place: 'footer'`. */
      footerSource={footerStore.source(presence.id)}
      onFooterPress={(press) => onFooterPressItem(presence.id, press)}
      /* Which rows are revealed: on hover or on click, as `rowsMode` says. Every container
         has a say now, so the reveal is handed to all of them. */
      reveals={reveals}
      /* And the keyboard to that frame after a press that closed
         its menu — see `focusAfter` in `host/header.ts`. */
      onKeyboard={() => presses.focus(presence.id)}
      /* Full screen for a run that asks for it, on THIS frame; an
         agent's `press_item` never comes this way. */
      surface={{
        enter: () => presses.fullscreen(presence.id),
        leave: () => presses.leaveFullscreen(presence.id),
      }}
      pressNote={pressNotes[presence.id] ?? null}
      /* The offer is the conversation's — it dies with the program —
         and the choice is the arrangement's. See `Live` above. */
      filters={found?.filters ?? []}
      chosen={chosen(found?.filters ?? [], placement.filters)}
      onChoose={(group, option) => onChooseFilter(presence.id, group, option)}
      onEverything={() => onEverything(presence.id)}
      /* `?? null` folds "never said anything" and "said there is
         nothing to clear" into the one thing the header draws for
         both, which is nothing. `Live.clear` keeps them apart for
         whoever is working out why a control is missing. */
      clear={found?.clear ?? null}
      /* The press, made at the moment of the press, on whichever
         frame is standing — see `presses.ts`. Nothing is stored and
         nothing is replayed: a press at a module that has gone does
         nothing at all, which is the only correct answer. */
      onClear={() => presses.press(presence.id)}
      /* Straight through, and never reconciled against anything the
         host knows: `at` is the module's statement about its own
         data. See `Refreshing.tsx`. */
      refresh={found?.refresh}
      /* And the setting beside it, which is the host's. The pair is
         the whole shape of this feature — the module owns the
         state, the container owns the clock. */
      refreshEvery={placement.refreshEvery}
      /* A press, like the clear, on whichever frame is standing.
         The interval in the effect above calls the same thing. */
      onRefresh={() => presses.refresh(presence.id)}
      onRefreshEvery={(every) => onRefreshEvery(presence.id, every)}
      selected={placement.selected}
      onSelect={(selected) => onSelect(presence.id, selected)}
      onPrompts={() => openPrompts(presence.id)}
      onTools={() => openTools(presence.id)}
      onSkills={() => openSkills(presence.id)}
      onHelp={() => openHelp(presence.id)}
      onIntro={() => {
        openIntro(presence.id, { name: presence.name ?? presence.id, summary: presence.summary }, false)
      }}
      onNotes={() => openWhatsNew({ item: presence.id })}
      onSettings={() => {
        openModuleSettings(presence.id, null)
      }}
      scope={presence.module ? scopeOfContainer(presence.module, placement.scope) : null}
      onStarted={() => void look(true)}
      onRemove={() => onUnplace(presence.id)}
      kehikko={open?.name ?? null}
      epic={about.epic}
      oneEpic={!waiting && coveredForScope(about.scope, presence.module, placement.pinned, placement.scope)}
      canvas={open?.id ?? null}
      version={placement.version ?? null}
      current={waiting ? null : (presence.module?.version ?? null)}
      /* The server has written the pin and woken this page for the
         kehikko; looking again picks up what the version is doing. */
      onVersion={() => void look(true)}
      /* "Use inbox": the person's, per module and machine-wide; a row of the Container menu. */
      inboxUse={
        offersInboxUse(presence.module, inbox.muted.has(presence.id))
          ? { on: !inbox.muted.has(presence.id), onChange: (on) => inbox.use(presence.id, on) }
          : undefined
      }
      /* "Messages to agents": the person's, per module in this project; the row after "Use inbox". */
      messagesUse={
        offersMessagesUse(presence.module, messagesMuted.has(presence.id))
          ? { on: !messagesMuted.has(presence.id), onChange: (on) => muteMessages(presence.id, !on) }
          : undefined
      }
      /* "Expand": shown large over the canvas for a while, and put back (`host/expand.ts`). */
      expand={
        open
          ? {
              on: expandedNow?.module.id === presence.id,
              onChange: (on) => setExpanded(on ? { kehikko: open.id, id: presence.id } : null),
            }
          : undefined
      }
      onActivitySeen={() =>
        inbox.see(inbox.open.filter((one) => one.module === presence.id && one.state === 'done'))
      }
      find={findControls(finds, presence.id)}
    />
  )
}
