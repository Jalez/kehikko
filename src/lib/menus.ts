import { useEffect } from 'react'

/**
 * What closes a menu when the pointer goes into a module's page.
 *
 * A menu closes on Escape and on a press outside it. A press INSIDE A
 * MODULE'S PAGE is neither, as far as this document can tell: the page is
 * another document in a frame, and a pointer that goes down in one raises no
 * event here at all. What this document does get is `blur` on its window,
 * with the frame left as the active element. So that closes the menu too:
 * somebody who clicked into the module is done with the menu over it.
 *
 * One hook, in the menu and popover wrappers in `components/ui/`, so every
 * dropdown in the app closes the same way — the header's own lists and a
 * container's menus alike — rather than each menu hearing the blur itself.
 */

/** Whether the keyboard has left this document for a module's page: the active element is the frame that holds it. The same fact `focusIsInModule` in `host/header.ts` answers for the header's rules. */
export function focusIsInFrame(doc: Document): boolean {
  return doc.activeElement?.tagName === 'IFRAME'
}

/**
 * Whether a `blur` event is the window losing focus to a module's page.
 *
 * Listened in the capture phase, where an element's own blur passes too —
 * only the window's own counts, and the window is not a node while an element
 * has a tagName. (Compared by shape rather than to `doc.defaultView`, which
 * not every DOM implementation hands back as the dispatched event's target.)
 * And the window being deactivated some other way (another app taking it) is
 * not a click into a module: the active element is then whatever it was, not
 * a frame.
 */
export function blurWentToFrame(event: Event, doc: Document): boolean {
  const target = event.target
  if (typeof Node !== 'undefined' && target instanceof Node) return false
  if (target !== null && typeof target === 'object' && 'tagName' in target) return false
  return focusIsInFrame(doc)
}

/**
 * Calls `close` while `open` when the window loses focus to a module's page.
 *
 * The menu hands focus back to its trigger as it closes, which is wrong here:
 * the keyboard is in the page just clicked, and is not pulled back out of it.
 * The content wrappers prevent that return the same way (`focusIsInFrame` at
 * `onCloseAutoFocus`), as `focusAfter` in `host/header.ts` rules for the
 * header's menus.
 */
export function useCloseOnFrameBlur(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const onBlur = (event: Event) => {
      if (blurWentToFrame(event, document)) close()
    }
    window.addEventListener('blur', onBlur, true)
    return () => window.removeEventListener('blur', onBlur, true)
  }, [open, close])
}
