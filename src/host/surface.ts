/**
 * Full screen for a header `run` that says `surface: 'fullscreen'` (protocol
 * 1.4.0, docs/header.md "A run may ask for full screen").
 *
 * A relayed press carries no user activation, so a module's own `onPress`
 * cannot call `requestFullscreen()`; the host can, from the click handler of
 * the item. So the order is: `enterFullscreen(frame)` called synchronously in
 * that handler (nothing awaited before it), THEN the ordinary press, and the
 * host does not wait for the module's answer to either.
 *
 * Full screen is the FRAME's element, not the page's: the host's chrome is
 * hidden by the browser, the module is resized by nothing but the viewport and
 * hears `resize` as ever. Leaving is the browser's (Escape) and sends nothing:
 * the module learns from the size change.
 *
 * Nothing here can make a press fail. A webview that refuses element full
 * screen, a missing API and a rejected request all answer `false`, and the
 * caller sends the press as an ordinary run — the module still does what it
 * can without full screen.
 */

type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void }
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => void }

/** What is in full screen now, under either spelling. */
export function fullscreenElement(doc: Document = document): Element | null {
  const d = doc as FullscreenDocument
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null
}

/**
 * Ask for full screen on `frame`. Resolves whether it was granted. Call it
 * synchronously from the click handler: the request is made before this
 * function returns, and only the answer is awaited.
 */
export function enterFullscreen(frame: HTMLElement, doc: Document = document): Promise<boolean> {
  const element = frame as FullscreenElement
  try {
    if (doc.fullscreenEnabled === false) return Promise.resolve(false)
    if (typeof element.requestFullscreen === 'function') {
      return Promise.resolve(element.requestFullscreen()).then(
        () => true,
        () => false,
      )
    }
    if (typeof element.webkitRequestFullscreen === 'function') {
      element.webkitRequestFullscreen()
      return Promise.resolve(true)
    }
  } catch {
    /* Refused synchronously: the press goes without it. */
  }
  return Promise.resolve(false)
}

/** Leave full screen, but only when it is this frame that has it: a press refused must not end somebody else's. */
export function leaveFullscreen(frame: HTMLElement, doc: Document = document): void {
  if (fullscreenElement(doc) !== frame) return
  const d = doc as FullscreenDocument
  try {
    if (typeof d.exitFullscreen === 'function') void d.exitFullscreen().catch(() => {})
    else d.webkitExitFullscreen?.()
  } catch {
    /* Already gone. */
  }
}

/**
 * Call `then` once, when full screen has ended. Returns a cancel. Asked
 * after a grant, so the first change it sees is the exit.
 */
export function whenLeft(then: () => void, doc: Document = document): () => void {
  const check = () => {
    if (fullscreenElement(doc) !== null) return
    cancel()
    then()
  }
  const cancel = () => {
    doc.removeEventListener('fullscreenchange', check)
    doc.removeEventListener('webkitfullscreenchange', check)
  }
  doc.addEventListener('fullscreenchange', check)
  doc.addEventListener('webkitfullscreenchange', check)
  return cancel
}
