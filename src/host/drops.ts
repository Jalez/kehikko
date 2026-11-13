import type { FileDrag, PagePoint } from 'kehikot-module-protocol'

/**
 * A file dragged out of one module's page and let go over another's (protocol 2.94.0).
 *
 * WebKit dispatches no drag event to a document of another origin than the one the drag began in,
 * and every module's page is its own origin: a drop on another module's frame is never heard there,
 * nor by this page. The dragging page tells the host instead (`kehikot.drag`: where it was let go,
 * in its own coordinates, and whether anything took it), and this hands a drop nothing took to the
 * frame under that point, when its module opens files (`opens: ['file']`), as `kehikot.drop`.
 *
 * The host names no module: whichever frame is under the pointer and says it opens files. The file
 * is the dragging page's claim and is passed on as it was parsed; the receiving module confines it.
 *
 * Pure: the frames' boxes and "what is under this point" are handed in.
 */

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** One framed page a drop may reach. */
export interface DropFrame {
  id: string
  /** The frame element, compared with what is under the point. */
  element: unknown
  box(): Box | null
  /** Whether its module says `opens: ['file']`. */
  opensFiles: boolean
  drop(file: FileDrag, at: PagePoint): void
}

/** What a dragging page said at the end of its drag. */
export interface DragEnd {
  phase: 'start' | 'end'
  file: FileDrag
  at?: PagePoint
  dropped: boolean
}

/**
 * Hand a drop on. Returns the id of the frame it was handed to, or null: not an end, taken already,
 * no point, the source's frame is gone, nothing is under the point, the frame there is the source's
 * own, or its module does not open files.
 */
export function handOnDrop(
  sourceId: string,
  drag: DragEnd,
  frames: readonly DropFrame[],
  under: (x: number, y: number) => unknown,
): string | null {
  if (drag.phase !== 'end' || drag.dropped || !drag.at) return null
  const source = frames.find((one) => one.id === sourceId)
  const from = source?.box()
  if (!source || !from) return null
  const x = from.left + drag.at.x
  const y = from.top + drag.at.y
  const element = under(x, y)
  if (element === null || element === undefined) return null
  const target = frames.find((one) => one.element === element)
  if (!target || target.id === sourceId || !target.opensFiles) return null
  const to = target.box()
  if (!to) return null
  const at = { x: x - to.left, y: y - to.top }
  if (at.x < 0 || at.y < 0 || at.x > to.width || at.y > to.height) return null
  target.drop(drag.file, at)
  return target.id
}
