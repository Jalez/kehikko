import { forwardRef, type HTMLAttributes, type ReactElement, type Ref } from 'react'

/**
 * The resize handle for one corner of a container.
 *
 * A small square at the very corner, so that it takes the least from the
 * header it overlaps at the top: the header's own controls sit above it
 * (`Container.tsx`) and the rest of the header keeps dragging the container.
 * It has no drawing of its own. The corner is shown by tinting the rounded
 * arc of the container itself, which `index.css` does from `data-corner`.
 *
 * The grid hands the element a ref and the pointer handlers through
 * `cloneElement`, so both must reach the DOM node: hence `forwardRef` and the
 * spread. A press with a finger or a pen arrives as touch or compatibility
 * mouse events, which the grid's drag core already handles; `touch-action`
 * in the stylesheet keeps the page from scrolling under it.
 */
export const CornerHandle = forwardRef<HTMLSpanElement, { corner: string; handleAxis?: string } & HTMLAttributes<HTMLSpanElement>>(function CornerHandle({ corner, handleAxis: _axis, ...rest }, ref) {
  return <span ref={ref} data-corner={corner} className={`react-resizable-handle react-resizable-handle-${corner} corner-handle`} {...rest} />
})

/** `resizeHandle` for the grid: the same element for every corner. */
export function cornerHandle(corner: string, ref: Ref<HTMLElement>): ReactElement {
  return <CornerHandle corner={corner} ref={ref as Ref<HTMLSpanElement>} />
}
