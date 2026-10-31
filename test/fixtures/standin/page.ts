/**
 * The stand-in's page script (`server.ts` bundles it): greet the host, say
 * which epic it was told, count presses of the button, and keep one header
 * toggle whose state the driver reads off `body[data-flag]`.
 */
import { applyTheme, connect, keepInView } from 'kehikot-module-protocol/client'

const { id, origins, jump, activity, footer, over } = (window as unknown as { __standin: { id: string; origins: string[]; jump: Record<string, unknown> | null; activity: unknown[] | null; footer: unknown[] | null; over?: boolean } }).__standin

/* A terminal-like page (`reveal: 'over'`): what a pty would be told is every size this page sees, so
   it counts them — a `ResizeObserver` on its screen and the window's `resize` — for a driver to read
   off `window.__standinResizes`. The first observation is the page's own first layout, not a resize. */
const probe = window as unknown as { __standinResizes: number; __standinCovered: { top: number; bottom: number }[] }
probe.__standinResizes = 0
probe.__standinCovered = []
if (over) {
  const screen = document.getElementById('screen')!
  let first = true
  new ResizeObserver(() => {
    if (first) first = false
    else probe.__standinResizes += 1
  }).observe(screen)
  window.addEventListener('resize', () => void (probe.__standinResizes += 1))
}
/* What the host's rows cover: the last line moves out from under them, with a transform, never a resize. */
const keepLast = (covered: { top: number; bottom: number }) => {
  probe.__standinCovered.push(covered)
  const lines = document.getElementById('lines')
  const last = document.getElementById('last')
  if (!lines || !last) return
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  lines.style.transition = reduce ? 'none' : 'transform 140ms ease'
  const shift = keepInView(covered, window.innerHeight, last.getBoundingClientRect().bottom - (new DOMMatrix(getComputedStyle(lines).transform).m42 || 0))
  lines.style.transform = shift ? `translateY(${shift}px)` : ''
}
let flag = false
let presses = 0

document.getElementById('press')!.addEventListener('click', () => {
  presses += 1
  document.getElementById('pressed')!.textContent = String(presses)
})

/* What it was told, drawn large: the frames of a switch show which epic a page is on. */
const told = (context: { epic?: string | null; scope?: string; theme?: 'light' | 'dark'; show?: { subject: string; id: string; at?: string } | null }) => {
  /* What it was asked to show (protocol 2.28.0), for a driver to read: only a module that says `shows` is told. */
  if (context.show) document.body.dataset.shown = `${context.show.subject}:${context.show.id}`
  /* In the host's theme, as a real module is: a switch is judged on what a person sees. */
  if (context.theme) applyTheme(context.theme)
  const said = context.scope === 'project' ? 'all epics' : (context.epic ?? 'no epic')
  document.getElementById('told')!.textContent = said
  /* When it was told, on the clock every page on this computer shares: a driver measures the
     host's hand-over from the press to here, not from its own polling of the page. */
  ;((window as unknown as { __toldLog?: [string, number][] }).__toldLog ??= []).push([said, Date.now()])
}

const header = () => [{ kind: 'toggle' as const, id: 'flag', label: 'Flag', checked: flag, agents: true }]
const connection = connect(
  id,
  {
    onHello: (context, _state, facts) => {
      document.getElementById('greeted')!.textContent = 'greeted'
      told(context)
      connection.header(header())
      /* Its footer (protocol 2.38.0), only where the host says it draws one. */
      if (footer && facts?.footer === true) connection.footer(footer as Parameters<typeof connection.footer>[0])
    },
    onContext: (context) => told(context),
    onCovered: (covered) => keepLast(covered),
    onPress: ({ item, place }) => {
      if (place === 'footer') {
        document.body.dataset.footerPressed = item
        return
      }
      if (item !== 'flag') return 'no such item'
      flag = !flag
      document.body.dataset.flag = String(flag)
      connection.header(header())
    },
  },
  { origins },
)
connection.listen()

/* The jump: a person's click asks the host to go there (`view.goto`), and the answer is drawn. */
document.getElementById('jump')?.addEventListener('click', () => {
  if (!jump) return
  void connection.request('view.goto', jump).then(
    (answer) => {
      const outcome = (answer as { outcome?: string; why?: string } | null)?.outcome ?? 'unknown'
      document.body.dataset.jumped = outcome
      document.getElementById('jumped')!.textContent = `${outcome} ${(answer as { why?: string } | null)?.why ?? ''}`
    },
    (error: unknown) => {
      document.body.dataset.jumped = 'failed'
      document.getElementById('jumped')!.textContent = String(error)
    },
  )
})

/* The report: a press says what is going on (`activity.set`), so the Inbox has news (stamped now: the first list is a baseline unless it says it is newer than the page). */
document.getElementById('report')?.addEventListener('click', () => {
  if (activity) void connection.request('activity.set', { items: (activity as object[]).map((item) => ({ ...item, since: Date.now() })) })
})
