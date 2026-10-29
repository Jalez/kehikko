import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, test } from 'bun:test'

/*
 * The mark an agent's `jump` leaves on the kehikko, drawn: who jumped the view,
 * the step when that is all that changed, and Go back.
 *
 * In a process of its own, as the other DOM tests are: a global DOM is not
 * something to leave behind for the rest of the suite.
 */

const inChild = process.env.JUMP_MARK_DOM === '1'

if (!inChild) {
  test('the jump mark, in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, JUMP_MARK_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(/\b3 pass/)
  }, 60_000)
}

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let JumpMark: typeof import('../src/canvas/JumpMark.tsx').JumpMark
let markAfter: typeof import('../src/host/jump.ts').markAfter

if (inChild) {
  beforeAll(async () => {
    GlobalRegistrator.register()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    React = await import('react')
    act = React.act
    createRoot = (await import('react-dom/client')).createRoot
    JumpMark = (await import('../src/canvas/JumpMark.tsx')).JumpMark
    markAfter = (await import('../src/host/jump.ts')).markAfter
  })
  afterAll(() => GlobalRegistrator.unregister())

  const draw = async (element: import('react').ReactElement) => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(element))
    return { host, done: () => act(async () => root.unmount()) }
  }

  const here = { project: 1, kehikko: 'main', epic: 'share', parts: ['auth'], step: 2 }

  test('says who jumped it, and Go back is its one press', async () => {
    const pressed: string[] = []
    const mark = markAfter(null, here, { project: 2, kehikko: 'draft', epic: 'thesis', parts: [], step: null })
    const { host, done } = await draw(<JumpMark mark={mark} onBack={() => pressed.push('back')} onClose={() => pressed.push('close')} />)
    const status = host.querySelector('[data-jump-mark]')!
    expect(status.getAttribute('role')).toBe('status')
    expect(status.textContent).toContain('Jumped here by an agent.')
    const back = host.querySelector<HTMLButtonElement>('[data-jump-back]')!
    expect(back.textContent).toBe('Go back')
    await act(async () => back.click())
    expect(pressed).toEqual(['back'])
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click())
    expect(pressed).toEqual(['back', 'close'])
    await done()
  })

  test('a step-only jump names the step, its title as text and never markup', async () => {
    const mark = markAfter(null, here, { ...here, step: 7 }, '<b>Cap</b> the rate')
    const { host, done } = await draw(<JumpMark mark={mark} onBack={() => {}} onClose={() => {}} />)
    expect(host.textContent).toContain('Moved to step 7 (<b>Cap</b> the rate) by an agent.')
    expect(host.querySelector('b')).toBeNull()
    await done()
  })

  test('no mark, nothing drawn', async () => {
    const { host, done } = await draw(<JumpMark mark={null} onBack={() => {}} onClose={() => {}} />)
    expect(host.innerHTML).toBe('')
    await done()
  })
}
