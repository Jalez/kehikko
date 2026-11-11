import type { CanvasControls } from './ask.ts'

/**
 * The canvas's controls as one frame's conversation reaches them: read through a ref at the moment
 * of each call, so a re-render that made new controls does not tear the conversation down.
 *
 * ## Why every control, and not a list of them
 *
 * The frame used to hand `makeAsk` an object that named each control and forwarded it. A control
 * the canvas grew later and nobody added to that list was simply absent in the frame — and
 * `makeAsk` answers an absent control with its "not here" outcome. That is how a module's
 * `view.expand` (protocol 2.58.0) was answered "This canvas shows nothing large." although the
 * canvas shows a container large: the canvas had `expand`, the frame's list did not. `walkStep`
 * and `withhold` were missing the same way.
 *
 * So the frame forwards whatever the canvas has, by name, at the moment it is asked: a control
 * the canvas has is a control the frame has, and one it does not have is still absent. `own` is
 * what only the frame knows (the kehikko it was told it is on, where it stands) and wins over the
 * canvas's.
 */
export function forwarded(ref: { readonly current: CanvasControls }, own: Partial<CanvasControls> = {}): CanvasControls {
  return new Proxy({} as CanvasControls, {
    get(_target, key) {
      if (typeof key !== 'string') return undefined
      if (Object.prototype.hasOwnProperty.call(own, key)) return (own as Record<string, unknown>)[key]
      const canvas = ref.current as unknown as Record<string, unknown>
      const value = canvas[key]
      if (typeof value !== 'function') return value
      /* The canvas as it is when the call is made, not when the control was read. */
      return (...args: unknown[]) => {
        const now = (ref.current as unknown as Record<string, unknown>)[key]
        return typeof now === 'function' ? (now as (...a: unknown[]) => unknown).apply(ref.current, args) : undefined
      }
    },
    has(_target, key) {
      return typeof key === 'string' && (Object.prototype.hasOwnProperty.call(own, key) || key in (ref.current as object))
    },
  })
}
