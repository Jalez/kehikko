/**
 * Waiting on the page's windows: for an element to appear, and for every dialog to
 * close. Used by the tour (`canvas/Onboarding.tsx`) and a kehikko's settings
 * (`canvas/KehikkoSettings.tsx`).
 */

/** Call `then` once an element matching `selector` is in the page, or after `wait` ms whatever happens. */
export function whenAppeared(selector: string, then: () => void, wait = 3000, root: Document = document): () => void {
  let done = false
  const finish = () => {
    if (done) return
    done = true
    watch.disconnect()
    clearTimeout(timer)
    then()
  }
  const watch = new MutationObserver(() => root.querySelector(selector) && finish())
  const timer = setTimeout(finish, wait)
  if (root.querySelector(selector)) {
    queueMicrotask(finish)
  } else watch.observe(root.body, { childList: true, subtree: true })
  return () => {
    done = true
    watch.disconnect()
    clearTimeout(timer)
  }
}

/**
 * Call `then` once no dialog is open — at once when none is, else once the
 * last one has closed (and its closing animation has had a moment). Returns
 * the cancel.
 */
export function whenNoDialog(then: () => void, root: Document = document): () => void {
  /* The tour's popover is a dialog to driver.js and not a window to wait for. */
  const open = () => root.querySelector('[role="dialog"]:not(.driver-popover), [role="alertdialog"]') !== null
  if (!open()) {
    then()
    return () => {}
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const watch = new MutationObserver(() => {
    clearTimeout(timer)
    if (open()) return
    timer = setTimeout(() => {
      if (open()) return
      watch.disconnect()
      then()
    }, 250)
  })
  watch.observe(root.body, { childList: true, subtree: true })
  return () => {
    clearTimeout(timer)
    watch.disconnect()
  }
}
