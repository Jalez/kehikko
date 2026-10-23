import type { Rect } from '@/canvas/Frames.tsx'
import { layerStyle, type Look } from '@/host/switching.ts'

/**
 * Under the pages, for a switch's hand-over only: a plain panel in the card
 * colour where each page was (`from`) and where each is going (`to`), so the
 * moment between the page being left and the page arriving is a panel and
 * not the canvas seen through a hollow container. `looks` in
 * `host/switching.ts` says when each set shows, and why; outside a switch
 * nothing is drawn here at all.
 *
 * Drawn before the pages' layer, with no `z-index` of its own, so it is
 * painted under them; takes no pointer and is hidden from readers.
 */
export function Underlay({ from, to, look }: { from: readonly Rect[]; to: readonly Rect[]; look: { from: Look; to: Look } }) {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden data-underlay="">
      {[
        ['from', from, look.from] as const,
        ['to', to, look.to] as const,
      ].map(([which, rects, one]) => (
        <div key={which} className="absolute inset-0" style={layerStyle(one)}>
          {rects.map((rect, at) => (
            <div
              key={at}
              className="bg-card absolute top-0 left-0 rounded-b-lg"
              style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.width, height: rect.height }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
