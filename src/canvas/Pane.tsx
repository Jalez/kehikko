import { X } from 'lucide-react'

import { Button } from '@/components/ui/button.tsx'
import type { Presence } from '@/host/registry.ts'
import { ConditionDot, ConditionPanel, ConnectingPanel } from './Conditions.tsx'
import { Hint } from './Hint.tsx'

/**
 * One thing on the canvas — or rather, the frame around one thing.
 *
 * A hairline border, a header thin enough to be a grip rather than a title bar,
 * and then a body that is either empty or filled with the sentence explaining
 * why there is nothing in it. The header is the drag handle and the body is
 * not: a pane whose body dragged would be a pane a person cannot click inside,
 * and clicking inside is the entire point of the thing.
 *
 * ## The module's page is not in here
 *
 * The body is hollow, and its only job is to be somewhere the canvas can
 * measure. The page itself is positioned over it from a layer that outlives
 * every pane — see the essay in `Frames.tsx` for why a module's document has to
 * be created once and never moved, and why switching canvases would otherwise
 * reload everything on both of them.
 *
 * That split is why this component takes no context, no controls and no
 * watcher any more. It draws a box and a sentence. Everything that talks to a
 * module happens somewhere else.
 *
 * ## Why a notice can sit over a page that is still loading
 *
 * When a module's manifest answered but its page has not spoken yet, the pane
 * shows a panel and the page keeps loading behind it. Unmounting would destroy
 * a document that is, as far as anyone knows, still on its way, and would make
 * "did not answer in four seconds" a death sentence rather than an observation.
 * A module that answers late simply clears the panel and appears, which is what
 * a person expects of something that was merely slow.
 */
export function Pane({
  presence,
  condition,
  line,
  fault,
  settled,
  body,
  onRemove,
}: {
  presence: Presence
  /** The condition as the canvas currently understands it — see `App.tsx`. */
  condition: Presence['condition']
  line: string
  fault: string | null
  /**
   * Has the conversation reached a resting point?
   *
   * False from the moment the frame is mounted until the module answers the
   * greeting or the greeting times out. Discovery has already said `ready` by
   * then — it read the manifest — so `condition` alone cannot tell a page that
   * is still arriving from one that has arrived and is showing nothing.
   */
  settled: boolean
  /** Where the module's page goes. Handed to the canvas so it can be measured. */
  body: (element: HTMLElement | null) => void
  onRemove(): void
}) {
  const name = presence.name ?? presence.id

  return (
    <div className="bg-card flex h-full flex-col overflow-hidden rounded-lg border">
      <header className="pane-grip flex h-8 shrink-0 cursor-move items-center gap-2 border-b px-2.5 select-none">
        <ConditionDot condition={condition} />
        <span className="truncate text-xs font-medium">{name}</span>
        {presence.module?.version ? (
          <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
            {presence.module.version}
          </span>
        ) : null}
        <span className="flex-1" />
        <Hint label="take it off this canvas — the program keeps running" side="left">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`take ${name} off the canvas`}
            className="text-muted-foreground hover:text-foreground -mr-1 size-6 cursor-default"
            /* Stops the grid reading the press as the start of a drag, which would
               make this button unpressable. */
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onRemove}
          >
            <X className="size-3" />
          </Button>
        </Hint>
      </header>

      <div ref={body} className="relative min-h-0 flex-1">
        {condition === 'ready' && !settled ? <ConnectingPanel at={presence.at} /> : null}

        {condition === 'ready' ? null : (
          <ConditionPanel
            condition={condition}
            line={line}
            at={presence.at}
            protocols={presence.protocols}
          />
        )}
      </div>

      {/* A fault is not a condition. The module is working; it did one thing the
          host could not make sense of, and a line under the pane is the right
          size for that — visible to whoever is looking at this module, invisible
          from across the canvas. */}
      {fault ? (
        <p
          className="text-muted-foreground shrink-0 truncate border-t px-2.5 py-1 text-[11px]"
          title={fault}
        >
          {fault}
        </p>
      ) : null}
    </div>
  )
}
