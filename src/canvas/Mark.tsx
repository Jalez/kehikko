/**
 * The kehikko mark: a wireframe cube — `kehikko` is Finnish for a frame.
 *
 * While `working`, it draws itself line by line and then breathes, as it does
 * in the desktop app's waiting room; otherwise it is the finished frame, still.
 * Key it on the job to restart the drawing for a new one. `currentColor`
 * throughout, so it is right in light and dark. The styles are in `index.css`.
 */
export function KehikkoMark({ working, className }: { working: boolean; className?: string }) {
  return (
    <svg className={`kehikko-mark ${className ?? ''}`} data-working={working} viewBox="0 0 108 108" aria-hidden="true">
      <g className="built">
        <line className="seed" x1="26" y1="82" x2="82" y2="82" />
        <path className="front" d="M26 82 L26 26 L82 26 L82 82" />
        <path className="back" d="M46 62 L46 6 L102 6 L102 62 L46 62" />
        <line className="strut s1" x1="26" y1="26" x2="46" y2="6" />
        <line className="strut s2" x1="82" y1="26" x2="102" y2="6" />
        <line className="strut s3" x1="82" y1="82" x2="102" y2="62" />
        <line className="strut s4" x1="26" y1="82" x2="46" y2="62" />
      </g>
    </svg>
  )
}
