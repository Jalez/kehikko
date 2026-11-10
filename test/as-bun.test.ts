import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { asBun } from '../server/asBun.ts'

describe('the compiled host given arguments runs them as Bun (asBun)', () => {
  const main = '/$bunfs/root/kehikko-host'

  test("a script a session's status line runs is run, not a second host", () => {
    expect(asBun(['bun', main, './statusline-line.mjs'], main)).toEqual(['./statusline-line.mjs'])
    expect(asBun(['bun', main, 'run', 'serve.ts', '--flag'], main)).toEqual(['run', 'serve.ts', '--flag'])
  })

  test('with no arguments it is the host the desktop shell started', () => {
    expect(asBun(['bun', main], main)).toBeNull()
  })

  test('a host run from a checkout is never compiled, whatever it is given', () => {
    expect(asBun(['/usr/local/bin/bun', '/repo/server/server.ts', 'x'], '/repo/server/server.ts')).toBeNull()
  })

  test('a Windows build is compiled too', () => {
    expect(asBun(['bun', 'B:\\~BUN\\root\\kehikko-host.exe', 'x.mjs'], 'B:\\~BUN\\root\\kehikko-host.exe')).toEqual(['x.mjs'])
  })

  test('the sidecar entry asks before it loads the server', () => {
    const script = readFileSync(join(import.meta.dir, '..', 'dev', 'build-sidecar.ts'), 'utf8')
    const guard = script.indexOf('asBun(process.argv, Bun.main)')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(script.indexOf("join(ROOT, 'server', 'server.ts')"))
  })
})
