import { X } from 'lucide-react'
import type { RefObject } from 'react'
import type { HeaderItem } from 'kehikot-module-protocol'

import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { conditionOf, lifecycleOf, overflowParts } from '@/host/containerView.ts'
import type { Standing } from '@/host/coverFit.ts'
import type { HeaderFit } from '@/host/headerFit.ts'
import type { HeaderLayout } from '@/host/headerOffer.ts'
import { settingsHint } from '@/host/moduleSettings.ts'
import { releaseShown } from '@/host/source.ts'
import { ActivityDot } from './Activity.tsx'
import { BranchMark } from './Branch.tsx'
import { ClearButton } from './Clearing.tsx'
import { ConditionDot } from './Conditions.tsx'
import type { ContainerProps } from './Container.tsx'
import { FeedbackDialog, type FeedbackState } from './Feedback.tsx'
import { FilterButton } from './Filters.tsx'
import { FoldControl } from './FoldControl.tsx'
import { ContainerHelpMenu, FrameMenu, HeaderMenus, type FrameParts } from './HeaderMenus.tsx'
import { Hint } from './Hint.tsx'
import { ModuleIcon } from './ModuleIcon.tsx'
import { SettingsButton } from './ModuleSettings.tsx'
import { RefreshButton } from './Refreshing.tsx'
import { StandingChip } from './Standing.tsx'
import { VersionPicker } from './Versions.tsx'

/**
 * A container's header row (`Container.tsx`): the pick box, the dots, the name and what gives way
 * before it, the module's menus and row controls, then the host's — gear, Help, Container, fold and
 * remove — each where `layout` (`host/headerOffer.ts`) puts it at this width.
 */
export type ContainerHeaderProps = Pick<
  ContainerProps,
  | 'presence'
  | 'showing'
  | 'selected'
  | 'onSelect'
  | 'onActivitySeen'
  | 'onKeyboard'
  | 'surface'
  | 'filters'
  | 'chosen'
  | 'onChoose'
  | 'onEverything'
  | 'clear'
  | 'onClear'
  | 'refresh'
  | 'refreshEvery'
  | 'onRefresh'
  | 'onRefreshEvery'
  | 'onSettings'
  | 'kehikko'
  | 'epic'
  | 'collapsed'
  | 'onCollapse'
  | 'onRemove'
> &
  Required<
    Pick<ContainerProps, 'activity' | 'canvas' | 'version' | 'current' | 'onVersion' | 'onPress' | 'pressNote' | 'tiled' | 'onTile' | 'collapseMakes' | 'foldedBy' | 'foldRows'>
  > & {
    /** On the header: what `useContainerResize` measures. */
    grip: RefObject<HTMLElement | null>
    name: string
    /** The name's title: the whole name, with the version once that has no room of its own. */
    nameTitle: string
    fit: HeaderFit
    /** The header and footer are revealed in focus mode (`host/reveal.ts`). */
    revealed: boolean
    layout: HeaderLayout
    /** What the module declared for its menus, as it declared it. */
    items: readonly HeaderItem[]
    frameParts: FrameParts
    feedback: FeedbackState
    /** The cover or notice, folded: its word in the header. Null while the page shows. */
    standing: Standing | null
    pressing: { said: string | null; running: boolean }
    /** The module's footer row can be drawn, for how far a fold goes. */
    footerDrawn: boolean
  }

