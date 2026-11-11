/**
 * Showing the control a link into Settings named (`SettingsLink` in
 * `agentSettings.ts`): scrolled into view, focused, and lit for a moment.
 * A control marks itself with `data-settings-target="<id>"` on its row; focus
 * goes to the row itself when it can take it, else to the first control inside.
 */

export const TARGET_ATTR = 'data-settings-target'
/** How long the control stays lit. */
export const LIT_MS = 2200

const FOCUSABLE = 'input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The element a target names, or null while it is not on the page. */
export function targetIn(root: ParentNode, id: string): HTMLElement | null {
  for (const one of root.querySelectorAll<HTMLElement>(`[${TARGET_ATTR}]`)) if (one.getAttribute(TARGET_ATTR) === id) return one
  return null
}

/** Scroll the target into view, focus it, light it. Returns false when it is not there (yet). */
export function revealTarget(root: ParentNode, id: string, lit: (off: () => void) => void = (off) => void setTimeout(off, LIT_MS)): boolean {
  const row = targetIn(root, id)
  if (!row) return false
  row.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  const focus = row.matches(FOCUSABLE) ? row : row.querySelector<HTMLElement>(FOCUSABLE)
  focus?.focus({ preventScroll: true })
  row.setAttribute('data-lit', 'true')
  lit(() => row.removeAttribute('data-lit'))
  return true
}
