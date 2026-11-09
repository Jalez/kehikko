import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, test } from 'bun:test'

/*
 * Where an Inbox item leads, and how its row is drawn:
 *
 *  - a tracker notice, pressed, goes to the kehikko where a module reacts to what is picked (by its
 *    manifest's `reacts`, never by name) and picks the notice's ref there;
 *  - with no such kehikko, its page is offered instead (the host's address offer: the person's
 *    browser, or a module that shows pages);
 *  - its row says "Tracker", whose change and which project, not "… says" and "the project";
 *  - quick answers wrap inside the panel and a long one is cut with an ellipsis, its whole text in
 *    a tooltip drawn beside it, not over the other answers;
 *  - in "This kehikko", what is about the whole project is grouped under "This project".
 *
 * In a process of its own for the reason `go-to-place-pressed.test.tsx` gives: Radix decides at
 * module load whether it has a DOM.
 */

const inChild = process.env.INBOX_TARGETS_DOM === '1'
const TESTS = 6

if (!inChild) {
  test('where an Inbox item leads, in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, INBOX_TARGETS_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 60_000)
}

type Entry = import('../src/host/inbox.ts').Entry
type InboxView = import('../src/canvas/Inbox.tsx').InboxView
type Offer = import('../src/host/address.ts').Offer

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let InboxPanel: typeof import('../src/canvas/Inbox.tsx').InboxPanel
let AddressOffer: typeof import('../src/canvas/AddressOffer.tsx').AddressOffer
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let useGoToPlace: typeof import('../src/canvas/useGoToPlace.ts').useGoToPlace
let tally: typeof import('../src/host/inbox.ts').tally
let handed: typeof import('../src/host/address.ts').handed
let TN: typeof import('../src/host/trackerNotices.ts')

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ InboxPanel } = await import('../src/canvas/Inbox.tsx'))
  ;({ AddressOffer } = await import('../src/canvas/AddressOffer.tsx'))
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
  ;({ useGoToPlace } = await import('../src/canvas/useGoToPlace.ts'))
  ;({ tally } = await import('../src/host/inbox.ts'))
  ;({ handed } = await import('../src/host/address.ts'))
  TN = await import('../src/host/trackerNotices.ts')
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

const notice = (more: Partial<Entry> = {}): Entry => ({
  module: TN.TRACKER_NOTICES_MODULE,
  name: TN.TRACKER_NOTICES_BY,
  id: 'gitlab:gitlab.example.org/group/app!4454',
  state: 'attention',
  label: '!4454 by Mona · review requested from you',
  priority: 'normal',
  refs: ['!4454'],
  entered: Date.now() - 60_000,
  opened: Date.now() - 60_000,
  closed: null,
  how: null,
  seen: null,
  dismissed: null,
  origin: 'activity',
  ...more,
})

const agent = (id: string, more: Partial<Entry> = {}): Entry => ({
  ...notice(),
  module: 'kehikot.agent',
  name: 'Agent',
  id,
  label: id,
  refs: [],
  ...more,
})

const viewOf = (entries: Entry[], over: Partial<InboxView> = {}): InboxView => {
  const at = over.at ?? { epic: 'thesis', kehikko: 'k1' }
  return {
    entries,
    earlierCount: 0,
    projectName: 'Shop',
    at,
    scope: 'everywhere',
    onScope: () => {},
    names: { epic: () => null, part: () => null, kehikko: (key) => (key === 'k1' ? 'Writing' : key === 'k2' ? 'Review' : null) },
    tally: tally(entries, at),
    next: null,
    open: true,
    onOpenChange: () => {},
    onGo: () => {},
    onNext: () => {},
    onSee: () => {},
    onDismiss: () => {},
    onForget: () => {},
    onSeeAll: () => {},
    loadLog: async () => ({ rows: [], more: false, total: 0 }),
    rev: 1,
    shortcut: 'Alt+Shift+N',
    now: () => Date.now(),
    ...over,
  }
}

