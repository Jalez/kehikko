import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { STARTING_FOR_MS } from '../server/lifecycle.ts'
import { Wakes, type News } from '../server/wake.ts'
import { MISSED_NEWS_MS, stillMoving } from '../src/host/looks.ts'
import { newerReading, registryIn, type RegistryView } from '../src/host/registry.ts'

/*
 * A quiet start: the page reads the modules once on arriving and then only when the host says
 * something changed, and the host's news that a module it started is up carries the reading. Monitor
 * on 0.1.72 showed the page asking `/host/modules` 33 times in 9.1 s after the app started, while it
 * looked every 1.5 s for as long as anything said "starting". `dev/cold-start.drive.mjs` counts the
 * whole start over plain HTTP (`test/cold-start.test.ts`), and with the real page on bee.
 */

const view = (swept: number | undefined, lifecycle?: string): RegistryView =>
  ({ swept, presences: [{ id: 'kehikot.a', lifecycle }], sweep: { dir: '', rejected: [] }, protocol: 2 }) as unknown as RegistryView

describe('the reading the page takes', () => {
  test('is checked the same way from a look and from the news', () => {
    expect(registryIn(view(3))).not.toBeNull()
    expect(registryIn({ presences: 'no' })).toBeNull()
    expect(registryIn(null)).toBeNull()
    expect(registryIn({ ...view(3), swept: 1.5 })).toBeNull()
  })

  test('an older reading landing after a newer one is not taken', () => {
    expect(newerReading(null, view(1))).toBe(true)
    expect(newerReading(view(4), view(3))).toBe(false)
    expect(newerReading(view(4), view(4))).toBe(true)
    expect(newerReading(view(4), view(5))).toBe(true)
    /* An older host numbers none. */
    expect(newerReading(view(undefined), view(1))).toBe(true)
    expect(newerReading(view(4), view(undefined))).toBe(true)
  })
})

describe('looking for news that was missed', () => {
  test('waits out the host saying "starting"', () => {
    expect(MISSED_NEWS_MS).toBeGreaterThan(STARTING_FOR_MS)
  })

  test('only while something is moving', () => {
    expect(stillMoving(null)).toBe(false)
    expect(stillMoving(view(1))).toBe(false)
    expect(stillMoving(view(1, 'asleep'))).toBe(false)
    expect(stillMoving(view(1, 'starting'))).toBe(true)
    expect(stillMoving({ ...view(1), pins: [{ state: 'preparing' }] } as unknown as RegistryView)).toBe(true)
  })

  test('the page has no timer that looks while modules start', () => {
    const app = readFileSync(join(import.meta.dir, '../src/App.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(app).not.toMatch(/setInterval\([^)]*look\(/)
  })
})

describe('the news that a module came up', () => {
  test('carries the reading when the host has one, and says look again when it does not', () => {
    const wakes = new Wakes()
    const heard: News[] = []
    wakes.listen((news) => heard.push(news))
    wakes.registryChanged()
    wakes.registryChanged({ swept: 7, presences: [] })
    expect(heard).toEqual([{ registry: true }, { registry: true, modules: { swept: 7, presences: [] } }])
  })
})
