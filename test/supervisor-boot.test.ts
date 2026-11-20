import { describe, expect, test } from 'bun:test'

import type { Presence } from '../server/discover.ts'
import { BOOT_READS_AT_ONCE, DEFER_FOR_MS } from '../server/startOrder.ts'
import { BOOT_READ_MS, BootWindow, type BootDeps, type Booted } from '../server/supervisor/boot.ts'
import { Sweeper } from '../server/supervisor/sweep.ts'
import type { Place, Reading } from '../server/updates.ts'

/*
 * The host's first moments (`server/supervisor/boot.ts`) and the shared sweep
 * (`server/supervisor/sweep.ts`), with the copy reads, the clock and the timers injected: nothing
 * here reads a checkout, asks a module or waits for real time.
 */

const IDS = ['kehikot.a', 'kehikot.b', 'kehikot.c', 'kehikot.d', 'kehikot.e']
const place = (id: string): Place => ({ id, name: id, dir: `/installed/${id}` }) as Place

function world(options: { autoUpdates?: boolean; installed?: string[]; needed?: string[] } = {}) {
  let now = 50_000
  const timers: { at: number; fn: () => void }[] = []
  const marks: string[] = []
  const noticed: number[] = []
  const governed: number[] = []
  const told: unknown[] = []
  const found: Reading[] = []
  const checked: string[] = []
  const reads = new Map<string, { resolve: (reading: Reading) => void; reject: (error: Error) => void }>()
  const installed = new Set(options.installed ?? IDS)
  let upAt: number | null = null
  const view: Booted = { presences: [{ id: 'kehikot.a', reached: true } as Presence] }
  let seen: Promise<Booted> | null = null

  const deps: BootDeps = {
    autoUpdates: options.autoUpdates ?? true,
    isInstalled: (id) => installed.has(id),
    registered: () => IDS,
    installedPlace: (id) => (installed.has(id) ? place(id) : null),
    readCheckout: (one) => new Promise<Reading>((resolve, reject) => void reads.set(one.id, { resolve, reject })),
    found: (reading) => void found.push(reading),
    wanted: () => ({ needed: new Set(options.needed ?? []), warm: new Map() }),
    seen: () => seen,
    notice: (_presences, at) => void noticed.push(at),
    govern: () => void governed.push(now),
    told: async (one) => void told.push(one),
    check: (one) => void checked.push(one.id),
    startup: { mark: (step) => void marks.push(step), at: () => upAt },
    now: () => now,
    after: (ms, fn) => void timers.push({ at: now + ms, fn }),
  }
  const boot = new BootWindow(deps)

  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((wake) => setImmediate(wake))
  }
  const advance = async (ms: number) => {
    const until = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > until) break
      timers.shift()
      now = next.at
      next.fn()
      await settle()
    }
    now = until
    await settle()
  }
  /** The first sweep ends: the first look is taken from it. */
  const firstSweep = async () => {
    seen = Promise.resolve(view)
    await boot.firstLook(seen)
    await settle()
  }
  /** The read of one copy lands, with a newer release or with none. */
  const land = async (id: string, newer = true) => {
    reads.get(id)!.resolve({ id, newer } as unknown as Reading)
    reads.delete(id)
    await settle()
  }
  return {
    boot, marks, noticed, governed, told, found, checked, reads, advance, firstSweep, land, settle, view,
    now: () => now,
    up: () => void (upAt = now),
  }
}

const held = (w: ReturnType<typeof world>) => IDS.filter((id) => w.boot.holds(id))

