import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'

import { MODULE_PORTS, inModulePorts } from 'kehikot-module-protocol/serve'

import { portToHand } from '../server/modulePorts.ts'

/**
 * Jalez/kehikko#369: a module the host started on any port took port 0, which the system fills
 * from its temporary range, and another program's "any port" server on `[::]` was handed the same
 * number; its requests to `127.0.0.1` reached the module. The host now hands a port of the
 * protocol's band instead.
 */

/** The first port the system hands out for "any port" here. */
function temporaryRangeStarts(): number {
  if (process.platform === 'darwin') {
    try {
      return Number(execFileSync('sysctl', ['-n', 'net.inet.ip.portrange.first'], { encoding: 'utf8' }).trim())
    } catch {
      return 49152
    }
  }
  return process.platform === 'linux' ? 32768 : 49152
}

describe('the port handed to a module started on any port', () => {
  test('is of the band, below the range the system hands other programs', () => {
    for (let i = 0; i < 50; i++) {
      const port = portToHand(new Set())!
      expect(port).not.toBe(0)
      expect(inModulePorts(port)).toBe(true)
      expect(port).toBeLessThan(temporaryRangeStarts())
    }
  })

  test('is never one a registration names, and wraps around the band', () => {
    expect(portToHand(new Set([MODULE_PORTS.to]), () => 0.99999999)).toBe(MODULE_PORTS.from)
    expect(portToHand(new Set([MODULE_PORTS.from, MODULE_PORTS.from + 1]), () => 0)).toBe(MODULE_PORTS.from + 2)
  })

  test('is null only when every port of the band is named', () => {
    const all = new Set<number>()
    for (let port = MODULE_PORTS.from; port <= MODULE_PORTS.to; port++) all.add(port)
    expect(portToHand(all)).toBeNull()
  })
})
