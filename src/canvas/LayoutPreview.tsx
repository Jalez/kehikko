import { COLUMNS } from '@/host/canvases.ts'
import { CANVAS_ROWS } from '@/host/fit.ts'
import type { Available, LayoutContainer } from '@/host/layouts.ts'
import { KehikkoMark } from './Mark.tsx'
import { ModuleIcon } from './ModuleIcon.tsx'

function shortName(module: string, available: readonly Available[]): string {
  return available.find((one) => one.module === module)?.name ?? module.replace(/^kehikot\./, '')
}

/**
 * The rectangles of a layout as a picture, drawn with the theme's own colours. Each rectangle says
 * which module is there — its icon and its name, in the 11px the card's text is — so the picture is
 * the whole answer to "what is on it". An empty layout shows Kehikot's own mark.
 *
 * HTML rather than SVG: the picture stretches to its card, and stretched text is distorted text.
 * Positions are fractions of the canvas, so the rectangles keep their proportions at any width.
 */
export function LayoutPreview({
  containers,
  available,
  className = 'h-48 w-full',
}: {
  containers: readonly LayoutContainer[]
  available?: readonly Available[]
  className?: string
}) {
  const state = new Map(available?.map((one) => [one.module, one]) ?? [])
  const rows = Math.max(CANVAS_ROWS, ...containers.map((c) => c.y + c.h))
  return (
    <div
      className={`bg-muted/40 relative overflow-hidden rounded-md ${className}`}
      role="img"
      aria-label={containers.length ? `${containers.length} containers` : 'an empty kehikko'}
      data-layout-preview=""
    >
      {containers.length === 0 ? (
        <span className="text-muted-foreground absolute inset-0 flex items-center justify-center">
          <KehikkoMark working={false} className="size-16" />
        </span>
      ) : null}
      {containers.map((c) => {
        const one = state.get(c.module)
        const absent = one && one.state !== 'here'
        const name = shortName(c.module, available ?? [])
        return (
          <div
            key={c.module}
            className="absolute p-0.5"
            style={{ left: `${(c.x / COLUMNS) * 100}%`, top: `${(c.y / rows) * 100}%`, width: `${(c.w / COLUMNS) * 100}%`, height: `${(c.h / rows) * 100}%` }}
            title={name}
            data-preview-module={c.module}
            data-preview-state={one?.state}
          >
            <div
              className={
                'flex size-full min-w-0 flex-col items-center justify-center gap-0.5 overflow-hidden rounded-[5px] border p-0.5 text-center text-[10px] leading-tight ' +
                (absent ? 'bg-background border-muted-foreground/60 border-dashed' : 'bg-card border-border')
              }
            >
              <ModuleIcon id={c.module} name={name} className="size-4 shrink-0" />
              <span className="max-w-full min-w-0 truncate">{name}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
