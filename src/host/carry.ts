/**
 * Acts the host carries out ITSELF for a module's run (protocol 2.40.0): `copy` (write the
 * clipboard) and `open` (a web page in the person's browser).
 *
 * A press is relayed to the module's page as a message, and a relayed message carries no user
 * activation: the module's own `navigator.clipboard.write` or `window.open` from `onPress` is
 * refused, by the browser or by the desktop shell, and often without a word. The person's click
 * is in THIS document. So a run that says `copy` or `open` has the act done here, from the click
 * handler, before anything is awaited; then the press is sent as usual, saying what was carried
 * (`carried`), and the module updates its state.
 *
 * ## Text, and https only
 *
 * The schema has already bounded both, and this asks again, because it is this document doing the
 * act: `open` goes through `openExternal`, which opens `https:` and nothing else, and `copy` is
 * written as `text/plain` and `text/html` — strings on the clipboard, never parsed, drawn or opened
 * here.
 */

import { runCopySchema, runOpenRefusal, type RunCarry, type RunCopy } from 'kehikot-module-protocol'

import { openExternal } from './releaseNotes.ts'

/** The acts this host carries out, said in the greeting (`hello.carries`). */
export const CARRIES: readonly RunCarry[] = ['copy', 'open']

/** How the acts are done: the page's clipboard and the shell's way out. Replaced in tests. */
export interface CarryIo {
  /** Write the clipboard. Called synchronously from the click; resolves to whether it was written. */
  copy(copy: RunCopy): Promise<boolean>
  /** Open the page in the person's browser. Called synchronously from the click; whether it was handed over. */
  open(url: string): boolean
}

/** The item fields this reads: any run, header or footer. */
interface Carrying {
  kind: string
  copy?: RunCopy
  open?: string
}

/**
 * Carry out what a run asks of the host, if it asks anything: the act is STARTED before this
 * returns (inside the person's click), and the promise says what was carried — `null` for a run
 * that asks nothing, an address that is not https, or a clipboard that refused.
 */
export function carry(item: Carrying, io: CarryIo = pageIo): Promise<RunCarry | null> {
  if (item.kind !== 'run') return Promise.resolve(null)
  if (item.open !== undefined) {
    if (runOpenRefusal(item.open) !== null) return Promise.resolve(null)
    return Promise.resolve(io.open(item.open) ? 'open' : null)
  }
  if (item.copy !== undefined) {
    const copy = runCopySchema.safeParse(item.copy)
    if (!copy.success) return Promise.resolve(null)
    return io.copy(copy.data).then(
      (written) => (written ? 'copy' : null),
      () => null,
    )
  }
  return Promise.resolve(null)
}

/** The page's own clipboard and `openExternal`. */
export const pageIo: CarryIo = {
  copy({ plain, html }) {
    try {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
      if (!clipboard) return Promise.resolve(false)
      const plainOnly = () => clipboard.writeText(plain).then(() => true, () => false)
      if (html !== undefined && typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
        const both = new ClipboardItem({
          'text/plain': new Blob([plain], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })
        return clipboard.write([both]).then(() => true, plainOnly)
      }
      return plainOnly()
    } catch {
      return Promise.resolve(false)
    }
  },
  open: (url) => openExternal(url),
}
