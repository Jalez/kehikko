import { helpFor } from '@/host/moduleHelp.ts'
import { introFor } from '@/host/moduleIntro.ts'

import type { Choice } from '@/host/filters.ts'
import { restartable, type RestartState } from '@/host/restartModule.ts'
import { NO_HEADER, type Pressed, type Pressing } from '@/host/header.ts'
import type { Presence } from '@/host/registry.ts'
import { revealModeOf, type FilterGroup, type FooterItem, type HeaderItem } from 'kehikot-module-protocol'
import { NO_FOOTER, footerRowDrawn } from '@/host/footer.ts'
import { fixedFooter, type FooterSource } from '@/host/footerStore.ts'
import { focusHandlers, revealHandlers, useRevealed, type Reveals } from '@/host/reveal.ts'
import type { FindBar as FindBarState } from '@/host/find.ts'
import type { ActivityState } from 'kehikot-module-protocol'
import { standingRows, useStandingPress } from './Standing.tsx'
import { standingOf } from '@/host/coverFit.ts'
import { frameEntriesOf, helpEntriesOf, type FrameParts, type PressNote, type Surface } from './HeaderMenus.tsx'
import { controlsOf, type ControlParts } from './HeaderControls.tsx'
import { useFeedback } from './Feedback.tsx'
import { layoutOf, modeFor, pinsFor } from '@/host/headerOffer.ts'
import { noticeOf, type Showing } from '@/host/standing.ts'
import { foldDrawn, rowsHide, type FoldRows, type ShowRows } from '@/host/rows.ts'
import type { ContainerScope } from '@/host/scope.ts'
import { useSyncExternalStore } from 'react'
import { releaseShown } from '@/host/source.ts'
import { versionLabel } from '@/host/versions.ts'
import { drawsOwnTile } from '@/host/tile.ts'
import type { Collapse } from '@/host/appearance.ts'
import { headerContent } from '@/host/containerView.ts'
import { ContainerBody } from './ContainerBody.tsx'
import { ContainerHeader } from './ContainerHeader.tsx'
import { useContainerResize } from './useContainerResize.ts'

/**
 * One thing on the canvas — or rather, the frame around one thing.
 *
 * A hairline border, a header thin enough to be a grip rather than a title bar,
 * and then a body that is either empty or filled with the sentence explaining
 * why there is nothing in it. The header is the drag handle and the body is
 * not: a container whose body dragged would be a container a person cannot click inside,
 * and clicking inside is the entire point of the thing.
 *
 * ## The module's page is not in here
 *
 * The body is hollow, and its only job is to be somewhere the canvas can
 * measure. The page itself is positioned over it from a layer that outlives
 * every container — see the essay in `Frames.tsx` for why a module's document has to
 * be created once and never moved, and why switching canvases would otherwise
 * reload everything on both of them.
 *
 * That split is why this component takes no context, no controls and no
 * watcher any more. It draws a box and a sentence. Everything that talks to a
 * module happens somewhere else.
 *
 * ## Why a notice can sit over a page that is still loading
 *
 * When a module's manifest answered but its page has not spoken yet, the container
 * shows a panel and the page keeps loading behind it. Unmounting would destroy
 * a document that is, as far as anyone knows, still on its way, and would make
 * "did not answer in four seconds" a death sentence rather than an observation.
 * A module that answers late simply clears the panel and appears, which is what
 * a person expects of something that was merely slow.
 */
