import { veilOf } from '@/host/containerView.ts'
import { standingOf, type Standing } from '@/host/coverFit.ts'
import type { FooterSource } from '@/host/footerStore.ts'
import { ONE_EPIC_AT_A_TIME } from '@/host/scope.ts'
import type { noticeOf } from '@/host/standing.ts'
import { OWN_TILE_BOX } from '@/host/tile.ts'
import type { ContainerProps } from './Container.tsx'
import { FindBar } from './FindBar.tsx'
import { SourcedFooterBar } from './FooterBar.tsx'
import { StandingBox } from './Standing.tsx'
import { TileFace } from './Tile.tsx'

/**
 * Everything of a container (`Container.tsx`) below its header: the footer of a fold to two rows, a
 * tile's square, or the hollow body the module's page is positioned over — with whatever stands in
 * for the page, the find bar, the footer row and the fault line.
 */
export type ContainerBodyProps = Pick<
  ContainerProps,
  'presence' | 'showing' | 'body' | 'coverDetail' | 'fault' | 'collapsed' | 'onKeyboard' | 'onStarted' | 'onRestart' | 'onReload' | 'expand'
> &
  Required<Pick<ContainerProps, 'loading' | 'tiled' | 'onFooterPress' | 'oneEpic' | 'activity' | 'find'>> & {
    name: string
    /** The header's width, for the find bar. */
    width: number | null
    /** How the fold is drawn: 2 is the header and the footer (`host/rows.ts`). */
    fold: 0 | 1 | 2
    /** The rows are revealed in focus mode (`host/reveal.ts`). */
    revealed: boolean
    /** Where the module's footer is read from. */
    source: FooterSource
    /** The open body draws the footer row. */
    footed: boolean
    /** A tile shows the module's own tile (`host/tile.ts`). */
    ownTile: boolean
    /** The cover or notice in every size's words; null while the page shows. */
    standing: Standing | null
    notice: ReturnType<typeof noticeOf> | null
    /** Whether "Restart module" may be pressed here, and why not. */
    can: { ok: true } | { ok: false; why: string }
  }

