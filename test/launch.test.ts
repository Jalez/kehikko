import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RUN_SCRIPT, startable } from '../server/launch.ts'
import type { Registration } from '../server/registrations.ts'

/**
 * Whether a module can be started, and every way the answer is no.
 *
 * `start` itself spawns a process and is not exercised here — what is worth
 * testing is the gate in front of it, because every rule it enforces is a way
 * this could have become something other than "run the script the owner put in
 * the directory they named".
 */

const made: string[] = []
function dir(): string {
  const path = join(tmpdir(), `kehikko-launch-${process.pid}-${made.length}`)
  rmSync(path, { recursive: true, force: true })
  mkdirSync(path, { recursive: true })
  made.push(path)
  return path
}
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

const registration = (over: Partial<Registration> = {}): Registration => ({
  id: 'roadmap.thing',
  url: 'http://127.0.0.1:7999',
  file: '/somewhere/roadmap.thing.json',
  ...over,
})

describe('a module the host can start', () => {
  test('a directory with an executable run.sh in it', () => {
    const root = dir()
    writeFileSync(join(root, RUN_SCRIPT), '#!/bin/sh\necho hello\n')
    chmodSync(join(root, RUN_SCRIPT), 0o755)

    const can = startable(registration({ dir: root }))
    expect(can.ok).toBe(true)
    if (!can.ok) return
    expect(can.run.script).toBe(join(root, RUN_SCRIPT))
    expect(can.run.dir).toBe(root)
    /* The port comes from the registered url, so the module listens where the
       host will look for it rather than wherever it defaults to. */
    expect(can.run.port).toBe(7999)
    expect(can.run.command).toBe(`PORT=7999 ${join(root, RUN_SCRIPT)}`)
  })

  test('a url with no port asks for nothing and says so in the command', () => {
    const root = dir()
    writeFileSync(join(root, RUN_SCRIPT), '#!/bin/sh\n')
    chmodSync(join(root, RUN_SCRIPT), 0o755)

    const can = startable(registration({ dir: root, url: 'http://127.0.0.1' }))
    expect(can.ok).toBe(true)
    if (!can.ok) return
    expect(can.run.port).toBeNull()
    expect(can.run.command).toBe(join(root, RUN_SCRIPT))
  })
})

describe('every no is a sentence naming what to fix', () => {
  test('no registration at all', () => {
    const can = startable(null)
    expect(can.ok).toBe(false)
  })

  test('registered without a directory is not a fault', () => {
    /* The commonest case: a module somebody starts themselves. The container should
       say so rather than offering a button that cannot work. */
    const can = startable(registration())
    expect(can.ok).toBe(false)
    if (can.ok) return
    expect(can.why).toContain('without a directory')
    expect(can.why).toContain('roadmap.thing.json')
  })

  test('a relative directory is refused rather than resolved against wherever the host started', () => {
    const can = startable(registration({ dir: 'modules/thing' }))
    expect(can.ok).toBe(false)
    if (can.ok) return
    expect(can.why).toContain('absolute')
  })

  test('a directory that is not there', () => {
    const can = startable(registration({ dir: join(tmpdir(), 'kehikko-not-here-at-all') }))
    expect(can.ok).toBe(false)
    if (can.ok) return
    expect(can.why).toContain('not there')
  })

  test('a directory with no run.sh', () => {
    const can = startable(registration({ dir: dir() }))
    expect(can.ok).toBe(false)
    if (can.ok) return
    expect(can.why).toContain(RUN_SCRIPT)
  })

  test('a run.sh that is not executable says which of the two it failed', () => {
    /* "No such file" and "not executable" send a person to different fixes, so
       they are different sentences. */
    const root = dir()
    writeFileSync(join(root, RUN_SCRIPT), '#!/bin/sh\n')
    chmodSync(join(root, RUN_SCRIPT), 0o644)

    const can = startable(registration({ dir: root }))
    expect(can.ok).toBe(false)
    if (can.ok) return
    expect(can.why).toContain('not executable')
    expect(can.why).toContain('chmod +x')
  })

  test('a file where the directory should be', () => {
    const root = dir()
    const file = join(root, 'a-file')
    writeFileSync(file, 'not a directory')
    const can = startable(registration({ dir: file }))
    expect(can.ok).toBe(false)
    if (can.ok) return
    expect(can.why).toContain('not a directory')
  })
})

describe('the script is one name, and it stays inside', () => {
  test('a directory that climbs out cannot reach a script above it', () => {
    /* A registration is a file somebody wrote, so this is not defence against
       an attacker so much as against a path that quietly means something else.
       `resolve` collapses the `..` before anything is run, and what is checked
       is the collapsed path. */
    const root = dir()
    const climbing = join(root, 'inner', '..', '..')
    const can = startable(registration({ dir: climbing }))
    if (can.ok) {
      /* If it resolves to a real directory with a run.sh, the script must still
         be the one inside THAT directory and nowhere else. */
      expect(can.run.script).toBe(join(can.run.dir, RUN_SCRIPT))
      expect(can.run.script.startsWith(can.run.dir)).toBe(true)
    } else {
      expect(can.why.length).toBeGreaterThan(0)
    }
  })

  test('the script name is not something a registration can choose', () => {
    /* There is no field for it. A registration names a directory; the host
       names the script. That is what keeps a registration from becoming a
       place to write a command line. */
    const root = dir()
    writeFileSync(join(root, RUN_SCRIPT), '#!/bin/sh\n')
    chmodSync(join(root, RUN_SCRIPT), 0o755)
    const can = startable(
      registration({ dir: root, ...({ run: 'anything-else.sh', script: '/bin/sh' } as object) }),
    )
    expect(can.ok).toBe(true)
    if (!can.ok) return
    expect(can.run.script).toBe(join(root, RUN_SCRIPT))
  })
})
