import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MESSAGE, PROTOCOL, SERVER_ASK_PATH, WELL_KNOWN, hostTooOld, tooOldOf } from 'kehikot-module-protocol'

import type { Presence as ServerPresence } from '../server/discover.ts'
import type { Presence } from '../src/host/registry.ts'

/*
 * A module and this Kehikot that do not fit (protocol 2.22.0, `fitOf`). Found on discovery from
 * the manifest every module serves. Drawn by the host in the container in place of the page:
 * "<Module> needs a newer Kehikot", one line naming what is missing, and "Update Kehikot"
 * opening the Updates menu. A module too old says "<Module> needs an update", and its button
 * opens its row. The modules list marks it, `read_canvas` says it, and a call the host does not
 * know comes back `host-too-old`. Compatible modules are untouched.
 *
 * The rendering runs in a process of its own, for the reason `header-menus.test.tsx` gives:
 * Radix decides at load whether it has a DOM.
 */

const inChild = process.env.FITS_OR_SAYS_DOM === '1'
const RENDERED = 5

if (!inChild) {
  test('the notice, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, FITS_OR_SAYS_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${RENDERED} pass`))
  }, 60_000)
}

/* ------------------------------------------------------------------------ *
 * The server's half: discovery, the answers, read_canvas
 * ------------------------------------------------------------------------ */

const AT = 'http://127.0.0.1:7841'
const registration = { id: 'example.monitor', url: AT, file: '/tmp/example.monitor.json' }

/** A fit, as discovery says it for Monitor on a host before 2.20 — the words the protocol makes. */
const NEEDS_NEWER = {
  kind: 'host-too-old',
  title: 'Monitor needs a newer Kehikot',
  line: 'It uses the call log, added in protocol 2.20.',
  action: 'Update Kehikot',
  since: '2.20.0',
} as const

const NEEDS_UPDATE = {
  kind: 'module-too-old',
  title: 'Monitor needs an update',
  line: 'It was built against protocol 1; this Kehikot speaks protocol 2.',
  action: 'Update Monitor',
  since: null,
} as const

const manifest = (over: Record<string, unknown> = {}) => ({
  kind: 'kehikot.module',
  protocol: PROTOCOL,
  id: 'example.monitor',
  name: 'Monitor',
  version: '0.1.0',
  summary: 'The calls on this computer.',
  entry: '/app',
  modes: [{ id: 'monitor', label: 'Monitor', scope: 'global' }],
  declares: { protocol: '>=2 <3', uses: ['traffic:read'], storage: true },
  partless: 'Traffic belongs to this computer, not to the parts of an epic.',
  ...over,
})

function serving(document: unknown) {
  return (async (input: string | URL) =>
    String(input).endsWith(WELL_KNOWN) ? new Response(JSON.stringify(document)) : new Response('not here', { status: 404 })) as unknown as typeof fetch
}