export function ContainerHeader({
  grip,
  presence,
  showing,
  name,
  nameTitle,
  fit,
  revealed,
  layout,
  items,
  frameParts,
  feedback,
  standing,
  pressing,
  footerDrawn,
  selected,
  onSelect,
  activity,
  onActivitySeen,
  canvas,
  version,
  current,
  onVersion,
  onPress,
  onKeyboard,
  surface,
  pressNote,
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
  onSettings,
  kehikko,
  epic,
  collapsed,
  tiled,
  collapseMakes,
  foldedBy,
  foldRows,
  onCollapse,
  onTile,
  onRemove,
}: ContainerHeaderProps) {
  const { ownOverflow, frameEntries, overflowControls, overflowHelp, helpEntries } = overflowParts(layout)
  /*
   * The header, inside a wrapper that does nothing at all most of the time.
   *
   * In focus mode the wrapper is a row of no height that grows to the
   * header's while this container is revealed (`host/reveal.ts`: the
   * pointer anywhere over it, or focus within it), pushing the module's
   * page down rather than covering it — see the `.focus-mode` rules in
   * `index.css`.
   *
   * Outside focus mode this div is a plain block in the column and changes
   * nothing. It is not conditional on the mode: a wrapper that appeared and
   * disappeared would remount the header, and remounting a drag handle
   * mid-canvas is a good way to lose a gesture.
   */
  return (
      <div
        className={collapsed ? 'container-reveal min-h-0 flex-1' : 'container-reveal shrink-0'}
        data-collapsed={collapsed ? 'true' : undefined}
        data-revealed={revealed ? 'true' : undefined}
        /*
         * A SELECTED container keeps its header in focus mode, exactly as a
         * folded one does, and the reason is a cousin of that one.
         *
         * Focus mode hides headers to give space back to the modules, and the
         * cost it accepts is that a control is a hover away. That is a fair
         * trade for a control — you know you have a pin because you pressed it,
         * and it is where you left it. It is not a fair trade for a STATE
         * somebody else can change: an agent selects two containers through the
         * MCP door, and in focus mode the person watching would see nothing at
         * all happen. Worse in the other direction — a selection you cannot see
         * is a selection you will forget you made, and the next tool call you
         * ask for lands on containers you no longer meant.
         *
         * The ring is drawn either way, because the ring is on the container
         * and not in the header. So this exemption is not what makes the
         * selection visible; it is what keeps the box you untick it with
         * reachable, on the one container where reaching for it is likely.
         */
        data-selected={selected ? 'true' : undefined}
        /* A tile keeps its header, which holds its restore control (`index.css`). */
        data-tiled={tiled ? 'true' : undefined}
      >
      {/*
       * The gaps close before the controls do.
       *
       * ## The measurement that produced this line
       *
       * A container two grid columns wide is 224 pixels. Its header holds a
       * twelve-pixel checkbox, a six-pixel dot, a name, a version, and six
       * twenty-four-pixel buttons, separated by ten eight-pixel gaps — which is
       * 282 pixels of content in 222 of room. The name is `truncate`, so it
       * gives way to nothing and then stops helping; nothing else in the row can
       * shrink at all. The surplus spills to the right, where the container's
       * own `overflow-hidden` clips it, and what gets clipped is the last two
       * buttons in the row.
       *
       * Measured on this canvas, at 224 pixels: the pin's right edge at 259 and
       * the remove button's at 291, against a container edge at 224. Both were
       * off the end and unpressable — not merely tight, GONE, with nothing on
       * screen to say so.
       *
       * That was true before the filter button existed: without it the remove
       * button still ended at 259. The filter did not cause this and it would
       * have made it worse, which is why this is fixed here rather than
       * reported. A control that a person cannot reach at the width they
       * actually use their canvas at is a control that is not there.
       *
       * ## Why the gaps, and why not something else
       *
       * Ten gaps at eight pixels is eighty pixels — more than three of the six
       * buttons. Halving them under 300 pixels recovers forty, and dropping the
       * version string (see below) recovers another thirty-four, which brings
       * 282 down to 208 and fits with room for a few letters of the name. The
       * alternatives were all worse: shrinking the buttons makes six targets
       * harder to hit at exactly the width where hitting them is already hard;
       * dropping a control means deciding which of fold, prompt and remove
       * a person in a narrow container does not need; and letting the header
       * scroll sideways is the horizontal-scroll failure this workspace has a
       * standing rule against.
       *
       * The threshold is 300 rather than 224 so that the change happens before
       * the clipping does, not at the moment of it — a container dragged
       * narrower tightens up and then stays legible, instead of appearing to
       * work until the last few pixels.
       */}
      <header
        ref={grip}
        data-dense={collapsed ? 'true' : undefined}
        className={
          collapsed
            ? 'container-grip bg-card pointer-events-auto flex h-full cursor-move items-center gap-1.5 px-2 select-none @max-[300px]/container:gap-1'
            : 'container-grip bg-card pointer-events-auto flex h-8 shrink-0 cursor-move items-center gap-2 border-b px-2.5 select-none @max-[300px]/container:gap-1'
        }
      >
        {/*
         * The box that says this container is one of the ones being aimed at.
         *
         * ## Leftmost, before the dot
         *
         * Everything else in this header is a control that does something to
         * this container or to what is inside it — narrow it, clear it, fold
         * it, take it off — and they are
         * gathered on the right. This is not one of those. It marks the row,
         * the way the box at the start of a table row does, and a person
         * scanning a canvas for what they picked reads down a column of them.
         *
         * ## Why it cannot start a drag
         *
         * The header IS the drag handle — `draggableHandle=".container-grip"`
         * — so a press that reaches the grid begins a gesture, and a checkbox
         * that moved the container instead of ticking would be a control that
         * looks broken. `onMouseDown` is stopped here for the same reason every
         * button in this header stops it.
         *
         * ## Why it does not squeeze the row
         *
         * `shrink-0` on the box and `truncate` on the name: the name is the one
         * thing in this header that gives way, which it already did for six
         * controls. Measured at a 220px container, folded and unfolded, the row
         * does not wrap — a flex row does not wrap by default and nothing here
         * asks it to; what a narrow container costs is letters off the end of a
         * name, and the name is in a tooltip and in the modules list besides.
         */}
        <Hint
          label={
            selected
              ? 'picked out as a target on this kehikko — a module that narrows to what is picked out is following it. Press to unpick it'
              : 'pick this container out as a target on this kehikko. A module that narrows to what is picked out will follow it'
          }
          side="bottom"
          align="start"
        >
          <Checkbox
            checked={selected}
            aria-label={selected ? `unpick ${name}` : `pick ${name} out as a target`}
            className="shrink-0 cursor-default"
            onMouseDown={(event) => event.stopPropagation()}
            onCheckedChange={(next) => onSelect(next === true)}
          />
        </Hint>

        {/* What this module says it is doing (`host/activity.ts`): one dot
            beside the condition dot, the same size, drawn only when something
            is held. A finished one can be pressed to say it was seen. */}
        {activity ? (
          /* Not the condition dot's twin: a hair larger, with a thin ring of
             the header's own colour round it and a thin divider after it, so the
             two read as two things and not as one state. */
          <span className="border-border mr-0.5 flex shrink-0 items-center border-r pr-1.5">
            {activity === 'done' && onActivitySeen ? (
              <button
                type="button"
                aria-label="finished — mark as seen"
                title="finished — press to mark as seen"
                className="flex shrink-0 cursor-default items-center"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={onActivitySeen}
              >
                <ActivityDot state="done" className="ring-border size-2 ring-1" />
              </button>
            ) : (
              <ActivityDot state={activity} className="ring-border size-2 ring-1" />
            )}
          </span>
        ) : null}
        <ConditionDot condition={conditionOf(showing, presence)} lifecycle={lifecycleOf(showing)} />
        {/*
         * The name, and the module's own description behind it.
         *
         * Every module used to print its name and its one-line summary at the
         * top of its own page, directly under this header, which said the name
         * again. Two costs: the name twice, and — the one that matters — a
         * fixed strip of prose at the top of a container that is often only three
         * hundred pixels tall. In a short container the description was competing
         * with the thing a person opened the module to look at.
         *
         * The host already has that sentence. `summary` is a manifest field and
         * this host reads it on every sweep, so nothing new crosses the wire and
         * no module has to be asked. It goes here, on the name, where a title
         * attribute belongs.
         *
         * Hover-only would be a real loss, so it is deliberately not the only
         * route: the modules list in the strip above shows every module's
         * sentence in full, always, next to its name. This is the convenience;
         * that is the place it is guaranteed to be readable.
         */}
        {/* The module's icon, decorative beside its name (`ModuleIcon.tsx`). Kept at every width:
            second in `ROW_PRIORITY`, after the checkbox — it says which container this is when the
            name has been cut to nothing. */}
        {layout.row.includes('icon') ? <ModuleIcon id={presence.id} name={name} className="text-muted-foreground size-3.5 shrink-0" /> : null}
        {/*
         * The name and what gives way before it — version, branch mark, a folded container's state —
         * in one box that takes what the row leaves and clips its own tail. Nothing in it can push
         * the overflow, the fold or anything else on the right past the row's edge, however narrow
         * (`ROW_PRIORITY`); the name, first in it, is cut with an ellipsis before anything is clipped.
         */}
        <span data-header-left className="flex min-w-0 flex-1 items-center overflow-hidden [gap:inherit]">
        {presence.module?.summary ? (
          <Hint label={presence.module.summary} side="bottom" align="start">
            <span data-testid="header-name" title={nameTitle} className="min-w-0 shrink-[0.05] cursor-default truncate text-xs font-medium">{name}</span>
          </Hint>
        ) : (
          <span data-testid="header-name" title={nameTitle} className="min-w-0 shrink-[0.05] truncate text-xs font-medium">{name}</span>
        )}
        {/*
         * The version, and the first thing to go when the container is narrow.
         *
         * Thirty pixels of monospace plus its gap, and the least load-bearing
         * text in the row: it is a string this protocol never parses, shown to
         * a person, and it is also in the modules list in the strip above,
         * always, beside the name. Nothing a person does at 220 pixels depends
         * on reading it, and every other thing in this header is either an
         * identity or a control.
         */}
        {/* And a control: press it to pin this container to a tagged version
            of its module, or back to latest. A pinned container shows its tag
            in a tint and keeps it at any width — see `Versions.tsx`. */}
        <VersionPicker
          module={presence.id}
          name={name}
          kehikko={canvas}
          pinned={version}
          current={current ?? releaseShown(presence.source) ?? presence.module?.version ?? null}
          protocol={presence.module?.build?.protocol ?? null}
          onPicked={onVersion}
          text={fit.version}
          tight={!fit.quiet}
        />
        {/* The branch it runs from: quiet on main, marked anywhere else. See `Branch.tsx`. */}
        <BranchMark source={presence.source} text={fit.badgeText} quiet={fit.quiet} tight={!fit.quiet} />
        {/* No scope chip here: the scope is the Container menu's "Scope:" row, which opens the
            settings window where it is picked (`FrameRows` in `HeaderMenus.tsx`). */}
        {/* Folded with no page: the state as a word, its press in the Container menu (`Standing.tsx`). */}
        {collapsed && standing ? <StandingChip standing={standing} said={pressing.said} running={pressing.running} module={presence.id} name={name} /> : null}
        </span>

        {/*
         * The module's own menus: View, Go and Run, from what it declared.
         *
         * First of everything on the right, and on the module's side of the
         * line the filter essay below draws: they are here only because the
         * program asked for them. Nothing at all for a module that declared
         * nothing. Only while its page is what is showing — and folded too:
         * a folded header is as wide as the open one, and what it offers is
         * the same (`layoutOf` in `host/headerOffer.ts`). Under 220 pixels
         * they are one "⋯" whose last section is the Container rows.
         */}
        {showing.kind === 'page' ? (
          <HeaderMenus
            items={items}
            name={name}
            onPress={onPress}
            onKeyboard={onKeyboard}
            surface={surface}
            note={pressNote}
            layout={layout}
            frame={frameParts}
          />
        ) : null}

        {/*
         * There is no height toggle here any more, and the mechanism underneath
         * it is still built — the same disposal the pin got, for the same
         * reasons, and with the same check run first.
         *
         * It said whether this container followed the height its module asked
         * for: a list you scan wants to hold its size and scroll, a summary you
         * want all of wants to fit, and the host cannot know which this is. The
         * owner asked for the icon to go, to make room in a 32px strip for a
         * control that does something a person cannot do any other way. That
         * trade is the whole argument: the height toggle's job can be done by
         * dragging the corner, and clearing a module's items cannot be done at
         * all without a button.
         *
         * What stays: `grow` is a column on the placement, `onGrow` is still in
         * `App.tsx`, `onHeight` still refuses to act on `kehikot.resize` unless
         * the container has it, and `onLayoutChange` still carries it across a
         * drag. So it can be set by anything that writes a placement — the
         * host's canvas endpoint, or a future control — and a container that has
         * it on still follows its module. Ripping it out would have been a
         * migration to remove a capability nobody objected to.
         *
         * Verified before removing, and this was the one thing it could have got
         * wrong: `select count(*), sum(grow) from placements` on the live
         * database answered 17 and 0. No container on any kehikko is following
         * its module's height, so nothing is left following a height it can no
         * longer stop following — which is the mirror of the hazard the pin
         * removal checked for, and the one that would have had no way out.
         */}

        {/*
         * What this module shows, when it has said there is a choice about it.
         *
         * Before the fold, and the position is an argument rather than an
         * accident. Everything to the right of here — fold, prompts, remove —
         * is something the HOST does to a container, and is on every container
         * whatever is inside it. The two controls here belong to the PROGRAM:
         * they appear only because it asked for them and disappear when it
         * stops asking. They sit together at the boundary, on the module's side
         * of it, where the height toggle used to be the thing marking the line.
         *
         * Shown folded too. It used to be hidden there, and a folded container
         * then offered less than the same container open — the inconsistency
         * `host/headerOffer.ts` exists to end: the header holds the same things
         * at a width whether the container is open, one row or two.
         */}
        {layout.controls.includes('filter') ? (
          <FilterButton
            groups={filters}
            chosen={chosen}
            name={name}
            onChoose={onChoose}
            onEverything={onEverything}
          />
        ) : null}

        {/*
         * And the one that DELETES what the module is showing.
         *
         * Beside the filter deliberately, and that adjacency is the feature
         * rather than a tidy arrangement of icons. The two compose: what "shown"
         * means is whatever the filter has left, so narrowing to one thing and
         * pressing clear means that thing. Putting this behind a menu would hide
         * the composition — a person would have to remember that the two were
         * related — and putting it anywhere else on the canvas would be a
         * delete control that does not sit next to what decides its scope.
         *
         * The module decides all of that: the host relays a press and never
         * learns what went. See `Clearing.tsx` for the two-press arm, and the
         * protocol's `MESSAGE.CLEAR` for why the message carries nothing.
         *
         * Shown folded too, like the filter. A destructive control on a bare
         * strip is a press somebody can make while aiming at the fold beside
         * it, and that is exactly the failure the two-press arm exists for: the
         * first press only changes what it says.
         */}
        {layout.controls.includes('clear') ? (
          <ClearButton label={clear} name={name} onClear={onClear} />
        ) : null}

        {/*
         * And the one that asks the module to read its material again.
         *
         * Third in the module's own group, beside the filter and the clear,
         * because it belongs to the PROGRAM like both of them: it appears only
         * because the module asked for it and disappears when it stops asking.
         *
         * Shown folded too, like the other two: a press is a person asking.
         * The clock in `App.tsx` still skips folded containers, so nothing is
         * read on a timer for a list nobody can see.
         */}
        {layout.controls.includes('refresh') ? (
          <RefreshButton
            state={refresh}
            every={refreshEvery}
            name={name}
            onRefresh={onRefresh}
            onEvery={onRefreshEvery}
          />
        ) : null}

        {/*
         * Container: what the host offers about the placed module — its scope,
         * tools, prompts. One trigger where three
         * icons stood, on every container, folded too; under 220 pixels the
         * "⋯" (`ROW_PRIORITY`). What each of the three said at a glance, and
         * where that went, is in `FrameMenu`.
         */}
        {/* The module's settings (protocol 2.15.0): a gear, on the host's side of the line beside the
            Container menu, at 220 px and wider, folded or not; under that it is the Container rows' "Settings…".
            One entry or the other, never both (`layoutOf`). */}
        {layout.gear ? (
          <SettingsButton
            name={name}
            onOpen={onSettings!}
            mode={layout.mode}
            hint={(button) => (
              <Hint label={settingsHint(name)} side="bottom">
                {button}
              </Hint>
            )}
          />
        ) : null}

        {/* Help: the app's own "?" menu, scoped to this module — its introduction, how to use it, its
            release notes and feedback to its authors (`HELP_ENTRIES`). After the gear, as the app's
            "?" stands after its gear; folded into the "⋯" as a "Help" section under 220 px. */}
        {helpEntries?.length ? <ContainerHelpMenu parts={frameParts} entries={helpEntries} /> : null}

        {ownOverflow && frameEntries ? (
          <FrameMenu parts={frameParts} entries={frameEntries} which={ownOverflow.which as 'frame' | 'more'} controls={overflowControls} help={overflowHelp} />
        ) : null}
        {/* The Help menu's Feedback dialog: once, wherever the row was drawn from. */}
        <FeedbackDialog feedback={feedback} module={presence.id} name={name} kehikko={kehikko} epic={epic} />

        {/*
         * Fold this container down to its header, or open it again.
         *
         * Shown whatever the condition, like the pin and unlike the height
         * toggle. Folding is a fact about the container rather than a conversation
         * with the program, and a container whose module is not running is exactly
         * one somebody might want out of the way.
         *
         * The tooltip says what happens to the MODULE, because that is the
         * question a person actually has: a control sitting beside a close
         * button has to say, before it is pressed, that nothing is being
         * stopped.
         */}
        <FoldControl
          collapsed={collapsed}
          tiled={tiled}
          makes={collapseMakes}
          foldedBy={foldedBy}
          rows={foldRows === 2 && footerDrawn ? 2 : 1}
          onCollapse={onCollapse}
          onTile={onTile}
        />

        {/*
         * There is no pin button here any more, and the pin itself is still
         * built.
         *
         * It held a container where it was and stopped telling it about the
         * canvas, for two containers on two epics side by side. The owner asked
         * for the control to go: seven icons in a 32px strip is most of what a
         * person sees of this host, and this was the one nobody reached for.
         *
         * What is left standing underneath is deliberate rather than forgotten.
         * `pinned` is a field of the protocol's context, the host still sends
         * it, `whileFrozen` in `host/context.ts` still lets a theme through a
         * frozen container, and a placement can still carry it. So a pin can be
         * set by anything that edits a placement — the host's own MCP door, or
         * a future control — and every module already understands being told it
         * is pinned. Ripping the mechanism out would have been a protocol
         * change and a migration to remove a capability nobody objected to.
         *
         * Verified before removing: no container on any kehikko was pinned, so
         * nothing was left frozen with no way to release it. That was the one
         * thing this could have got wrong — a pinned container whose only
         * unpin button had just been deleted would have been stuck describing a
         * canvas it could no longer follow.
         */}

        {/* Under 220 px it is "Remove from this kehikko", the last Container row of the "⋯" (`layoutOf`). */}
        {layout.remove ? (
        <Hint label="take it off this kehikko — the program keeps running" side="left">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`take ${name} off this kehikko`}
            data-remove-button=""
            /* The container resizes from all four corners, and the top right one
               lies over this button: the handle is a small square at the very
               corner and the button is lifted above it, so a press on the
               button removes the container and a press in the corner beside it
               resizes. Folded, where the header is the whole container, the
               same lift is what keeps the lower half of the button pressable. */
            className="text-muted-foreground hover:text-foreground relative z-10 -mr-1 size-6 cursor-default"
            /* Stops the grid reading the press as the start of a drag, which would
               make this button unpressable. */
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onRemove}
          >
            <X className="size-3" />
          </Button>
        </Hint>
        ) : null}
      </header>
      </div>
  )
}