describe('the boot window', () => {
  test('with the switch off, nothing is held and nothing is read', async () => {
    const w = world({ autoUpdates: false })
    expect(held(w)).toEqual([])
    expect(w.boot.waiting).toBe(false)
    await w.firstSweep()
    expect(w.reads.size).toBe(0)
    expect(w.marks).toEqual([])
  })

  test('every installed copy is held until the first sweep, and only installed ones', async () => {
    const w = world({ installed: ['kehikot.a', 'kehikot.b'] })
    expect(w.boot.waiting).toBe(true)
    expect(held(w)).toEqual(['kehikot.a', 'kehikot.b'])
    await w.firstSweep()
    expect(w.boot.waiting).toBe(false)
    expect(w.marks[0]).toBe('auto-update first look begins')
    /* What answered is seen first: a module kept running across the restart is somebody's to stop. */
    expect(w.noticed).toEqual([w.now()])
    expect(held(w)).toEqual(['kehikot.a', 'kehikot.b'])
  })

  test('the copies on screen are read first, all together; the rest a few at a time after', async () => {
    const w = world({ needed: ['kehikot.d', 'kehikot.e'] })
    await w.firstSweep()
    expect([...w.reads.keys()].sort()).toEqual(['kehikot.d', 'kehikot.e'])
    await w.land('kehikot.d')
    /* Read: let go, its newer release queued, and the rest still wait for the other one on screen. */
    expect(w.boot.holds('kehikot.d')).toBe(false)
    expect(w.found.map((one) => one.id)).toEqual(['kehikot.d'])
    expect([...w.reads.keys()]).toEqual(['kehikot.e'])
    await w.land('kehikot.e', false)
    expect([...w.reads.keys()]).toHaveLength(BOOT_READS_AT_ONCE)
    expect([...w.reads.keys()]).toEqual(['kehikot.a', 'kehikot.b', 'kehikot.c'])
  })

  test('each copy let go is decided from the sweep in hand, and the pages told with it', async () => {
    const w = world({ needed: ['kehikot.a'] })
    await w.firstSweep()
    expect(w.governed).toEqual([])
    await w.land('kehikot.a')
    await w.advance(0)
    expect(w.governed).toHaveLength(1)
    expect(w.told).toEqual([w.view])
  })

  test('the last copy read ends the window', async () => {
    const w = world({ installed: ['kehikot.a'], needed: ['kehikot.a'] })
    await w.firstSweep()
    await w.land('kehikot.a')
    expect(w.marks).toContain('auto-update first look done')
    expect(held(w)).toEqual([])
  })

  test('a read that fails lets the copy go as it is', async () => {
    const w = world({ installed: ['kehikot.a'], needed: ['kehikot.a'] })
    await w.firstSweep()
    w.reads.get('kehikot.a')!.reject(new Error('git'))
    await w.settle()
    expect(w.boot.holds('kehikot.a')).toBe(false)
    expect(w.found).toEqual([])
    expect(w.marks).toContain('auto-update first look done')
  })

  test('the cap: after BOOT_READ_MS whatever is still held starts as it is, and a late read changes nothing', async () => {
    const w = world({ needed: ['kehikot.a'] })
    await w.firstSweep()
    await w.advance(BOOT_READ_MS - 1)
    expect(held(w)).toEqual(IDS)
    expect(w.marks).not.toContain('auto-update first look done')
    await w.advance(1)
    expect(held(w)).toEqual([])
    expect(w.marks).toContain('auto-update first look done')
    expect(w.governed).toHaveLength(1)
    await w.land('kehikot.a')
    expect(w.found).toEqual([])
  })

  test('the first look is taken once, whichever sweep came first', async () => {
    const w = world({ needed: ['kehikot.a'] })
    /* Two sweeps out at host start, both told before either has ended. */
    const first = Promise.resolve(w.view)
    await Promise.all([w.boot.firstLook(first), w.boot.firstLook(first)])
    await w.firstSweep()
    expect(w.marks.filter((one) => one === 'auto-update first look begins')).toHaveLength(1)
    expect(w.noticed).toHaveLength(1)
  })
})

