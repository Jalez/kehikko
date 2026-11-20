import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MODULE_PORTS } from 'kehikot-module-protocol/serve'

/*
 * A drive's scratch host leaves nothing running and takes none of the person's ports: eighty modules
 * started by two drives were found still running two days later, one of them on the port the person's
 * own Source module is registered at, which then could not start.
 */
const DEV = join(import.meta.dirname, '..', 'dev')

describe('what a drive leaves behind', () => {
  test('a detached process running inside a folder the drive owns is stopped', async () => {
    const { stopInside } = (await import('../dev/scratch-host.mjs')) as { stopInside(roots: string[]): number }
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-owned-')))
    /* As the host starts a module: detached, in its own process group, from a folder under the drive's. */
    const child = spawn('sleep', ['30'], { cwd: dir, detached: true, stdio: 'ignore' })
    child.unref()
    await new Promise((done) => setTimeout(done, 200))
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(alive(child.pid!)).toBe(true)
    expect(stopInside([dir])).toBeGreaterThanOrEqual(1)
    await new Promise((done) => setTimeout(done, 300))
    expect(alive(child.pid!)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('scratch ports never fall in the app’s own module band', () => {
    const text = readFileSync(join(DEV, 'scratch-host.mjs'), 'utf8')
    const from = Number(/const PORTS_FROM = (\d+)/.exec(text)?.[1])
    const span = Number(/const PORTS_SPAN = (\d+)/.exec(text)?.[1])
    expect(from > MODULE_PORTS.to || from + span - 1 < MODULE_PORTS.from).toBe(true)
    /* And below every system's temporary range (Linux starts at 32768). */
    expect(from + span - 1).toBeLessThan(32768)
  })

  test('every drive that makes a folder of its own hands it to owns(), so what runs there is stopped', () => {
    const unowned = readdirSync(DEV)
      .filter((name) => name.endsWith('.drive.mjs'))
      .filter((name) => /mkdtempSync\(/.test(readFileSync(join(DEV, name), 'utf8')))
      .filter((name) => !/owns\(realpathSync\(mkdtempSync\(|owns\(mkdtempSync\(/.test(readFileSync(join(DEV, name), 'utf8')))
    expect(unowned).toEqual([])
  })
})
