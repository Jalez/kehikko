import type { CSSProperties } from 'react'
import type { IntroArt, IntroMotion, IntroShape, IntroTone } from 'kehikot-module-protocol'

import { Art } from './Intro.tsx'

/**
 * A module's picture for its introduction (protocol 2.57.0), drawn by the host.
 *
 * The module says it as shapes on the same 320 by 150 canvas the app's own pictures use (`Art`), with
 * colour ROLES and motions from the host's own set — so this draws them with the host's classes:
 * the theme's colours, right in dark as in light, and the `.intro-art` motions in `index.css`, which
 * stand still under `prefers-reduced-motion` and in the dialog's `data-motion="still"`.
 *
 * Nothing the module said is markup: every string is a React text child or an attribute value, and
 * nothing is loaded from anywhere.
 */

/** A tone as a fill (and stroke) class; written out whole so the stylesheet keeps every one. */
const FILL: Record<IntroTone, string> = {
  card: 'fill-card stroke-border',
  muted: 'fill-muted-foreground/35',
  faint: 'fill-muted-foreground/15',
  text: 'fill-foreground/60',
  strong: 'fill-primary/15 stroke-primary',
  ok: 'fill-emerald-500',
  busy: 'fill-sky-500',
  warn: 'fill-amber-500',
  danger: 'fill-red-500',
}

/** A tone as a line's stroke. */
const STROKE: Record<IntroTone, string> = {
  card: 'stroke-border',
  muted: 'stroke-muted-foreground/50',
  faint: 'stroke-muted-foreground/25',
  text: 'stroke-foreground/60',
  strong: 'stroke-primary',
  ok: 'stroke-emerald-500',
  busy: 'stroke-sky-500',
  warn: 'stroke-amber-500',
  danger: 'stroke-red-500',
}

/** A tone for a dot or a word, where a pale fill would vanish. */
const SOLID: Record<IntroTone, string> = {
  card: 'fill-card',
  muted: 'fill-muted-foreground',
  faint: 'fill-muted-foreground/50',
  text: 'fill-foreground',
  strong: 'fill-primary',
  ok: 'fill-emerald-500',
  busy: 'fill-sky-500',
  warn: 'fill-amber-500',
  danger: 'fill-red-500',
}

/** The host's motion classes; `spin` turns about the centre (`ia-turn`). */
const MOTION: Record<IntroMotion, string> = {
  pop: 'ia-pop',
  rise: 'ia-rise',
  draw: 'ia-draw',
  drop: 'ia-drop',
  pulse: 'ia-pulse',
  blink: 'ia-blink',
  ping: 'ia-ping',
  narrow: 'ia-narrow',
  chip: 'ia-chip',
  fill: 'ia-fill',
  spin: 'ia-turn',
}

function moved(shape: IntroShape): { className: string; style?: CSSProperties } {
  return {
    className: shape.motion ? MOTION[shape.motion] : '',
    ...(shape.delay ? { style: { animationDelay: `${shape.delay}s` } } : {}),
  }
}

function Shape({ shape }: { shape: IntroShape }) {
  const motion = moved(shape)
  const draw = shape.motion === 'draw'
  switch (shape.kind) {
    case 'pane':
      return (
        <g className={draw ? '' : motion.className} style={motion.style} data-shape="pane">
          <rect
            x={shape.x}
            y={shape.y}
            width={shape.w}
            height={shape.h}
            rx="4"
            className={`${FILL[shape.tone ?? 'card']}${draw ? ' ia-draw' : ''}`}
            strokeWidth="1.25"
            {...(draw ? { pathLength: 1000, style: motion.style } : {})}
          />
          <rect x={shape.x} y={shape.y} width={shape.w} height="7" rx="3.5" className={shape.tone === 'strong' ? 'fill-primary/30' : 'fill-muted-foreground/25'} />
        </g>
      )
    case 'box':
      return (
        <rect
          data-shape="box"
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          rx={shape.round ?? 4}
          className={`${FILL[shape.tone ?? 'card']} ${motion.className}`}
          strokeWidth="1.25"
          strokeDasharray={shape.dashed ? '3 2' : undefined}
          style={motion.style}
          {...(draw ? { pathLength: 1000 } : {})}
        />
      )
    case 'rows': {
      const gap = shape.gap ?? 9
      return (
        <g className={motion.className} style={motion.style} data-shape="rows">
          {shape.widths.map((w, i) => (
            <rect key={i} x={shape.x} y={shape.y + i * gap} width={w} height="4" rx="2" className={FILL[shape.tone ?? 'muted']} />
          ))}
        </g>
      )
    }
    case 'dot':
      return <circle data-shape="dot" cx={shape.x} cy={shape.y} r={shape.r} className={`${SOLID[shape.tone ?? 'strong']} ${motion.className}`} style={motion.style} />
    case 'line':
      return (
        <line
          data-shape="line"
          x1={shape.x}
          y1={shape.y}
          x2={shape.x2}
          y2={shape.y2}
          className={`${STROKE[shape.tone ?? 'muted']} ${motion.className}`}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={shape.dashed ? '4 3' : undefined}
          style={motion.style}
          {...(draw ? { pathLength: 1000 } : {})}
        />
      )
    case 'text':
      return (
        <text
          data-shape="text"
          x={shape.x}
          y={shape.y}
          fontSize={shape.size ?? 9}
          textAnchor={shape.middle ? 'middle' : undefined}
          className={`${SOLID[shape.tone ?? 'text']} ${shape.mono ? 'font-mono' : ''} ${motion.className}`}
          style={motion.style}
        >
          {shape.text}
        </text>
      )
    case 'pointer':
      return (
        <g transform={`translate(${shape.x} ${shape.y})`} data-shape="pointer">
          <path
            d="M0 0 L0 13 L3.6 9.6 L6.2 15 L8.4 14 L5.9 8.7 L10.6 8.4 Z"
            className={`fill-foreground stroke-background ${motion.className}`}
            strokeWidth="1"
            strokeLinejoin="round"
            style={motion.style}
          />
        </g>
      )
  }
}

export function ModuleArt({ art }: { art: IntroArt }) {
  return (
    <Art label={art.label}>
      {art.shapes.map((shape, at) => (
        <Shape key={at} shape={shape} />
      ))}
    </Art>
  )
}