describe('the release checks wait for the open kehikko', () => {
  test('held until the open kehikko is up, then run once each', async () => {
    const w = world()
    w.boot.checkWhenUp(place('kehikot.a'))
    w.boot.checkWhenUp(place('kehikot.a'))
    w.boot.checkWhenUp(place('kehikot.b'))
    expect(w.checked).toEqual([])
    w.up()
    w.boot.runHeldChecks()
    expect(w.checked).toEqual(['kehikot.a', 'kehikot.b'])
    expect(w.marks).toEqual(['held release checks run'])
    w.boot.runHeldChecks()
    expect(w.checked).toHaveLength(2)
    /* Up: a check asked from now on goes at once. */
    w.boot.checkWhenUp(place('kehikot.c'))
    expect(w.checked).toEqual(['kehikot.a', 'kehikot.b', 'kehikot.c'])
  })

  test('DEFER_FOR_MS after the host began they go anyway, with no kehikko up', async () => {
    const w = world()
    w.boot.start()
    w.boot.checkWhenUp(place('kehikot.a'))
    await w.advance(DEFER_FOR_MS - 1)
    expect(w.checked).toEqual([])
    await w.advance(1)
    expect(w.checked).toEqual(['kehikot.a'])
    /* And from then on at once. */
    w.boot.checkWhenUp(place('kehikot.b'))
    expect(w.checked).toEqual(['kehikot.a', 'kehikot.b'])
  })
})

describe('the sweep', () => {
  function sweeper(refresh = true) {
    const surveys: { kept: boolean; resolve: (view: Booted) => void }[] = []
    const began: Promise<Booted>[] = []
    const one = new Sweeper<Booted>({
      survey: (kept) => new Promise<Booted>((resolve) => void surveys.push({ kept, resolve })),
      refresh: () => refresh,
      began: (running) => void began.push(running),
      now: () => 7,
    })
    return { one, surveys, began }
  }
  const view = (holds?: string[]): Booted => ({ presences: [{ id: 'kehikot.a', module: { holds } } as unknown as Presence] })

  test('two asks while one is out share it, and the one that ended is what is seen', async () => {
    const s = sweeper()
    const first = s.one.sweep()
    expect(s.one.sweep()).toBe(first)
    expect(s.one.seen).toBeNull()
    expect(s.surveys).toHaveLength(1)
    expect(s.began).toEqual([first])
    s.surveys[0]!.resolve(view(['shells']))
    await first
    expect(s.one.sweeping).toBeNull()
    expect(s.one.seen).toBe(first)
    expect(s.one.holdsSaid.get('kehikot.a')).toEqual(['shells'])
  })

  test('a sweep of what is kept shares any sweep out; an ordinary one waits for a kept one and asks', async () => {
    const s = sweeper()
    const kept = s.one.sweep({ kept: true })
    expect(s.surveys[0]!.kept).toBe(true)
    const ordinary = s.one.sweep()
    expect(ordinary).not.toBe(kept)
    s.surveys[0]!.resolve(view())
    await kept
    await new Promise((wake) => setImmediate(wake))
    expect(s.surveys).toHaveLength(2)
    expect(s.surveys[1]!.kept).toBe(false)
    expect(s.one.sweep({ kept: true })).toBe(s.one.sweeping!)
  })

  test("a press's fresh sweep waits for the one out and asks again", async () => {
    const s = sweeper(true)
    const out = s.one.sweep()
    const fresh = s.one.sweep(true)
    expect(fresh).not.toBe(out)
    s.surveys[0]!.resolve(view())
    await out
    await new Promise((wake) => setImmediate(wake))
    expect(s.surveys).toHaveLength(2)
  })

  test('sweepSince shares a sweep that began at or after the moment, and starts one otherwise', async () => {
    const s = sweeper()
    const out = s.one.sweep()
    expect(s.one.sweepSince(7)).toBe(out)
    s.one.sweepSince(8)
    s.surveys[0]!.resolve(view())
    await out
    await new Promise((wake) => setImmediate(wake))
    expect(s.surveys).toHaveLength(2)
  })
})
