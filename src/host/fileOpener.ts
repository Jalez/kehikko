import { canOpen } from 'kehikot-module-protocol'

/**
 * Which module "Open the file" in a module's settings opens a file with (protocol 2.33.0): one whose
 * manifest says `opens: ['file']` — it shows a file the host points the canvas at. The host names no
 * module: whichever says it.
 *
 * One on the open kehikko first (`placed`), in the kehikko's order; otherwise an installed one that
 * answers, which the press places on the kehikko before pointing. Null when nothing here opens
 * files: the form shows the file in a dialog of its own. Pure.
 */
export function fileOpenerFor(
  placed: readonly string[],
  presences: readonly { id: string; condition?: string; module?: { opens?: readonly string[] } | null }[],
): { id: string; placed: boolean } | null {
  const opens = new Set(presences.filter((one) => canOpen(one.module, 'file')).map((one) => one.id))
  const here = placed.find((id) => opens.has(id))
  if (here) return { id: here, placed: true }
  const installed = presences.find((one) => opens.has(one.id) && one.condition === 'ready')
  return installed ? { id: installed.id, placed: false } : null
}