describe('discovery', () => {
  if (inChild) return

  test('a compatible module is untouched: ready, framed, no fit', async () => {
    const { look } = await import('../server/discover.ts')
    const presence = await look(registration, serving(manifest()))
    expect(presence.condition).toBe('ready')
    expect(presence.fit).toBeUndefined()
    expect(presence.line).toBe('The calls on this computer.')
  })

  test('a module that needs what this Kehikot does not know needs a newer Kehikot, in the protocol’s words', async () => {
    const { look } = await import('../server/discover.ts')
    const newer = manifest({
      declares: { protocol: '>=2 <3', uses: ['traffic:read', 'traffic:replay'], storage: true },
      build: { version: '0.2.0', commit: null, started: '2026-10-26T00:00:00.000Z', protocol: '2.23.0' },
    })
    const presence = await look(registration, serving(newer))
    expect(presence.condition).toBe('incompatible')
    expect(presence.fit).toEqual({
      kind: 'host-too-old',
      title: 'Monitor needs a newer Kehikot',
      line: 'It uses traffic:replay, which this Kehikot does not know.',
      action: 'Update Kehikot',
      since: '2.23.0',
    })
    expect(presence.line).toBe(presence.fit!.line)
    expect(presence.module).toBeUndefined()
  })

  test('…and so does one built against a newer protocol number, even when this host cannot read its manifest', async () => {
    const { look } = await import('../server/discover.ts')
    const three = await look(registration, serving(manifest({ protocol: 3, declares: { protocol: '>=3', uses: [] } })))
    expect(three.fit).toMatchObject({ kind: 'host-too-old', line: 'It was built against protocol 3; this Kehikot speaks protocol 2.' })
    /* A manifest this host's schema refuses (no modes), from a module that needs a newer host. */
    const unreadable = await look(registration, serving(manifest({ protocol: 3, declares: { protocol: '>=3' }, modes: [] })))
    expect(unreadable.condition).toBe('incompatible')
    expect(unreadable.refused).toBeUndefined()
    expect(unreadable.fit?.title).toBe('Monitor needs a newer Kehikot')
  })

  test('a module too old for this Kehikot needs an update', async () => {
    const { look } = await import('../server/discover.ts')
    const presence = await look(registration, serving(manifest({ protocol: 1, declares: { protocol: '>=1', uses: [] } })))
    expect(presence.condition).toBe('incompatible')
    expect(presence.fit).toEqual(NEEDS_UPDATE)
  })

  test('a typo from a module built with an older protocol is not a reason to stop it', async () => {
    const { look } = await import('../server/discover.ts')
    const typo = manifest({
      declares: { protocol: '>=2 <3', uses: ['traffic:raed'], storage: true },
      build: { version: '0.1.0', commit: null, started: '2026-10-26T00:00:00.000Z', protocol: '2.20.0' },
    })
    expect((await look(registration, serving(typo))).condition).toBe('ready')
  })
})

