/**
 * Asks the bar's module list ("Kehikko modules") to open, for a press elsewhere whose remedy is
 * putting a module on the kehikko — an adoption with no agent module there (`inbox.adoptWith`). The
 * list listens (`Bar.tsx`).
 */
export const OPEN_MODULE_LIST = 'kehikot:open-module-list'

export function openModuleList(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_MODULE_LIST))
}

export function onOpenModuleList(then: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(OPEN_MODULE_LIST, then)
  return () => window.removeEventListener(OPEN_MODULE_LIST, then)
}
