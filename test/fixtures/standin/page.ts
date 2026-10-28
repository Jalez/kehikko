/**
 * The stand-in's page script (`server.ts` bundles it): greet the host, say
 * which epic it was told, count presses of the button, and keep one header
 * toggle whose state the driver reads off `body[data-flag]`.
 */
import { applyTheme, connect } from 'kehikot-module-protocol/client'

const { id, origins, jump } = (window as unknown as { __standin: { id: string; origins: string[]; jump: Record<string, unknown> | null } }).__standin
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
    onHello: (context) => {
      document.getElementById('greeted')!.textContent = 'greeted'
      told(context)
      connection.header(header())
    },
    onContext: (context) => told(context),
    onPress: ({ item }) => {
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
