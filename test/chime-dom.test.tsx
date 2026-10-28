import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { DEFAULT_CHIME, chimePatched, withoutFile, fellBackWords, type ChimeSettings } from '../src/host/chime.ts'

/*
 * The Inbox chime, rendered: the mute button, the picker for each kind, the
 * chime maker and the person's own sounds, with Web Audio stubbed so a press
 * can be asserted as a note started. In a process of its own, for the reason
 * `auto-updates-dom.test.tsx` gives (Radix decides at load whether it has a DOM).
 */

const inChild = process.env.CHIME_DOM === '1'
const TESTS = 11

if (!inChild) {
  test('the chime, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CHIME_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 60_000)
}

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let Panels: typeof import('../src/canvas/ChimeSettings.tsx')
let Store: typeof import('../src/host/chimeStore.ts')
let Player: typeof import('../src/host/chimePlayer.ts')
let UseChime: typeof import('../src/canvas/useChime.ts')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

/** What the host holds, and what was sent to it. */
let host: ChimeSettings
const posts: { url: string; body: any }[] = []
let refuse = false
const started: number[] = []
const files: Record<string, Uint8Array> = {}
let decodedSeconds = 1.2

class StubContext {
  state = 'running'
  currentTime = 0
  destination = {}
  resume() {
    return Promise.resolve()
  }
  createOscillator() {
    const osc = { type: 'sine', frequency: { value: 0 }, connect() {}, stop() {}, start() { started.push(osc.frequency.value) } }
    return osc
  }
  createGain() {
    return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }
  }
  createBufferSource() {
    return { buffer: null, connect() {}, start() { started.push(-1) } }
  }
  decodeAudioData(bytes: ArrayBuffer) {
    return bytes.byteLength === 0 ? Promise.reject(new Error('bad')) : Promise.resolve({ duration: decodedSeconds })
  }
}

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as { AudioContext?: unknown }).AudioContext = StubContext
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const path = String(url)
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? 'null'))
      posts.push({ url: path, body })
      if (refuse) return json({ ok: false, why: 'The host did not take that.' }, 400)
      if (path === '/host/settings') {
        const next = chimePatched(host, body.chime)
        if (!next) return json({ ok: false, why: 'no' }, 400)
        host = next
        return json({ ok: true, settings: {}, status: {}, chime: host })
      }
      if (path === '/host/sounds') {
        const sound = { id: '0123456789abcdef', name: body.name, ext: 'wav', bytes: 10, seconds: body.seconds }
        host = { ...host, files: [...host.files, sound] }
        return json({ ok: true, sound, chime: host })
      }
      if (path === '/host/sounds/remove') {
        const file = host.files.find((one) => one.id === body.id)!
        const out = withoutFile(host, body.id)
        host = out.settings
        return json({ ok: true, chime: host, said: fellBackWords(file.name, out.fellBack, out.modules) })
      }
      if (path === '/host/sounds/rename') {
        host = { ...host, files: host.files.map((one) => (one.id === body.id ? { ...one, name: body.name } : one)) }
        return json({ ok: true, chime: host })
      }
    }
    if (path.startsWith('/host/sounds/')) return new Response((files[path.slice(13)] ?? new Uint8Array([1, 2, 3])) as unknown as BodyInit)
    if (path === '/host/settings') return json({ ok: true, settings: { asked: true }, status: { problems: [] }, hook: {}, chime: host })
    return json({})
  }) as typeof fetch
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Panels = await import('../src/canvas/ChimeSettings.tsx')
  Store = await import('../src/host/chimeStore.ts')
  Player = await import('../src/host/chimePlayer.ts')
  UseChime = await import('../src/canvas/useChime.ts')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

let unmount: (() => void) | null = null
beforeEach(() => {
  if (!inChild) return
  host = structuredClone(DEFAULT_CHIME)
  Store.setChime(host)
  Player.resetAudio()
  refuse = false
  decodedSeconds = 1.2
})
afterEach(() => {
  if (!inChild) return
  act(() => unmount?.())
  unmount = null
  posts.length = 0
  started.length = 0
  document.body.innerHTML = ''
})

async function mount(node: React.ReactNode) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
  unmount = () => root.unmount()
  return el
}
const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 20)))
const click = (el: Element) => act(async () => (el as HTMLElement).click())
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}
const byLabel = (root: ParentNode, label: string) => root.querySelector<HTMLElement>(`[aria-label="${label}"]`)!