async function mount(node: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
  return {
    host,
    async done() {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

/* What each module reacts to, as its manifest says. The names mean nothing to the host. */
const REACTS: Record<string, string[]> = { 'kehikot.writer': ['parts'], 'kehikot.changes': ['selection', 'parts'] }

/** The panel with one notice, pressed, wired as `App.tsx` wires it. What the page did is recorded. */
async function press(item: Entry, kehikot: { key: string; name: string; modules: string[] }[]) {
  const did: string[] = []
  function Wired() {
    const placeGo = useGoToPlace({
      here: { project: 1, epic: 'thesis', parts: [], kehikko: 'k1' },
      targetOf: (project) => ({ project, kehikot, epics: ['thesis', 'shop'] }),
      switchProject: () => did.push('switch'),
      openKehikko: (key) => did.push(`open ${key}`),
      goto: (call) => {
        did.push(`goto ${call.epic}${call.kehikko ? ` on ${call.kehikko}` : ''}`)
        return { outcome: 'moved', why: '' }
      },
      highlight: (module) => did.push(`light ${module}`),
      reactsOf: (module) => REACTS[module],
      pick: (refs) => did.push(`pick ${refs.join(',')}`),
      outside: (one, project) => did.push(`outside ${one.id} in ${project}`),
    })
    return <InboxPanel view={viewOf([item], { onGo: (one) => placeGo.go(one, 1) })} />
  }
  const got = await mount(<Wired />)
  const button = [...got.host.querySelectorAll('button')].find((one) => one.textContent?.includes(item.label))
  if (!button) throw new Error(`no row for ${item.label}`)
  await act(async () => button.click())
  await got.done()
  return did
}

if (inChild) {
  test('a review notice, pressed, goes to the kehikko where a module reacts to picks, and picks its ref there', async () => {
    const kehikot = [
      { key: 'k1', name: 'Writing', modules: ['kehikot.writer'] },
      { key: 'k2', name: 'Review', modules: ['kehikot.changes'] },
    ]
    expect(await press(notice(), kehikot)).toEqual(['open k2', 'pick !4454'])
    /* Already there: only the pick. */
    const here = [{ key: 'k1', name: 'Writing', modules: ['kehikot.changes'] }, ...kehikot.slice(1)]
    expect(await press(notice(), here)).toEqual(['pick !4454'])
    /* Named by an epic: to that kehikko, the epic, and the pick after it (a new epic clears the selection). */
    expect(await press(notice({ place: { epic: 'shop' } }), kehikot)).toEqual(['goto shop on k2', 'pick !4454'])
  })

  test('with no kehikko that takes a pick, its page is offered: the person’s browser, or a module that shows pages', async () => {
    const did = await press(notice(), [{ key: 'k1', name: 'Writing', modules: ['kehikot.writer'] }])
    expect(did).toEqual([`outside ${notice().id} in 1`])

    /* What the page does with the link: nothing here shows pages, so an offer, never an open. */
    const url = 'https://gitlab.example.org/group/app/-/merge_requests/4454'
    const out = handed({}, { kehikko: 7, url, title: '!4454 Faster checkout', asker: { by: TN.TRACKER_NOTICES_MODULE }, at: new Date().toISOString(), readers: [] })
    expect(out.offer).toMatchObject({ kehikko: 7, url, by: TN.TRACKER_NOTICES_MODULE })
    /* A module that shows pages on the kehikko: shown there, no offer. */
    const shown = handed({}, { kehikko: 7, url, asker: { by: TN.TRACKER_NOTICES_MODULE }, at: new Date().toISOString(), readers: ['kehikot.pages'] })
    expect(shown.offer).toBeNull()
    expect(shown.next[7]?.url).toBe(url)

    const opened: string[] = []
    const added: string[] = []
    const got = await mount(
      <AddressOffer
        offer={out.offer as Offer}
        askerName={TN.TRACKER_NOTICES_BY}
        addable={[{ id: 'kehikot.pages', name: 'Pages' }]}
        onOpenOutside={(offer) => opened.push(offer.url)}
        onAdd={(_offer, module) => added.push(module)}
        onDismiss={() => {}}
      />,
    )
    const dialog = document.querySelector('[data-address-offer]')!
    expect(dialog.textContent).toContain('Tracker wants to show a page')
    expect(dialog.querySelector('[data-address-url]')?.textContent).toBe(url)
    const buttons = [...dialog.querySelectorAll('button')]
    await act(async () => buttons.find((one) => one.textContent?.includes('Open in your browser'))!.click())
    await act(async () => buttons.find((one) => one.textContent?.includes('Add Pages'))!.click())
    expect(opened).toEqual([url])
    expect(added).toEqual(['kehikot.pages'])
    await got.done()
  })

  test('a notice’s row says Tracker, whose change and which project — not “says”, not “the project”', async () => {
    const got = await mount(<InboxPanel view={viewOf([notice()])} />)
    const row = got.host.querySelector('[data-inbox-row="attention"]')!
    expect(row.textContent).toContain('Tracker')
    expect(row.textContent).not.toContain('says')
    expect(row.textContent).toContain('!4454 by Mona · review requested from you')
    expect(row.textContent).toContain('Shop')
    expect(row.textContent).not.toContain('the project')
    await got.done()
  })

  test('quick answers wrap inside the panel; a long one is cut with an ellipsis, whole in its name and a tooltip beside it', async () => {
    const long = 'Agents run on other programs too, including on our own self-hosted machines in the basement, with every tool'
    const ask = agent('place-ask:1', { module: 'kehikko', name: 'Kehikot', label: 'A session asks which epic it is for' })
    const choices = [long, 'fix(backend): ask before tools reach the app data folder', 'Not about an epic'].map((label) => ({ label, run: () => {} }))
    const got = await mount(<InboxPanel view={viewOf([ask], { choicesFor: () => choices })} />)
    const group = got.host.querySelector('[data-inbox-choices]')!
    expect(group.className.split(' ')).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'min-w-0', 'max-w-full', 'basis-full']))
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('[data-inbox-choice]')]
    expect(buttons).toHaveLength(3)
    for (const button of buttons) {
      const classes = button.className.split(' ')
      expect(classes).toEqual(expect.arrayContaining(['truncate', 'max-w-full', 'min-w-0', 'block']))
      expect(classes).not.toContain('inline-flex')
      expect(button.getAttribute('title')).toBeNull()
    }
    expect(buttons[0]!.getAttribute('aria-label')).toBe(long)
    /* Its whole text in a tooltip to the side, not under the pointer on the next line of answers. */
    await act(async () => buttons[0]!.focus())
    const tip = [...document.querySelectorAll('[data-side]')].find((one) => one.textContent?.includes(long))
    expect(tip?.getAttribute('data-side')).toBe('left')
    await got.done()
  })

  test('a question’s choices in a row are drawn the same way', async () => {
    const asked = agent('q1', {
      label: 'Which way?',
      question: { text: 'Which way?', choices: ['A very long way round that does not fit on one line of the narrowest panel at all', 'Short'], to: { module: 'kehikot.agent', session: 's1' } },
    })
    const got = await mount(<InboxPanel view={viewOf([asked], { onAnswer: async () => ({ ok: true }) })} />)
    const group = got.host.querySelector('[data-inbox-question-choices]')!
    expect(group.className.split(' ')).toEqual(expect.arrayContaining(['flex-wrap', 'max-w-full']))
    for (const button of group.querySelectorAll('button')) expect(button.className.split(' ')).toEqual(expect.arrayContaining(['truncate', 'max-w-full']))
    await got.done()
  })

  test('in This kehikko, what is about the whole project is grouped under This project, with no apology', async () => {
    const placed = agent('placed', { label: 'Tests failed', place: { kehikko: 'k1' } })
    const got = await mount(<InboxPanel view={viewOf([placed, notice()], { scope: 'here' })} />)
    const needs = got.host.querySelector('section[aria-label="needs you"]')!
    const project = got.host.querySelector('[data-inbox-group="project"]')!
    expect(needs.textContent).toContain('Tests failed')
    expect(needs.textContent).not.toContain('!4454')
    expect(project.querySelector('h3')?.textContent).toContain('This project')
    expect(project.textContent).toContain('!4454')
    expect(got.host.textContent).not.toContain('do not say which kehikko')
    expect(got.host.textContent).not.toContain('does not say which kehikko')
    /* Everywhere: one list, as before. */
    await got.done()
    const all = await mount(<InboxPanel view={viewOf([placed, notice()])} />)
    expect(all.host.querySelector('[data-inbox-group="project"]')).toBeNull()
    expect(all.host.querySelector('section[aria-label="needs you"]')!.textContent).toContain('!4454')
    await all.done()
  })
}
