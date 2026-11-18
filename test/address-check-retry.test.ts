import { afterEach, describe, expect, test } from 'bun:test'

import {
  addressesUsable,
  checkAddresses,
  framesWaiting,
  frameUseIn,
  onAddresses,
  onAddressesChange,
  resetAddressCheck,
  RETRY_MS,
  settledLine,
  settleFrames,
  TRY_TIMEOUT_MS,
  whyFramed,
  type FrameUse,
} from '@/host/addressCheck.ts'

/*
 * One slow answer must not decide the session (`src/host/addressCheck.ts`). At a restart on a busy
 * machine the first check of a stable frame address timed out, and every frame stayed on its
 * module's port until the app was restarted again. A try that fails for a reason that can pass is
 * made again with backoff; a later pass moves frames onto their stable addresses, never under the
 * person.
 */

const SAID = { on: true, frames: true, check: { url: 'http://at--self-check.kehikot.localhost:4170/.well-known/kehikot-host-check', host: 'nonce' } }
const timedOut = () => Promise.reject(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }))

/** A host whose check answers as `answers` says, try by try; the last repeats. */
function host(answers: Array<() => Response | Promise<Response>>, said: unknown = SAID) {
  const posted: Array<{ ok: boolean; why: string | null }> = []
  let tried = 0
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/host/module-addresses') return Response.json(said)
    if (url === '/host/module-addresses/check') {
      posted.push(JSON.parse(String(init?.body)))
      return Response.json({ ok: true })
    }
    const answer = answers[Math.min(tried, answers.length - 1)]!
    tried += 1
    return answer()
  }) as typeof fetch
  return { fetcher, posted, tries: () => tried }
}

/** Timers the test runs by hand: what was scheduled, and after how long. */
function timers() {
  const waiting: Array<{ ms: number; then: () => void }> = []
  return {
    waiting,
    later: (then: () => void, ms: number) => {
      const one = { ms, then }
      waiting.push(one)
      return () => {
        const at = waiting.indexOf(one)
        if (at >= 0) waiting.splice(at, 1)
      }
    },
    /** Run the next one and let its try finish. */
    async next() {
      const one = waiting.shift()
      if (!one) throw new Error('nothing scheduled')
      one.then()
      for (let n = 0; n < 20; n++) await Promise.resolve()
      await new Promise((done) => setTimeout(done, 0))
      return one.ms
    },
  }
}

const RAW = { monitor: 'http://127.0.0.1:7920', terminal: 'http://127.0.0.1:7930', notes: 'http://127.0.0.1:7940', kanban: 'http://127.0.0.1:7950' }
const view = {
  presences: [
    { id: 'kehikot.monitor', module: { id: 'kehikot.monitor', entry: `${RAW.monitor}/app`, address: 'http://monitor.kehikot.localhost:4170' } },
    { id: 'kehikot.terminal', module: { id: 'kehikot.terminal', entry: `${RAW.terminal}/app`, address: 'http://terminal.kehikot.localhost:4170', holds: ['live-sessions'] } },
    { id: 'kehikot.notes', module: { id: 'kehikot.notes', entry: `${RAW.notes}/app`, address: 'http://notes.kehikot.localhost:4170' } },
    { id: 'kehikot.kanban', module: { id: 'kehikot.kanban', entry: `${RAW.kanban}/app`, address: 'http://kanban.kehikot.localhost:4170' } },
  ],
}
const modules = view.presences.map((presence) => presence.module)
const entryOf = (read: typeof view, id: string) => read.presences.find((presence) => presence.id === id)!.module.entry

afterEach(() => resetAddressCheck())

