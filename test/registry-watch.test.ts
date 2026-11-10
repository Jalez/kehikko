import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { moved, watchRegistry } from '../server/registryWatch.ts'

describe('a registration that changed on disk (moved)', () => {
  const known = new Map([['kehikot.a', 'http://127.0.0.1:8010'], ['kehikot.b', 'http://127.0.0.1:8020']])

  test('the same addresses are nothing to look at', () => {
    expect(moved(known, new Map(known))).toBe(false)
  })

  test('a module that moved itself to another port is', () => {
    expect(moved(known, new Map([['kehikot.a', 'http://127.0.0.1:8011'], ['kehikot.b', 'http://127.0.0.1:8020']]))).toBe(true)
  })

  test('one registered or unregistered is', () => {
    expect(moved(known, new Map([['kehikot.a', 'http://127.0.0.1:8010']]))).toBe(true)
    expect(moved(known, new Map([...known, ['kehikot.c', 'http://127.0.0.1:8030']]))).toBe(true)
  })
})

describe('the registry directory is watched (watchRegistry)', () => {
  let dir = ''
  let close = () => {}
  afterEach(() => {
    close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('a registration rewritten in place is heard at once', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kehikot-registry-'))
    const file = join(dir, 'kehikot.a.json')
    writeFileSync(file, JSON.stringify({ id: 'kehikot.a', url: 'http://127.0.0.1:8010' }))
    let looks = 0
    close = watchRegistry(dir, () => looks++, 30)
    await Bun.sleep(50)
    /* What a module moving itself does: write beside, rename into place. */
    writeFileSync(`${file}.tmp`, JSON.stringify({ id: 'kehikot.a', url: 'http://127.0.0.1:8011' }))
    renameSync(`${file}.tmp`, file)
    const until = Date.now() + 2000
    while (looks === 0 && Date.now() < until) await Bun.sleep(20)
    await Bun.sleep(100)
    expect(looks).toBeGreaterThanOrEqual(1)
  })

  test('a directory that is not there is not an error', () => {
    close = watchRegistry(join(tmpdir(), 'kehikot-no-such-registry-dir-x'), () => {})
    expect(typeof close).toBe('function')
  })
})