export function Container({
  presence,
  showing,
  loading = null,
  coverDetail,
  fault,
  body,
  grow,
  onGrow,
  pinned,
  onPin,
  collapsed,
  onCollapse,
  tiled = false,
  onTile = () => {},
  collapseMakes = 'fold',
  foldRows = 1,
  rowsMode,
  foldedBy = null,
  arrangedBy = null,
  header = NO_HEADER,
  onPress = unpressable,
  footer = NO_FOOTER,
  footerSource,
  onFooterPress = unpressable,
  reveals = null,
  onKeyboard,
  surface,
  pressNote = null,
  restart,
  onRestart,
  restartBlocked,
  onReload,
  filters,
  chosen,
  onChoose,
  onEverything,
  clear,
  onClear,
  refresh,
  refreshEvery,
  onRefresh,
  onRefreshEvery,
  selected,
  onSelect,
  onPrompts,
  onTools,
  onSkills,
  onHelp,
  onIntro,
  onNotes,
  onSettings,
  onStarted,
  onRemove,
  scope = null,
  kehikko,
  epic,
  oneEpic = false,
  canvas = null,
  version = null,
  current = null,
  onVersion = () => {},
  activity = null,
  onActivitySeen,
  inboxUse,
  messagesUse,
  expand,
  find = null,
}: ContainerProps) {
  const name = presence.name ?? presence.id
  /* How much of the header's left side there is room for (`host/headerFit.ts`), kept as the
     container is resized: `useContainerResize`. */
  const { grip, width, fit } = useContainerResize(headerContent(name, version, current, presence))
  const shownVersion = versionLabel(version ?? null, current ?? releaseShown(presence.source) ?? presence.module?.version ?? null)
  /* The name is cut with an ellipsis when it must be, so its whole is in its title, with the
     version once that has no room of its own. */
  const nameTitle = fit.version ? name : `${name} · ${shownVersion}`
  /* Every module has the gear: its window holds its declared settings, when it has any, and always
     its Providers & Consumers (`ModuleSettingsDialog`). */
  const hasSettings = onSettings !== undefined
  const notice = showing.kind === 'notice' ? noticeOf(showing, presence) : null
  /* The cover or notice in every size's words (`host/coverFit.ts`): the body draws it for its own
     box, and folded, the header carries its word and the Container menu its press. */
  const standing = showing.kind === 'page' ? null : standingOf(showing, notice, presence.at, coverDetail, name)
  /* "Restart module", on every container: pressable only for a module this host may restart. */
  const can = restartBlocked ? { ok: false as const, why: restartBlocked } : restartable(presence)
  const pressing = useStandingPress(standing?.action ?? null, presence.id, onStarted, can.ok ? onRestart : undefined)
  /* What the module declared, as it declared it: the host's own rows are the Container menu's. */
  const items = header
  /* For the dot and the header's controls, which are the page's and are
     offered only while the page is what is showing. */
  const mode: ShowRows = rowsMode ?? (reveals ? 'hover' : 'always')
  const revealed = useRevealed(reveals, presence.id, mode)
  /* Whether the module's footer can be drawn at all, and then how the fold is drawn: two rows only
     when that was chosen and there is a footer to draw (`host/rows.ts`). */
  const source = footerSource ?? fixedFooter(footer)
  const declaredFooter = useSyncExternalStore(source.subscribe, () => source.get().length > 0)
  const footerDrawn = footerRowDrawn(declaredFooter, showing.kind === 'page' && !oneEpic, false)
  const fold = foldDrawn(collapsed, foldRows, footerDrawn)
  /* A tile says its footer's readouts in its square, and draws no footer row. */
  const footed = !tiled && footerRowDrawn(declaredFooter, showing.kind === 'page' && !oneEpic, fold)
  /* A tile shows the module's own tile where its page draws one, else the host's (`host/tile.ts`). */
  const ownTile = tiled && showing.kind === 'page' && !oneEpic && drawsOwnTile(presence.module)
  /* Everything the header offers, as one list, and where each entry goes at this width
     (`host/headerOffer.ts`): the module's menus, the gear and the Container rows all come from it, so
     the same things are reachable at every width and folded, and each in one place. */
  const feedback = useFeedback(presence.id)
  /* The module's own row controls: buttons while there is room, rows of the "⋯" under 220 px. */
  const controlParts: ControlParts = {
    name,
    filter: { groups: filters, chosen, onChoose, onEverything },
    clear: { label: clear, onClear },
    refresh: { state: refresh, every: refreshEvery, onRefresh, onEvery: onRefreshEvery },
  }
  const frameParts: FrameParts = {
    module: presence.id,
    name,
    feedback,
    onSettings: hasSettings ? onSettings : undefined,
    scope,
    agent: presence.agent,
    onTools,
    skills: presence.module?.declares.skills,
    onSkills,
    /* Help is never missing: a module that wrote no how-to gets "About <name>…" in the same place.
       Introduction is left out instead when there is none — a generic one would say only what About
       says — and the menu's order stays the same either way (`HELP_ENTRIES`). */
    onHelp,
    helpWritten: helpFor(presence.module) !== null,
    onIntro: onIntro && introFor(presence.module) ? onIntro : undefined,
    onNotes,
    prompted: presence.module?.declares.prompt === true,
    onPrompts,
    inbox: inboxUse,
    messages: messagesUse,
    expand: expand && showing.kind === 'page' && !collapsed && !oneEpic ? expand : undefined,
    standing: collapsed && standing ? standingRows(standing, pressing, () => onCollapse(false)) : undefined,
    controls: controlParts,
    restart: { can, state: restart, onRestart: () => onRestart?.() },
    onRemove,
  }
  const page = showing.kind === 'page'
  const layout = layoutOf(
    { items: page ? items : [], frame: frameEntriesOf(frameParts), help: helpEntriesOf(frameParts), controls: page ? controlsOf(controlParts) : [] },
    modeFor(width),
    pinsFor(width),
    fold,
  )

  return (
    /*
     * No background on the container itself, and no pointer either.
     *
     * The module's page is painted UNDERNEATH this — see `App.tsx` — so
     * anything opaque here would hide it, and anything that takes the pointer
     * here would swallow clicks meant for it. The parts that need to be seen
     * and pressed opt back in one at a time: the header, the fault line, and
     * whichever notice is standing in for a page that is not there.
     *
     * The border stays, because the border is the container. It is the only thing
     * that says where one module ends and the next begins.
     */
    <div
      /*
       * A folded container is as tall as its header and no taller.
       *
       * The grid gives it two rows — fifty-six pixels, the smallest that can
       * hold a thirty-two pixel header. The first version of this folded to TWO
       * rows and drew only its own thirty-four pixels, leaving the rest of the
       * row as canvas — on the reasoning that a header with twenty-two pixels
       * of empty card under it reads as a container that failed to load.
       *
       * That reasoning was right about the card and wrong about the space. The
       * emptiness did not go away; it moved outside the container, where the grid
       * was still holding fifty-six pixels for something drawing thirty-four.
       * The person folding a container to reclaim space got twenty-two pixels of
       * nothing between it and its neighbour, which is the same waste with a
       * transparent background — and it looked, in their words, weird.
       *
       * So a folded container is ONE row, and the header fills it exactly. Nothing
       * is reserved that is not drawn. One row is twenty-four pixels against a
       * header that wants thirty-two, so the header goes dense when folded
       * rather than the grid going coarse: the controls shrink, which is a
       * change to one CSS rule, instead of every container on every canvas getting
       * taller to make room for the folded case.
       */
      /*
       * The ring is the selection, and the checkbox is only how you set it.
       *
       * A tick in a thirty-two pixel header is legible when you are reading
       * that header and invisible from across a canvas of eight containers,
       * which is exactly the distance the question "which ones did I pick?" is
       * asked from. So the border of the selected container changes colour and
       * grows a ring — the border being, as the essay above says, the one thing
       * that says where one module ends and the next begins.
       *
       * `ring-inset`, because a ring drawn outside the border would be painted
       * over the eight pixels of margin the grid puts between containers and
       * would touch its neighbour.
       */
      /*
       * `@container/container` so the header can ask how wide THIS container is.
       *
       * Not a media query, because the question is not how big the screen is —
       * it is how many of six controls fit in a column somebody dragged to two
       * grid columns while the window is 1400 pixels wide. Every module in this
       * workspace already sizes itself this way; the host's own chrome did not,
       * and this is what that cost.
       */
      className={
        (selected
          ? 'container-frame border-primary ring-primary/60 pointer-events-none @container/container relative flex h-full flex-col overflow-hidden rounded-lg border ring-2 ring-inset'
          : 'container-frame pointer-events-none @container/container relative flex h-full flex-col overflow-hidden rounded-lg border')
        + (arrangedBy ? ' outline-primary/70 outline-2 -outline-offset-4 outline-dashed' : '')
      }
      /* Arranged by an agent, until the person arranges it or presses Undo (`ArrangeMark.tsx`). */
      data-arranged-by={arrangedBy ?? undefined}
      /* Picked out: its coloured border stands whatever border Settings › Appearance chose (`index.css`). */
      data-picked={selected ? 'true' : undefined}
      /* Which module this container is showing, for anything that has to find
         one container on the canvas by what is in it. */
      data-module={presence.id}
      /* A module that says `reveal: 'over'` (protocol 2.42.0): in focus mode
         its rows reveal OVER its page and never resize it (`index.css`,
         `host/reveal.ts`). */
      data-reveal={revealModeOf(presence.module) === 'over' ? 'over' : undefined}
      /* Whether this container's rows hide until revealed — on hover, click or long press, as
         Settings › Appearance says (`host/appearance.ts`); the `[data-rows='hide']` rules in `index.css`. */
      data-rows={rowsHide(mode) ? 'hide' : undefined}
      data-rows-mode={mode}
      data-fold={fold || undefined}
      data-tiled={tiled ? (ownTile ? 'own' : 'host') : undefined}
      /* In focus mode, the pointer over any part of this container that the
         host document can see — its header, its footer, a cover or notice —
         holds the reveal; the module's page holds it from the frames layer.
         See `host/reveal.ts`. */
      {...revealHandlers(reveals, presence.id, 'chrome')}
      {...focusHandlers(reveals, presence.id)}
      data-revealed={revealed ? 'true' : undefined}
    >
      <ContainerHeader
        grip={grip}
        presence={presence}
        showing={showing}
        name={name}
        nameTitle={nameTitle}
        fit={fit}
        revealed={revealed}
        layout={layout}
        items={items}
        frameParts={frameParts}
        feedback={feedback}
        standing={standing}
        pressing={pressing}
        footerDrawn={footerDrawn}
        selected={selected}
        onSelect={onSelect}
        activity={activity}
        onActivitySeen={onActivitySeen}
        canvas={canvas}
        version={version}
        current={current}
        onVersion={onVersion}
        onPress={onPress}
        onKeyboard={onKeyboard}
        surface={surface}
        pressNote={pressNote}
        filters={filters}
        chosen={chosen}
        onChoose={onChoose}
        onEverything={onEverything}
        clear={clear}
        onClear={onClear}
        refresh={refresh}
        refreshEvery={refreshEvery}
        onRefresh={onRefresh}
        onRefreshEvery={onRefreshEvery}
        onSettings={onSettings}
        kehikko={kehikko}
        epic={epic}
        collapsed={collapsed}
        tiled={tiled}
        collapseMakes={collapseMakes}
        foldedBy={foldedBy}
        foldRows={foldRows}
        onCollapse={onCollapse}
        onTile={onTile}
        onRemove={onRemove}
      />
      <ContainerBody
        presence={presence}
        showing={showing}
        name={name}
        body={body}
        loading={loading}
        coverDetail={coverDetail}
        fault={fault}
        collapsed={collapsed}
        tiled={tiled}
        fold={fold}
        revealed={revealed}
        source={source}
        footed={footed}
        ownTile={ownTile}
        standing={standing}
        notice={notice}
        can={can}
        oneEpic={oneEpic}
        activity={activity}
        find={find}
        width={width}
        expand={expand}
        onFooterPress={onFooterPress}
        onKeyboard={onKeyboard}
        onStarted={onStarted}
        onRestart={onRestart}
        onReload={onReload}
      />
    </div>
  )
}