describe.skipIf(!inChild)('the chime, rendered', () => {
  test('the mute button says what it will do, shows its state without colour, and keeps it through the settings route', async () => {
    const el = await mount(<Panels.MuteChime />)
    const button = byLabel(el, 'Mute chime') as HTMLButtonElement
    expect(button.getAttribute('aria-pressed')).toBe('false')
    const bell = button.innerHTML
    await click(button)
    await settle()
    expect(posts).toEqual([{ url: '/host/settings', body: { chime: { on: false } } }])
    expect(host.on).toBe(false)
    const muted = byLabel(el, 'Unmute chime')
    expect(muted.getAttribute('aria-pressed')).toBe('true')
    expect(muted.getAttribute('data-chime-mute')).toBe('on')
    /* A different shape, not only a different colour. */
    expect(muted.innerHTML).not.toBe(bell)
    await click(muted)
    await settle()
    expect(host.on).toBe(true)
    expect(byLabel(el, 'Mute chime')).not.toBeNull()
  })

  test('a mute the host does not take goes back', async () => {
    refuse = true
    const el = await mount(<Panels.MuteChime />)
    await click(byLabel(el, 'Mute chime'))
    await settle()
    expect(byLabel(el, 'Mute chime')).not.toBeNull()
    expect(Store.chimeNow().on).toBe(true)
  })

  test('each kind has a picker and a Preview that plays it; a pick is kept in the host settings', async () => {
    const el = await mount(<Panels.ChimePanel modules={[{ id: 'kehikot.claude', name: 'Claude' }]} />)
    const rows = [...el.querySelectorAll('[data-chime-kind]')].map((one) => one.getAttribute('data-chime-kind'))
    expect(rows).toEqual(['urgent', 'attention', 'done', 'notice'])
    /* Needs you, the default Bell: three notes. */
    await click(byLabel(el, 'Preview Needs you'))
    expect(started).toHaveLength(3)
    started.length = 0
    /* Finished, Marimba: the soft form, two notes. */
    await click(byLabel(el, 'Preview Finished'))
    expect(started).toHaveLength(2)
    started.length = 0
    const pick = el.querySelector<HTMLSelectElement>('[data-chime-kind="done"] select')!
    await choose(pick, 'preset:playful')
    expect(posts.at(-1)).toEqual({ url: '/host/settings', body: { chime: { sounds: { done: { type: 'preset', id: 'playful' } } } } })
    expect(host.sounds.done).toEqual({ type: 'preset', id: 'playful' })
    await choose(pick, 'none')
    await click(byLabel(el, 'Preview Finished'))
    expect(started).toHaveLength(0)
  })

  test('a sound for one module is added from the modules, picked, and removed', async () => {
    const el = await mount(<Panels.ChimePanel modules={[{ id: 'kehikot.claude', name: 'Claude' }]} />)
    await choose(byLabel(el, 'Module') as HTMLSelectElement, 'kehikot.claude')
    await click([...el.querySelectorAll('button')].find((one) => one.textContent === 'Add a sound for a module')!)
    await settle()
    expect(host.modules['kehikot.claude']?.attention).toEqual(host.sounds.attention)
    await choose(byLabel(el, 'Sound for Claude, Needs you') as HTMLSelectElement, 'preset:marimba')
    expect(host.modules['kehikot.claude']?.attention).toEqual({ type: 'preset', id: 'marimba' })
    await click(byLabel(el, 'Remove the sound for Claude, Needs you'))
    await settle()
    expect(host.modules).toEqual({})
  })

  test('each declared event has a picker under its module, by its own words; the research chime by default, played as written', async () => {
    const modules = [
      { id: 'kehikot.claude', name: 'Claude', events: [{ id: 'research-complete', says: 'Research complete', state: 'done' as const }] },
      { id: 'kehikot.tests', name: 'Tests' },
    ]
    const el = await mount(<Panels.ChimePanel modules={modules} />)
    const section = el.querySelector('[data-chime-events]')!
    expect([...section.querySelectorAll('[data-chime-event-module]')].map((one) => one.getAttribute('data-chime-event-module'))).toEqual(['kehikot.claude'])
    const row = section.querySelector('[data-chime-event="research-complete"]')!
    expect(row.querySelector('label')!.textContent).toBe('Research complete')
    expect(row.textContent).toContain('A kind of “Finished”.')
    const pick = row.querySelector<HTMLSelectElement>('select')!
    expect(pick.value).toBe('preset:research')
    expect([...pick.options].map((one) => one.textContent)).toContain('Same as Finished')
    /* As written: all four notes of the research chime, not the Finished form's two. */
    await click(byLabel(el, 'Preview Claude Research complete'))
    expect(started).toHaveLength(4)
    started.length = 0
    await choose(pick, 'preset:bell')
    expect(posts.at(-1)).toEqual({ url: '/host/settings', body: { chime: { events: { 'kehikot.claude': { 'research-complete': { type: 'preset', id: 'bell' } } } } } })
    expect(host.events['kehikot.claude']?.['research-complete']).toEqual({ type: 'preset', id: 'bell' })
    await choose(pick, 'kind')
    expect(host.events['kehikot.claude']?.['research-complete']).toEqual({ type: 'kind' })
    /* Same as Finished: the Finished sound in its soft form. */
    await click(byLabel(el, 'Preview Claude Research complete'))
    expect(started).toHaveLength(2)
  })

  test('no module declares an event: no events section', async () => {
    const el = await mount(<Panels.ChimePanel modules={[{ id: 'kehikot.claude', name: 'Claude' }]} />)
    expect(el.querySelector('[data-chime-events]')).toBeNull()
  })

  test('the chime maker: slots of the scale only, kept as My chime, and previewed', async () => {
    const el = await mount(<Panels.ChimePanel />)
    const maker = el.querySelector('[data-chime-maker]')!
    const slot = [...maker.querySelectorAll('select')][0]!
    expect([...slot.options].map((one) => one.value)).toEqual(['rest', '60', '62', '64', '67', '69', '72', '74', '76', '79', '81'])
    await choose(slot, '81')
    expect(maker.querySelector('[data-chime-length]')!.textContent).toContain('not saved yet')
    const preview = [...maker.querySelectorAll('button')].find((one) => one.textContent === 'Preview')!
    await click(preview)
    expect(started.length).toBeGreaterThan(0)
    expect(started[0]).toBeCloseTo(880, 0)
    await click([...maker.querySelectorAll('button')].find((one) => one.textContent?.startsWith('Save as'))!)
    await settle()
    expect(posts.at(-1)!.body.chime.custom.notes[0]).toBe(81)
    expect(host.custom.notes[0]).toBe(81)
    expect(maker.querySelector('[data-chime-length]')!.textContent).toContain('saved')
    expect(maker.querySelector('[data-chime-length]')!.textContent).not.toContain('not saved')
  })

  test('your own sounds: add, refuse the wrong ones in a sentence, preview, pick and remove with the fall back said', async () => {
    const el = await mount(<Panels.ChimePanel />)
    const input = el.querySelector<HTMLInputElement>('input[type="file"]')!
    const give = async (file: File) => {
      await act(async () => {
        Object.defineProperty(input, 'files', { value: [file], configurable: true })
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await settle()
    }
    const note = () => el.querySelector('[data-chime-note]')!.textContent ?? ''

    await give(new File([new Uint8Array(4)], 'notes.txt'))
    expect(note()).toContain('wav, mp3, ogg, m4a, aac')
    await give(new File([new Uint8Array(2 * 1024 * 1024)], 'big.wav'))
    expect(note()).toContain('at most 1 MB')
    decodedSeconds = 7
    await give(new File([new Uint8Array(100)], 'long.wav'))
    expect(note()).toContain('at most 5 seconds')
    expect(posts.filter((one) => one.url === '/host/sounds')).toHaveLength(0)

    decodedSeconds = 1.2
    await give(new File([new Uint8Array(100)], 'Zug zug.wav'))
    expect(posts.at(-1)).toEqual({ url: '/host/sounds', body: expect.objectContaining({ name: 'Zug zug.wav', seconds: 1.2 }) })
    expect(el.querySelector('[data-chime-file]')!.textContent).toContain('Zug zug.wav')

    /* It is offered by every picker, and Preview plays it through Web Audio. */
    const pick = el.querySelector<HTMLSelectElement>('[data-chime-kind="attention"] select')!
    expect([...pick.options].map((one) => one.textContent)).toContain('Zug zug.wav')
    await choose(pick, 'file:0123456789abcdef')
    expect(host.sounds.attention).toEqual({ type: 'file', id: '0123456789abcdef' })
    await click(byLabel(el, 'Preview Needs you'))
    await settle()
    expect(started).toEqual([-1])

    await click(byLabel(el, 'Remove Zug zug.wav'))
    await settle()
    expect(el.querySelector('[data-chime-file]')).toBeNull()
    expect(note()).toContain('Needs you went back to its default')
    expect(host.sounds.attention).toEqual(DEFAULT_CHIME.sounds.attention)
  })

  test('the file input accepts audio by type as well as by extension, wav included', async () => {
    const el = await mount(<Panels.ChimePanel />)
    const accept = el.querySelector<HTMLInputElement>('input[type="file"]')!.getAttribute('accept')!.split(',')
    expect(accept).toContain('audio/*')
    expect(accept).toContain('audio/wav')
    expect(accept).toContain('audio/x-wav')
    for (const ext of ['wav', 'mp3', 'ogg', 'm4a', 'aac']) expect(accept).toContain(`.${ext}`)
    expect(el.querySelector('[data-chime-drop-hint]')!.textContent).toBe('or drop a sound file here')
  })

  test('a sound file dropped on the panel is imported by the same route, with a drop target while dragging', async () => {
    const el = await mount(<Panels.ChimePanel />)
    const zone = el.querySelector<HTMLElement>('[data-chime-files]')!
    const note = () => el.querySelector('[data-chime-note]')!.textContent ?? ''
    const drag = async (type: string, files: File[] = []) => {
      await act(async () => {
        const event = new Event(type, { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files, dropEffect: '' } })
        zone.dispatchEvent(event)
      })
    }
    await drag('dragenter')
    expect(zone.hasAttribute('data-dropping')).toBe(true)
    expect(el.querySelector('[data-chime-drop-hint]')!.textContent).toContain('Drop it')
    await drag('dragleave')
    expect(zone.hasAttribute('data-dropping')).toBe(false)

    const before = posts.filter((one) => one.url === '/host/sounds').length
    decodedSeconds = 1.2
    await drag('dragenter')
    await drag('drop', [new File([new Uint8Array(4)], 'notes.txt')])
    await settle()
    expect(note()).toContain('wav, mp3, ogg, m4a, aac')
    expect(posts.filter((one) => one.url === '/host/sounds')).toHaveLength(before)

    await drag('dragenter')
    await drag('drop', [new File([new Uint8Array(100)], 'Dropped.wav')])
    await settle()
    expect(zone.hasAttribute('data-dropping')).toBe(false)
    expect(posts.at(-1)).toEqual({ url: '/host/sounds', body: expect.objectContaining({ name: 'Dropped.wav', seconds: 1.2 }) })
    expect(el.querySelector('[data-chime-file]')!.textContent).toContain('Dropped.wav')
  })

  test('the page unlocks audio on its first gesture, and a burst plays once, unless muted', async () => {
    let constructed = 0
    const Base = StubContext
    ;(globalThis as { AudioContext?: unknown }).AudioContext = class extends Base {
      constructor() {
        super()
        constructed += 1
      }
    }
    function Probe({ offer }: { offer: (fn: (kind: any, module?: string) => void) => void }) {
      const chime = UseChime.useChime()
      offer(chime.offer)
      return null
    }
    let offer: (kind: any, module?: string) => void = () => {}
    await mount(<Probe offer={(fn) => (offer = fn)} />)
    await settle()
    expect(constructed).toBe(0)
    await act(async () => void document.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(constructed).toBe(1)

    /* Three things at once: one sound, and it is the needs-you one (three notes). */
    await act(async () => {
      offer('notice')
      offer('attention')
      offer('done')
    })
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 450)))
    expect(started).toHaveLength(3)

    /* Muted, nothing plays for the next burst once the quiet time has passed. */
    started.length = 0
    Store.setChime({ ...Store.chimeNow(), on: false })
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 3100)))
    await act(async () => offer('attention'))
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 450)))
    expect(started).toHaveLength(0)
  }, 15_000)
})
