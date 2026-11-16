import { expect, test } from 'bun:test'

import { LISTENERS_MS, ListenerTable } from '../server/trafficProcesses.ts'

/*
 * Which process listens on which port, for a module somebody started by hand (Jalez/kehikko#384):
 * asked of `lsof` at most once per `LISTENERS_MS`, however often a look wants it, and once for
 * looks that want it together. Every program here is stubbed.
 */

const LSOF = 'p801\nn*:8021\np500\nn127.0.0.1:4180\n'

function stubbed() {
  let now = 1_000_000
  const ran: string[][] = []
  const table = new ListenerTable({
    run: async (argv) => {
      ran.push(argv)
      return LSOF
    },
    now: () => now,
  })
  return { table, ran, later: (ms: number) => void (now += ms) }
}

test('the listeners are read once and kept: looks a moment apart start no lsof of their own', async () => {
  const { table, ran, later } = stubbed()
  expect((await table.read()).get(8021)).toBe(801)
  later(3000)
  await table.read()
  later(3000)
  expect((await table.read()).get(4180)).toBe(500)
  expect(ran).toEqual([['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn']])
})

test('looks that want the listeners together share one lsof', async () => {
  const { table, ran } = stubbed()
  await Promise.all([table.read(), table.read(), table.read()])
  expect(ran).toHaveLength(1)
})

test('once they are older than LISTENERS_MS, the next look reads them again', async () => {
  const { table, ran, later } = stubbed()
  await table.read()
  later(LISTENERS_MS)
  await table.read()
  expect(ran).toHaveLength(2)
})