/** What a container is handed: the module, what it shows, and every press it can make. */
export interface ContainerProps {
  /**
   * The find bar over this container's page (protocol 2.69.0, `host/find.ts`): its state and what
   * its controls do. Absent or closed: no bar.
   */
  find?: FindControls | null
  presence: Presence
  /**
   * The project is on "All epics" and this module works on one epic at a
   * time: the body says so over the page, which is kept hidden underneath.
   * Decided by `coveredForScope` in `host/scope.ts`, for this body and the
   * frames layer alike.
   */
  oneEpic?: boolean
  /**
   * What this container shows — the page, the cover, or a notice — decided
   * once, in `host/standing.ts`, for this body and the frames layer alike.
   */
  showing: Showing
  /**
   * The page is redrawing for a new context and was not drawn in time
   * (protocol 2.84.0, `kehikot.loading`): the cover over it, in the module's
   * words or `null` for the host's. Drawn over the page's place while it is
   * still the page, so its header and footer stay as they are.
   */
  loading?: { label: string | null } | null
  /** A second line for the cover, when something more specific is known (a pinned version being prepared). */
  coverDetail?: string
  fault: string | null
  /** Where the module's page goes. Handed to the canvas so it can be measured. */
  body: (element: HTMLElement | null) => void
  /** Whether this container follows the height its module asks for. */
  grow: boolean
  onGrow(grow: boolean): void
  /** Whether this container is pinned, and stops hearing about the canvas. */
  pinned: boolean
  onPin(pinned: boolean): void
  /**
   * Whether this container is folded down to its header.
   *
   * The module keeps running and its page keeps its document; it is simply not
   * drawn. See the essay on `onCollapse` in `App.tsx`, and `Frames.tsx` for why
   * hiding a page and destroying one are nowhere near the same thing.
   */
  collapsed: boolean
  onCollapse(collapsed: boolean): void
  /**
   * Whether this container is drawn as a tile (`host/columns.ts`, `canvas/Tile.tsx`): its header,
   * then a small square — the module's own tile where it draws one (`host/tile.ts`), else the host's.
   * The module keeps running; the collapse button restores it.
   */
  tiled?: boolean
  onTile?(tiled: boolean): void
  /** What the collapse button does to an open container: Settings › Appearance's (`host/appearance.ts`). */
  collapseMakes?: Collapse
  /**
   * How far a fold goes: the header (1), or the header and footer (2, drawn
   * only while the footer is). Settings › Appearance's, the same for every
   * container (`host/appearance.ts`).
   */
  foldRows?: FoldRows
  /**
   * When the header and footer show: Settings › Appearance's, the same for
   * every container. Absent: on hover when `reveals` is given, else always.
   */
  rowsMode?: ShowRows
  /**
   * Who left this container folded or unfolded as it is, when it was not the
   * person — "an agent". The fold control is drawn filled and says so, and a
   * press on it puts the container back. See `host/folds.ts`.
   */
  foldedBy?: string | null
  /**
   * Who resized, moved or showed this container, when it was an agent's `arrange_modules` and
   * the kehikko is still as it left it. Drawn as a dashed outline that takes no room; the mark at
   * the foot of the kehikko names it and has Undo. See `host/arrange.ts`.
   */
  arrangedBy?: string | null
  /**
   * What the module last declared for this container's menus
   * (`kehikot.header`): its view switches, toggles, jumps and runs, drawn as
   * View, Go and Run. Empty for a module that has declared nothing, which
   * draws no module menu at all. See `HeaderMenus.tsx` and `host/header.ts`.
   */
  header?: readonly HeaderItem[]
  /**
   * One item of that header was chosen. Answers what became of it — taken,
   * or not and why — once the module has said. A press, made on whichever
   * frame is standing, like `onClear`.
   */
  onPress?(press: Pressing): Promise<Pressed>
  /**
   * What the module last declared for its footer (protocol 2.38.0). Empty
   * draws no row: a module that declared nothing has no footer at all.
   */
  footer?: readonly FooterItem[]
  /**
   * The same, read from where the page holds it (`FooterStore.source`), in place of `footer`: a
   * readout ticking then re-renders the footer row alone, and this container only when the module
   * starts or stops declaring a footer at all.
   */
  footerSource?: FooterSource
  /** Send one press on a footer item. See `footerPressing` in `host/footer.ts`. */
  onFooterPress?(press: Pressing): Promise<Pressed>
  /**
   * Which containers have their header and footer revealed in focus mode
   * (`host/reveal.ts`). The container, its header and its footer are sources;
   * the module's frame, in the other layer, is the fourth.
   */
  reveals?: Reveals | null
  /**
   * Hand the keyboard to the module's page: called after a press that closed
   * the menu it was made in, instead of focus going back to the menu's
   * trigger. See `focusAfter` in `host/header.ts`.
   */
  onKeyboard?(): void
  /** Full screen for a run that asks for it. See `HeaderMenus` and `host/surface.ts`. */
  surface?: Surface
  /** An agent pressed an item here through the host's door: said on the menu's trigger for a moment. */
  pressNote?: PressNote | null
  /**
   * What this module says it can be narrowed by, right now.
   *
   * Empty for almost every module, and empty is not a state that draws
   * anything: see `Filters.tsx`. A module that never sends an offer has exactly
   * the header it had before this existed.
   */
  filters: readonly FilterGroup[]
  /** Which option is current in each group, already reconciled against `filters`. */
  chosen: Choice
  onChoose(group: string, option: string | string[]): void
  onEverything(): void
  /**
   * What this module says it can clear of what it is showing, in its own words.
   *
   * `null` for almost every module — including every module that has never
   * mentioned the idea — and `null` draws nothing at all: see `Clearing.tsx`. A
   * paper cannot delete a paper, and a header full of controls that cannot work
   * is a header nobody reads.
   */
  clear: string | null
  /** Send the press. The host arms; this is called only by the second press. */
  onClear(): void
  /**
   * What this module says about being read again: whether it can be, when it
   * last was, and whether it is reading right now.
   *
   * `undefined` for almost every module — including every module that has never
   * mentioned the idea — and that draws nothing at all, like the other two
   * offers. The middle field is the module's own fact about its own data, which
   * is why this is a state a module REPORTS rather than something the host works
   * out from when it last asked; see `Refreshing.tsx`.
   */
  refresh: { can: boolean; at: string | null; busy: boolean } | undefined
  /** How often this container reads on its own, in minutes, or `null`. The host's setting. */
  refreshEvery: number | null
  onRefresh(): void
  onRefreshEvery(every: number | null): void
  /**
   * Whether this container has been picked out as a target on this kehikko.
   *
   * A fact about the canvas, not about the module. It does cross the wire now
   * — every module on the kehikko is told which containers are picked out, in
   * `context.containers` — and the program inside is not told anything
   * SPECIAL for being one of them: it reads the same list its neighbours read.
   * See the essay on `onSelect` in `App.tsx`.
   */
  selected: boolean
  onSelect(selected: boolean): void
  /** Open the host's prompt dialog for this container. */
  onPrompts(): void
  /** Open the host's tools window for this module. */
  onTools(): void
  /** Open the host's skills window for this module (protocol 2.5.0). Absent: no Skills row. */
  onSkills?(): void
  /**
   * Open the module's "How to use" (protocol 2.52.0) when its manifest says how (`helpFor`), else its
   * "About <name>" — the same row of its Help menu either way. Absent: no such row.
   */
  onHelp?(): void
  /**
   * Open the module's own introduction (protocol 2.57.0) in the app's introduction dialog. An
   * "Introduction…" row in its Help menu only when the module has one (`introFor`); absent: never.
   */
  onIntro?(): void
  /** Open What's new at this module's release notes: "What's new…" in its Help menu. Absent: no row. */
  onNotes?(): void
  /**
   * Open this module's settings (protocol 2.15.0): a gear in the row at 220 px and wider, folded or
   * not; under that, "Settings…" in the Container rows (in "⋯" when the module has menus). One entry at
   * every width (`layoutOf` in `host/headerOffer.ts`). See `ModuleSettings.tsx`.
   */
  onSettings?(): void
  /**
   * The container's scope (protocol 2.29.0): the "Scope:" row of the Container menu at every width,
   * which opens the settings window. Not drawn in the row: the menu says it, and the row's room goes
   * to what `ROW_PRIORITY` keeps. Absent or null while the module's manifest has not been read.
   */
  scope?: ContainerScope | null
  /** Look again, after this module has been started. */
  onStarted(): void
  /**
   * Restart this module (`/host/restart-module`): "Restart module" in the Container menu, which every
   * container has whatever the module declared (`host/restartModule.ts`). Disabled with the reason for
   * a module this host did not start. Left out, a press does nothing (a test that does not look).
   */
  onRestart?(): void
  /** What the page knows of a restart it asked for here. See `host/restartModule.ts`. */
  restart?: RestartState
  /** Why this container's module cannot be restarted from here though the host started it (a pinned version). */
  restartBlocked?: string
  /** "Reload page" on a notice over a page that went silent or failed: a new document for the frame. */
  onReload?(): void
  onRemove(): void
  /** The open kehikko's name and epic, written under any feedback filed from here. */
  kehikko: string | null
  epic: string | null
  /** The open kehikko's id, which a version pin is stored on. */
  canvas?: number | null
  /** The tag this container is pinned to, or null for latest. See `Versions.tsx`. */
  version?: string | null
  /**
   * What the running copy calls itself. For a pinned container that is not
   * running yet, `presence` is a stand-in, so the latest checkout's version
   * would be the wrong thing to show; the caller says.
   */
  current?: string | null
  /** A pin or unpin went through. */
  onVersion?(): void
  /** The worst state this module's items hold (`host/activity.ts`), or null. Drawn as one dot beside the condition dot. */
  activity?: ActivityState | null
  /** The finished dot was pressed: this module's finished items were seen. */
  onActivitySeen?(): void
  /**
   * "Use inbox" for this module (`host/inboxUse.ts`): whether what it says reaches the Inbox, and the
   * person's change. A checkbox row of the Container menu at every width and fold. Absent: no row.
   */
  inboxUse?: { on: boolean; onChange(on: boolean): void }
  /**
   * "Messages to agents" for this module in this project (`host/messagesUse.ts`): whether its own
   * messages reach the agent sessions, and the person's change. A row of the Container menu. Absent: no row.
   */
  messagesUse?: { on: boolean; onChange(on: boolean): void }
  /**
   * "Expand" (`host/expand.ts`): whether this container is shown large over the canvas now, and the
   * person's change. A row of the Container menu while its page is showing and it is not folded.
   */
  expand?: { on: boolean; onChange(on: boolean): void }
}

/** The find bar of one container, as the canvas hands it over (`useFinds`). */
export interface FindControls {
  bar: FindBarState
  mac: boolean
  onQuery(query: string): void
  onCase(caseSensitive: boolean): void
  onStep(direction: 'next' | 'prev'): void
  onClose(): void
}

/** A container nobody wired a press to: said, rather than a row that does nothing. */
function unpressable(): Promise<Pressed> {
  return Promise.resolve({ ok: false, why: 'Nothing here takes a press.' })
}
