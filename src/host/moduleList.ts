/**
 * Asks the bar's module list ("Kehikko modules") to open, for a press elsewhere whose remedy is in
 * it: putting a module on the kehikko (an adoption with no agent module there, `inbox.adoptWith`),
 * or a module's update (the Updates menu's Show, "Update <Module>" anywhere) — then on its Updates
 * filter, at that module when one is named. The list listens (`Bar.tsx`).
 */
export const OPEN_MODULE_LIST = 'kehikot:open-module-list'

/** What the list opens on: every module (the default), or the ones with an update to see, at `module`. */
export interface ModuleListAsk {
  filter?: 'all' | 'updates'
  module?: string | null
}

export function openModuleList(ask: ModuleListAsk = {}): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<ModuleListAsk>(OPEN_MODULE_LIST, { detail: ask }))
}

export function onOpenModuleList(then: (ask: ModuleListAsk) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const heard = (event: Event) => then((event as CustomEvent<ModuleListAsk>).detail ?? {})
  window.addEventListener(OPEN_MODULE_LIST, heard)
  return () => window.removeEventListener(OPEN_MODULE_LIST, heard)
}