describe('a check that timed out is tried again', () => {
  test('a timeout, then a pass: frames move onto their stable addresses, each when it is not in use', async () => {
    const { fetcher, posted } = host([timedOut, () => Response.json({ host: 'nonce' })])
    const clock = timers()
    const lines: string[] = []
    let heard = 0
    onAddressesChange(() => (heard += 1))

    const first = await checkAddresses(fetcher, (_, line) => lines.push(line), () => 0, clock.later)
    expect(first.usable).toBe(false)
    expect(onAddresses(view)).toBe(view)
    expect(clock.waiting.map((one) => one.ms)).toEqual([RETRY_MS[0]!])
    expect(lines[0]).toContain('did not answer within 2.5 s; tries again in 2 s')

    await clock.next()
    expect(addressesUsable()).toBe(true)
    expect(heard).toBe(1)
    expect(lines[1]).toStartWith('try 2: stable addresses usable')
    expect(lines[1]).toContain('(timeout 5000 ms)')
    expect(posted.at(-1)).toEqual({ ok: true, why: null })
    expect(clock.waiting).toHaveLength(0)

    /* Before the page settled its frames, nothing moves: a reading in between keeps every frame where it is. */
    expect(entryOf(onAddresses(view), 'kehikot.monitor')).toBe(`${RAW.monitor}/app`)

    /* Monitor's frame is on the page and idle; the terminal's is idle but holds live sessions;
       Notes has the focus; Kanban has no frame on the page. */
    const use: Record<string, FrameUse> = { [RAW.monitor]: 'idle', [RAW.terminal]: 'idle', [RAW.notes]: 'busy', [RAW.kanban]: 'none' }
    const settled = settleFrames(modules, (origin) => use[origin] ?? 'none')
    expect(settled.moved).toEqual(['kehikot.monitor', 'kehikot.kanban'])
    expect(settled.kept).toEqual([
      { id: 'kehikot.terminal', why: 'a reload would end its live sessions' },
      { id: 'kehikot.notes', why: 'it has the focus' },
    ])
    expect(settledLine(settled)).toBe(
      'frames moved onto their stable addresses: kehikot.monitor, kehikot.kanban; kept on their ports for now: kehikot.terminal (a reload would end its live sessions), kehikot.notes (it has the focus)',
    )

    const read = onAddresses(view)
    expect(entryOf(read, 'kehikot.monitor')).toBe('http://monitor.kehikot.localhost:4170/app')
    expect(entryOf(read, 'kehikot.kanban')).toBe('http://kanban.kehikot.localhost:4170/app')
    expect(entryOf(read, 'kehikot.terminal')).toBe(`${RAW.terminal}/app`)
    expect(entryOf(read, 'kehikot.notes')).toBe(`${RAW.notes}/app`)
    expect(whyFramed({ address: 'http://notes.kehikot.localhost:4170' })).toContain('until it is not in use')
    expect(framesWaiting()).toBe(true)

    /* The person leaves Notes: it moves at the next settling. The terminal moves once its frame is gone. */
    use[RAW.notes] = 'idle'
    expect(settleFrames(read.presences.map((presence) => presence.module), (origin) => use[origin] ?? 'none').moved).toEqual(['kehikot.notes'])
    use[RAW.terminal] = 'none'
    expect(settleFrames(onAddresses(view).presences.map((presence) => presence.module), (origin) => use[origin] ?? 'none').moved).toEqual(['kehikot.terminal'])
    expect(framesWaiting()).toBe(false)
    const all = onAddresses(view)
    for (const presence of all.presences) expect(new URL(presence.module.entry).hostname).toEndWith('.kehikot.localhost')
  })

  test('a check that never answers keeps being tried, with backoff and longer timeouts, and the frames keep working on their ports', async () => {
    const { fetcher, posted, tries } = host([timedOut])
    const clock = timers()
    const lines: string[] = []
    await checkAddresses(fetcher, (_, line) => lines.push(line), () => 0, clock.later)
    const waits: number[] = []
    for (let n = 0; n < 6; n++) waits.push(await clock.next())

    expect(waits).toEqual([2_000, 5_000, 15_000, 60_000, 60_000, 60_000])
    expect(tries()).toBe(7)
    expect(clock.waiting.map((one) => one.ms)).toEqual([60_000])
    expect(lines.map((line) => /\(timeout (\d+) ms\)/.exec(line)?.[1])).toEqual(['2500', '5000', '10000', '15000', '15000', '15000', '15000'])
    expect(TRY_TIMEOUT_MS.at(-1)).toBe(15_000)
    /* Functional all along: every frame on its module's own port, as read. */
    expect(onAddresses(view)).toBe(view)
    expect(addressesUsable()).toBe(false)
    /* Told to the host when the reason changes (each longer timeout is said once), not on every try. */
    expect(posted.map((one) => one.why?.match(/within ([\d.]+) s/)?.[1])).toEqual(['2.5', '5', '10', '15'])
    expect(posted.every((one) => !one.ok)).toBe(true)
  })

  test('what the host said is final: off, or frames may not have addresses, is not asked again', async () => {
    for (const said of [{ on: false, frames: false }, { on: true, frames: false, why: 'could not listen on [::1]' }]) {
      resetAddressCheck()
      const clock = timers()
      await checkAddresses(host([timedOut], said).fetcher, () => {}, () => 0, clock.later)
      expect(clock.waiting).toHaveLength(0)
    }
  })

  test('a first try that passes: frames go on their addresses at once, and there is nothing to settle', async () => {
    const clock = timers()
    await checkAddresses(host([() => Response.json({ host: 'nonce' })]).fetcher, () => {}, () => 0, clock.later)
    expect(entryOf(onAddresses(view), 'kehikot.notes')).toBe('http://notes.kehikot.localhost:4170/app')
    expect(settleFrames(modules, () => 'busy')).toEqual({ moved: [], kept: [] })
    expect(framesWaiting()).toBe(false)
  })
})

describe("what a page's frames are doing", () => {
  test('a frame on the origin is there, and busy when it has the focus', () => {
    const a = { src: 'http://127.0.0.1:7920/app?theme=dark' }
    const b = { src: 'http://notes.kehikot.localhost:4170/app' }
    const doc = { baseURI: 'http://127.0.0.1:4170/', activeElement: null as unknown, querySelectorAll: () => [a, b] }
    const use = frameUseIn(doc as never)
    expect(use('http://127.0.0.1:7920')).toBe('idle')
    expect(use('http://127.0.0.1:7999')).toBe('none')
    doc.activeElement = a
    expect(use('http://127.0.0.1:7920')).toBe('busy')
  })
})
