import { describe, expect, test } from 'bun:test'
import { look, neededOf, readHost, reportOf, type Entry, type Latest } from '../dev/protocol-ahead.ts'

const pkg = (pin: string) => JSON.stringify({ dependencies: { 'kehikot-module-protocol': `git+ssh://git@github.com/x/y.git#v${pin}` } })
const entries: Entry[] = [
  { id: 'a', name: 'Alpha', repo: 'o/alpha' },
  { id: 'b', name: 'Beta', repo: 'o/beta' },
  { id: 'c', name: 'Gamma', repo: 'o/gamma' },
  { id: 'd', name: 'Delta', repo: 'o/delta' },
]
const releases: Record<string, Latest | null> = {
  'o/alpha': { tag: 'v1.14.1', pkg: pkg('2.37.0') },
  'o/beta': { tag: 'v2.0.0', pkg: pkg('2.36.0') },
  'o/gamma': { tag: 'v0.3.0', pkg: pkg('3.0.0') },
  'o/delta': null,
}
const latest = async (repo: string) => {
  if (!(repo in releases)) throw new Error('offline')
  return releases[repo]!
}

describe('a module release that needs a protocol the host does not speak', () => {
  test('is found by its pin; equal and older pins and unreadable ones are not', async () => {
    const found = await look('2.36.0', entries, latest)
    expect(found.ahead.map((one) => one.name)).toEqual(['Alpha', 'Gamma'])
    expect(found.unread).toEqual(['Delta'])
    expect(neededOf(found)).toBe('3.0.0')
  })

  test('a throwing read is unread, never ahead', async () => {
    const found = await look('2.36.0', [{ id: 'x', name: 'Xi', repo: 'o/none' }], latest)
    expect(found).toEqual({ host: '2.36.0', ahead: [], unread: ['Xi'] })
    expect(reportOf(found)).toBeNull()
  })

  test('the issue says the host protocol, the first release and what to do', async () => {
    const one = reportOf(await look('2.36.0', entries.slice(0, 1), latest))!
    expect(one.title).toBe('Kehikot speaks protocol 2.36 but Alpha 1.14.1 needs 2.37: bump the host pin')
    expect(one.body).toContain('- Alpha 1.14.1 (o/alpha) pins protocol 2.37')
    expect(one.body).toContain('release the app first')
    const two = reportOf(await look('2.36.0', entries, latest))!
    expect(two.title).toBe('Kehikot speaks protocol 2.36 but Alpha 1.14.1 and 1 more needs 3.0: bump the host pin')
    expect(two.body).toContain('Not read this time: Delta.')
  })

  test('once the host has caught up there is nothing to say', async () => {
    expect(reportOf(await look('3.0.0', entries, latest))).toBeNull()
  })

  test('the host reads its own pin and the list', () => {
    const read = readHost()
    expect(read.host).toMatch(/^\d+\.\d+\.\d+$/)
    expect(read.entries.length).toBeGreaterThan(0)
  })
})