describe('a call this Kehikot does not know', () => {
  if (inChild) return

  test('is answered unknown-method, declined host-too-old, and the module reads the version it needs', async () => {
    const { answer } = await import('../server/answers.ts')
    const said = answer('example.monitor', 'traffic.replay', {}, () => true)
    expect(said).toMatchObject({ ok: false, reason: 'unknown-method', declined: 'host-too-old' })
    /* What the module's own protocol (2.22.0 or later) makes of it: the typed result. */
    expect(hostTooOld(said)).toEqual({ outcome: 'declined', reason: 'host-too-old', since: null })
    expect(tooOldOf('parts.get', { reason: 'unknown-method' })).toEqual({ outcome: 'declined', reason: 'host-too-old', since: '2.21.0' })
  })

  test('the conversation posts the word to the frame as the host said it', async () => {
    const { Conversation } = await import('../src/host/conversation.ts')
    const { toWireContext } = await import('../src/host/context.ts')
    const { answer } = await import('../server/answers.ts')
    const sent: Record<string, unknown>[] = []
    const contentWindow = { postMessage: (message: unknown) => void sent.push(message as Record<string, unknown>) } as unknown as Window
    const quiet = { ready() {}, silent() {}, fault() {}, height() {}, filters() {}, clearable() {}, refreshable() {}, header() {} }
    const conversation = new Conversation({ contentWindow }, 'example.monitor', null, async (method, params) => answer('example.monitor', method, params, () => true), quiet)
    conversation.greet(toWireContext({ epic: null, project: null }, 'dark'))
    conversation.receive({ source: contentWindow, origin: 'null', data: { type: MESSAGE.REQUEST, id: 'q1', method: 'traffic.replay', params: {} } })
    await Bun.sleep(0)
    const response = sent.find((one) => one.type === MESSAGE.RESPONSE)
    expect(response).toMatchObject({ id: 'q1', ok: false, reason: 'unknown-method', declined: 'host-too-old' })
    conversation.close()
  })

  test('a known method is answered as before, with no word added', async () => {
    const { answer } = await import('../server/answers.ts')
    const said = answer('example.monitor', 'epics.list', {}, () => true)
    expect('declined' in said).toBe(false)
  })

  test('a module’s server asking a method this host does not know is told host-too-old, not "malformed"', async () => {
    const { serverAskDesk } = await import('../server/serverAsk.ts')
    const { route } = serverAskDesk({
      known: () => true,
      originOf: async () => null,
      may: () => true,
      projectAt: () => null,
      answer: () => ({ ok: true, data: null }),
      fetch: (async () => Response.json({ ok: true, minted: false })) as unknown as typeof fetch,
    })
    const ask = (method: string) =>
      route(
        new Request(`http://127.0.0.1:4170${SERVER_ASK_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ module: 'example.monitor', pass: 'p'.repeat(40), method, params: {} }),
        }),
        new URL(`http://127.0.0.1:4170${SERVER_ASK_PATH}`),
      )
    const unknown = await ask('steps.replay')
    expect(await unknown!.json()).toMatchObject({ ok: false, reason: 'unknown-method', declined: 'host-too-old' })
    /* A page's method asked from a server is still a malformed question. */
    expect((await ask('parts.set'))!.status).toBe(400)
  })
})

describe('the modules list and read_canvas', () => {
  if (inChild) return

  const presence = (over: Partial<Presence>): Presence => ({ id: 'example.monitor', at: AT, condition: 'ready', reached: true, line: '', name: 'Monitor', ...over })

  test('the row is marked the way a refused module is, in the notice’s words', async () => {
    const { attention } = await import('../src/host/moduleMenu.ts')
    expect(attention(presence({ condition: 'incompatible', line: NEEDS_NEWER.line, fit: NEEDS_NEWER }))).toBe(
      'Monitor needs a newer Kehikot. It uses the call log, added in protocol 2.20.',
    )
    expect(attention(presence({ condition: 'incompatible', line: NEEDS_UPDATE.line, fit: NEEDS_UPDATE }))).toBe(
      'Monitor needs an update. It was built against protocol 1; this Kehikot speaks protocol 2.',
    )
    expect(attention(presence({}))).toBeNull()
  })

  test('an agent reading the canvas is told it, and a compatible one is not', async () => {
    const { readFileSync } = await import('node:fs')
    const mcp = readFileSync(new URL('../server/mcp.ts', import.meta.url), 'utf8')
    const server = readFileSync(new URL('../server/server.ts', import.meta.url), 'utf8')
    expect(mcp).toContain('does not fit this Kehikot, and its container says so in place of its page: ${sighting.fit}')
    expect(server).toContain('...(presence.fit ? { fit: `${presence.fit.title}. ${presence.fit.line}` } : {})')
  })

  test('the server and the page carry the same fit', () => {
    const fit: NonNullable<ServerPresence['fit']> = NEEDS_NEWER
    const page: NonNullable<Presence['fit']> = fit
    expect(page).toBe(fit)
  })
})

/* ------------------------------------------------------------------------ *
 * The page's half, rendered
 * ------------------------------------------------------------------------ */

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let Box: typeof import('../src/canvas/Container.tsx')
let Lists: typeof import('../src/canvas/Modules.tsx')
let Updates: typeof import('../src/host/updates.ts')
let Standing: typeof import('../src/host/standing.ts')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Box = await import('../src/canvas/Container.tsx')
  Lists = await import('../src/canvas/Modules.tsx')
  Updates = await import('../src/host/updates.ts')
  Standing = await import('../src/host/standing.ts')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

let unmount: (() => void) | null = null
afterEach(() => {
  if (!inChild) return
  act(() => unmount?.())
  unmount = null
  document.body.innerHTML = ''
})

async function render(element: import('react').ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<TooltipProvider>{element}</TooltipProvider>))
  await act(async () => {})
  unmount = () => root.unmount()
  return host
}

const placed = (over: Partial<Presence>): Presence =>
  ({ id: 'kehikot.monitor', at: 'http://127.0.0.1:8090', condition: 'ready', reached: true, name: 'Monitor', line: 'The calls on this computer.', ...over }) as Presence

