import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'

/*
 * "Skills for this kehikko…", rendered: the list, a skill added through the form with its preview,
 * and removal in two presses. In a process of its own for the reason `header-menus.test.tsx` gives
 * (Radix decides at load whether it has a DOM).
 */

const inChild = process.env.KEHIKKO_SKILLS_DOM === '1'
const TESTS = 3

if (!inChild) {
  test('the kehikko skills window, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, KEHIKKO_SKILLS_DOM: '1' },
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
let Dialog: typeof import('../src/canvas/KehikkoSkills.tsx')
let kehikkoSkillText: typeof import('kehikot-module-protocol').kehikkoSkillText

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Dialog = await import('../src/canvas/KehikkoSkills.tsx')
  ;({ kehikkoSkillText } = await import('kehikot-module-protocol'))
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

type Skill = { name: string; description: string; body: string; text: string }

async function mount(start: Skill[]) {
  let kept = [...start]
  const saved: unknown[] = []
  const removed: string[] = []
  const load = async () => ({ skills: kept, folder: '.kehikot/host/skills/k1/' })
  const save = async (_: number, draft: { name: string; description: string; body: string; was?: string | null }) => {
    saved.push(draft)
    kept = [...kept, { ...draft, text: kehikkoSkillText(draft.name, draft.description, draft.body) }]
    return `Added ${draft.name}.`
  }
  const remove = async (_: number, name: string) => {
    removed.push(name)
    kept = kept.filter((one) => one.name !== name)
    return `Removed ${name}.`
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<Dialog.KehikkoSkillsDialog open onOpenChange={() => {}} kehikko={{ id: 1, name: 'Writing' }} load={load} save={save} remove={remove} />)
  })
  await act(async () => {})
  unmount = () => root.unmount()
  return { saved, removed }
}

/** Type into a React-controlled field. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)!

const one = (name: string, description: string, body: string): Skill => ({ name, description, body, text: '' })

test('lists the kehikko’s skills, says who gets them, and where they are kept', async () => {
  if (!inChild) return
  await mount([one('review-checklist', 'When reviewing a change.', 'Read the diff.')])
  const row = document.querySelector('[data-kehikko-skill="review-checklist"]')!
  expect(row.textContent).toContain('When reviewing a change.')
  expect(document.body.textContent).toContain('Every agent session on this kehikko gets these')
  expect(document.body.textContent).toContain('.kehikot/host/skills/k1/')
})

test('a new skill: the form, a preview of the SKILL.md as text, and Add', async () => {
  if (!inChild) return
  const { saved } = await mount([])
  expect(document.body.textContent).toContain('no skills of its own yet')
  await act(async () => button('New skill').click())
  expect(button('Add skill').disabled).toBe(true)
  await act(async () => type(document.querySelector<HTMLInputElement>('#kehikko-skill-name')!, 'house-style'))
  await act(async () => type(document.querySelector<HTMLInputElement>('#kehikko-skill-description')!, 'When writing prose here.'))
  await act(async () => type(document.querySelector<HTMLTextAreaElement>('#kehikko-skill-body')!, '<b>Short</b> sentences.'))
  await act(async () => button('Preview').click())
  const preview = document.querySelector('[data-kehikko-skill-preview]')!
  expect(preview.textContent).toBe(kehikkoSkillText('house-style', 'When writing prose here.', '<b>Short</b> sentences.'))
  /* Text, never markup. */
  expect(preview.querySelector('b')).toBeNull()
  await act(async () => button('Add skill').click())
  await act(async () => {})
  expect(saved).toEqual([{ name: 'house-style', description: 'When writing prose here.', body: '<b>Short</b> sentences.', was: null }])
  expect(document.querySelector('[data-kehikko-skill="house-style"]')).not.toBeNull()
})

test('removing takes two presses', async () => {
  if (!inChild) return
  const { removed } = await mount([one('a', 'When a.', 'A.')])
  await act(async () => button('remove a').click())
  expect(removed).toEqual([])
  expect(document.body.textContent).toContain('remove it?')
  await act(async () => button('Remove').click())
  await act(async () => {})
  expect(removed).toEqual(['a'])
  expect(document.querySelector('[data-kehikko-skill="a"]')).toBeNull()
})
