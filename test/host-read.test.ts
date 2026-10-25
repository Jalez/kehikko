import { beforeEach, describe, expect, test } from 'bun:test'

import { forgetEveryRead, forgetRead, hostRead, keepRead } from '../src/host/hostRead.ts'

/*
 * One read of each host endpoint per page (`src/host/hostRead.ts`): whoever asks at load shares
 * it, a person's act reads afresh, a write's answer is what is read next, and a caller's abort
 * stops only its own wait.
 */

beforeEach(() => forgetEveryRead())

function loader() {
  let n = 0
  return { load: async () => ++n, count: () => n }
}

describe('hostRead', () => {
  test('reads at once and after are one request; fresh is another', async () => {
    const { load, count } = loader()
    const [a, b] = await Promise.all([hostRead('k', load), hostRead('k', load)])
    expect([a, b]).toEqual([1, 1])
    expect(await hostRead('k', load)).toBe(1)
    expect(await hostRead('k', load, { fresh: true })).toBe(2)
    expect(count()).toBe(2)
  })

  test('keep: false only joins what is out', async () => {
    const { load, count } = loader()
    await Promise.all([hostRead('k', load, { keep: false }), hostRead('k', load, { keep: false })])
    await hostRead('k', load, { keep: false })
    expect(count()).toBe(2)
  })

  test('a write is kept; news is forgotten', async () => {
    const { load, count } = loader()
    keepRead('k', 41)
    expect(await hostRead('k', load)).toBe(41)
    forgetRead('k')
    expect(await hostRead('k', load)).toBe(1)
    expect(count()).toBe(1)
  })

  test('a failed read is not kept', async () => {
    let n = 0
    const load = async () => {
      n += 1
      if (n === 1) throw new Error('not answering')
      return n
    }
    await expect(hostRead('k', load)).rejects.toThrow('not answering')
    expect(await hostRead('k', load)).toBe(2)
  })

  test("a caller's abort stops its own wait, not the shared read", async () => {
    let release = (_: number) => {}
    const load = () => new Promise<number>((done) => (release = done))
    const stop = new AbortController()
    const mine = hostRead('k', load, { signal: stop.signal })
    const theirs = hostRead('k', load)
    stop.abort()
    release(7)
    await expect(mine).rejects.toBeDefined()
    expect(await theirs).toBe(7)
  })
})