async function container(presence: Presence) {
  const nothing = () => {}
  const showing = Standing.showing({ condition: presence.condition, line: presence.line }, presence.condition === 'ready' ? { condition: 'ready', line: null } : undefined)
  return render(
    <Box.Container
      presence={presence}
      showing={showing}
      fault={null}
      body={nothing}
      grow={false}
      onGrow={nothing}
      pinned={false}
      onPin={nothing}
      collapsed={false}
      onCollapse={nothing}
      header={[]}
      filters={[]}
      chosen={{}}
      onChoose={nothing}
      onEverything={nothing}
      clear={null}
      onClear={nothing}
      refresh={undefined}
      refreshEvery={null}
      onRefresh={nothing}
      onRefreshEvery={nothing}
      selected={false}
      onSelect={nothing}
      onPrompts={nothing}
      onTools={nothing}
      onStarted={nothing}
      onRemove={nothing}
      kehikko="thesis"
      epic={null}
    />,
  )
}

/** Every `OPEN_UPDATES` the page sends, with the module it names. */
function listening() {
  const asked: (string | null)[] = []
  const hear = (event: Event) => asked.push(Updates.askedModule(event))
  window.addEventListener(Updates.OPEN_UPDATES, hear)
  return { asked, stop: () => window.removeEventListener(Updates.OPEN_UPDATES, hear) }
}

const button = (label: string) => [...document.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)

describe('the container', () => {
  if (!inChild) return

  test('a module that needs a newer Kehikot shows the notice and its line, and Update Kehikot opens Updates', async () => {
    await container(placed({ condition: 'incompatible', line: NEEDS_NEWER.line, fit: NEEDS_NEWER, protocols: { host: 2, module: 2, range: '>=2 <3' } }))
    expect(document.querySelector('[data-testid="condition-title"]')?.textContent).toBe('Monitor needs a newer Kehikot')
    expect(document.body.textContent).toContain('It uses the call log, added in protocol 2.20.')
    /* No page framed, no Start, and none of the protocol numbers the line already explains. */
    expect(button('start it')).toBeUndefined()
    expect(document.body.textContent).not.toContain('module protocol')
    const heard = listening()
    await act(async () => button('Update Kehikot')!.click())
    heard.stop()
    expect(heard.asked).toEqual([null])
  })

  test('a module too old says it needs an update, and Update <Module> opens Updates at its row', async () => {
    await container(placed({ condition: 'incompatible', line: NEEDS_UPDATE.line, fit: NEEDS_UPDATE }))
    expect(document.querySelector('[data-testid="condition-title"]')?.textContent).toBe('Monitor needs an update')
    expect(document.body.textContent).toContain('It was built against protocol 1; this Kehikot speaks protocol 2.')
    const heard = listening()
    await act(async () => button('Update Monitor')!.click())
    heard.stop()
    expect(heard.asked).toEqual(['kehikot.monitor'])
  })

  test('the module’s name is text: markup in it is shown as written, never drawn', async () => {
    const name = '<img src=x onerror=alert(1)>'
    const fit = { ...NEEDS_NEWER, title: `${name} needs a newer Kehikot` }
    await container(placed({ name, condition: 'incompatible', line: fit.line, fit }))
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('[data-testid="condition-title"]')?.textContent).toBe(`${name} needs a newer Kehikot`)
  })

  test('a compatible module is untouched: no notice, no title, no update button', async () => {
    await container(placed({}))
    expect(document.querySelector('[data-testid="condition-title"]')).toBeNull()
    expect(button('Update Kehikot')).toBeUndefined()
    expect(document.body.textContent).not.toContain('needs a newer Kehikot')
  })
})

describe('the modules list', () => {
  if (!inChild) return

  test('marks the module with the notice’s words, beside the incompatible word, not by colour alone', async () => {
    const presences = [placed({ condition: 'incompatible', line: NEEDS_NEWER.line, fit: NEEDS_NEWER }), placed({ id: 'kehikot.notes', name: 'Notes', line: 'Notes.' })]
    await render(
      <Lists.ModuleList
        registry={{ presences, sweep: { dir: '/registry', rejected: [] }, protocol: 2 }}
        onCanvas={new Set()}
        canvases={[]}
        open={null}
        onPlace={() => {}}
        onUnplace={() => {}}
      />,
    )
    const alerts = [...document.querySelectorAll('[role="alert"]')].map((one) => one.textContent)
    expect(alerts).toEqual(['Monitor needs a newer Kehikot. It uses the call log, added in protocol 2.20.'])
    expect(document.body.textContent).toContain('incompatible')
  })
})