export function ContainerBody({
  presence,
  showing,
  name,
  body,
  loading,
  coverDetail,
  fault,
  collapsed,
  tiled,
  fold,
  revealed,
  source,
  footed,
  ownTile,
  standing,
  notice,
  can,
  oneEpic,
  activity,
  find,
  width,
  expand,
  onFooterPress,
  onKeyboard,
  onStarted,
  onRestart,
  onReload,
}: ContainerBodyProps) {
  /* A page loading what a new context asks for, late: the same cover over its place (2.84.0). */
  const veil = veilOf(showing, loading)
  const veiled = veil ? standingOf(veil, null, presence.at, undefined, name) : null
  /* What stands in for a page that is not showing, in a tile or the open body alike (see below). */
  const standingBox =
    showing.kind !== 'page' && standing ? (
      <StandingBox
        showing={showing}
        notice={notice}
        standing={standing}
        presence={presence}
        name={name}
        coverDetail={coverDetail}
        onStarted={onStarted}
        onRestart={can.ok ? onRestart : undefined}
        restartWhy={can.ok ? null : can.why}
        onReload={onReload}
      />
    ) : null
  return (
    <>
      {/*
        Everything below the header, and it is absent entirely when folded.

        Not merely empty: a zero-height body would still be measured, and the
        module's page would be positioned over a one-pixel rectangle and told it
        had been resized to nothing. The page is hidden in the frames layer
        instead — the same path a page on another kehikko takes — so the
        document is untouched and comes back exactly as it was.
      */}
      {/* Folded to two rows: the footer under the header, each half of the folded container, and
          still live — the page is hidden, the footer's presses still reach it (`host/rows.ts`). */}
      {fold === 2 ? (
        <div className="container-footer-reveal min-h-0 flex-1" data-collapsed="true" data-revealed={revealed ? 'true' : undefined}>
          {/* No `onKeyboard`: the page is hidden, so the keyboard stays where the press was made. */}
          <SourcedFooterBar source={source} name={name} onPress={onFooterPress} dense />
        </div>
      ) : null}
      {tiled && !collapsed ? (
        /* A tile: the module's own, its page in a box small enough that it draws it, or the host's
           square — which shows the container large on a press (`host/expand.ts`). A module that is
           not showing its page says why, as an open container would. */
        ownTile ? (
          <div className="relative flex min-h-0 flex-1 items-center justify-center" data-tile-own={presence.id}>
            <div ref={body} data-body={presence.id} className="relative" style={{ width: '100%', height: '100%', maxWidth: OWN_TILE_BOX.width, maxHeight: OWN_TILE_BOX.height }} />
          </div>
        ) : (
          <div ref={body} data-body={presence.id} className="relative min-h-0 flex-1">
            {standingBox ?? (
              <TileFace
                id={presence.id}
                name={name}
                footer={source}
                activity={activity}
                onExpand={expand && showing.kind === 'page' && !oneEpic ? () => expand.onChange(true) : undefined}
              />
            )}
          </div>
        )
      ) : null}
      {collapsed || tiled ? null : (
      <>
      {/* The hollow part. Its only jobs are to be measured — the page is
          positioned to match it — and to stay out of the way of what is
          showing through it. A notice, when there is one, is opaque and takes
          the pointer again; there is no page behind it worth seeing. */}
      <div ref={body} data-body={presence.id} className="relative min-h-0 flex-1">
        {/* Not ready yet, and on its way, or not ready and nothing on its way: one cover or one
            notice, drawn for the room this body has (`Standing.tsx`, `host/coverFit.ts`). */}
        {standingBox}
        {veil && veiled ? (
          <div data-testid="loading-cover" className="contents">
            <StandingBox showing={veil} notice={null} standing={veiled} presence={presence} name={name} onStarted={onStarted} />
          </div>
        ) : null}

        {/* The find bar, over the top of the page (protocol 2.69.0): only while the page is showing. */}
        {showing.kind === 'page' && find?.bar.open ? (
          <FindBar
            bar={find.bar}
            name={name}
            width={width}
            mac={find.mac}
            onQuery={find.onQuery}
            onCase={find.onCase}
            onStep={find.onStep}
            onClose={find.onClose}
          />
        ) : null}

        {/* "All epics", and a module that cannot show them: one quiet sentence
            in place of a page that would be blank or on the last epic. Opaque
            and taking the pointer, like a notice; the page is hidden beneath
            it, not unloaded. See `host/scope.ts`. */}
        {showing.kind === 'page' && oneEpic ? (
          <div className="bg-card pointer-events-auto absolute inset-0 flex items-center justify-center p-4">
            <p className="text-muted-foreground max-w-64 text-center text-xs text-balance">{ONE_EPIC_AT_A_TIME}</p>
          </div>
        ) : null}

      </div>

      {/* A fault is not a condition. The module is working; it did one thing the
          host could not make sense of, and a line under the container is the right
          size for that — visible to whoever is looking at this module, invisible
          from across the canvas. */}
      {/* The module's declared footer (protocol 2.38.0): one row at the
          bottom, in the header's look, only when the module declared one and
          its page is showing. In focus mode it hides and reveals with the
          header, from the same wrapper rules (`index.css`). */}
      {footed ? (
        <div className="container-footer-reveal shrink-0" data-revealed={revealed ? 'true' : undefined}>
          <SourcedFooterBar source={source} name={name} onPress={onFooterPress} onKeyboard={onKeyboard} />
        </div>
      ) : null}

      {fault ? (
        <p
          className="text-muted-foreground bg-card pointer-events-auto shrink-0 truncate border-t px-2.5 py-1 text-[11px]"
          title={fault}
        >
          {fault}
        </p>
      ) : null}
      </>
      )}
    </>
  )
}
