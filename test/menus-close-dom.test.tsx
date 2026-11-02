import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * A menu and a popover closing when the window loses focus to a module's
 * page, rendered: the press that lands in a frame is no pointerdown this
 * document ever sees, so the window's `blur` is what closes the menu — and
 * the trigger does not take the keyboard back out of the page.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives:
 * Radix decides at load whether it has a DOM, and another file in the shared
 * run has already loaded it without one.
 */

const inChild = process.env.MENUS_CLOSE_DOM === '1'
const TESTS = 6

if (!inChild) {
  test('menus closing on a blur into a frame, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, MENUS_CLOSE_DOM: '1' },
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
let Ui: typeof import('../src/components/ui/dropdown-menu.tsx')
let Pop: typeof import('../src/components/ui/popover.tsx')

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Ui = await import('../src/components/ui/dropdown-menu.tsx')
  Pop = await import('../src/components/ui/popover.tsx')
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
  /* An activeElement set per test is an own property; removing it restores the getter. */
  delete (document as unknown as Record<string, unknown>).activeElement
})

const mount = async (node: React.ReactNode) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(node))
  unmount = () => root.unmount()
  return host
}

function MenuProbe({ changes }: { changes: boolean[] }) {
  const [open, setOpen] = React.useState(true)
  return (
    <Ui.DropdownMenu
      open={open}
      onOpenChange={(next) => {
        changes.push(next)
        setOpen(next)
      }}
    >
      <Ui.DropdownMenuTrigger asChild>
        <button type="button" data-trigger>
          menu
        </button>
      </Ui.DropdownMenuTrigger>
      <Ui.DropdownMenuContent>
        <Ui.DropdownMenuItem data-row>one row</Ui.DropdownMenuItem>
      </Ui.DropdownMenuContent>
    </Ui.DropdownMenu>
  )
}

function PopoverProbe({ changes }: { changes: boolean[] }) {
  const [open, setOpen] = React.useState(true)
  return (
    <Pop.Popover
      open={open}
      onOpenChange={(next) => {
        changes.push(next)
        setOpen(next)
      }}
    >
      <Pop.PopoverTrigger asChild>
        <button type="button" data-trigger>
          popover
        </button>
      </Pop.PopoverTrigger>
      <Pop.PopoverContent>words</Pop.PopoverContent>
    </Pop.Popover>
  )
}

const menuContent = () => document.querySelector('[data-slot="dropdown-menu-content"]')
const popoverContent = () => document.querySelector('[data-slot="popover-content"]')

/** A frame that has just taken the keyboard, as the host document sees it. */
const frameTookFocus = () => {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => frame })
  return frame
}
const windowBlur = () => act(async () => void window.dispatchEvent(new Event('blur')))
/* Radix returns focus a task after the content is gone. */
const settled = () => act(async () => void (await new Promise((done) => setTimeout(done, 20))))

describe('a menu closing when the window loses focus to a module page', () => {
  if (!inChild) return

  test('the blur into a frame closes the open menu', async () => {
    const changes: boolean[] = []
    await mount(<MenuProbe changes={changes} />)
    expect(menuContent()).not.toBeNull()
    frameTookFocus()
    await windowBlur()
    /* The menu primitive hears the window blur itself and the shared hook hears the frame: both answer "close". */
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.every((one) => one === false)).toBe(true)
    expect(menuContent()).toBeNull()
  })

  test('the trigger does not take the keyboard back out of the page', async () => {
    const changes: boolean[] = []
    await mount(<MenuProbe changes={changes} />)
    const frame = frameTookFocus()
    await windowBlur()
    await settled()
    expect(menuContent()).toBeNull()
    expect(document.activeElement).toBe(frame)
  })

  test('a window blur that is not into a frame closes the menu as an ordinary dismissal, and focus returns to the trigger', async () => {
    /* The menu primitive hears any window blur itself; what this change adds is
       the frame case for the popover, and no focus return when focus left for a
       page. Here focus did not leave for a page, so the trigger takes it back. */
    const changes: boolean[] = []
    await mount(<MenuProbe changes={changes} />)
    await windowBlur()
    await settled()
    expect(changes).toEqual([false])
    expect(menuContent()).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('[data-trigger]'))
  })

  test('an element blur passing through the capture phase is ignored', async () => {
    const changes: boolean[] = []
    await mount(<MenuProbe changes={changes} />)
    frameTookFocus()
    await act(async () => void document.querySelector('[data-row]')!.dispatchEvent(new Event('blur')))
    expect(changes).toEqual([])
    expect(menuContent()).not.toBeNull()
  })
})

describe('a popover closing the same way', () => {
  if (!inChild) return

  test('the blur into a frame closes the open popover', async () => {
    const changes: boolean[] = []
    await mount(<PopoverProbe changes={changes} />)
    expect(popoverContent()).not.toBeNull()
    frameTookFocus()
    await windowBlur()
    expect(changes).toEqual([false])
    expect(popoverContent()).toBeNull()
  })

  test('a window blur that is not into a frame leaves the popover open', async () => {
    const changes: boolean[] = []
    await mount(<PopoverProbe changes={changes} />)
    await windowBlur()
    expect(changes).toEqual([])
    expect(popoverContent()).not.toBeNull()
  })
})
