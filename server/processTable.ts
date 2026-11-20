import { LIMITS } from 'kehikot-module-protocol'

import { untraced } from './trafficContext.ts'

/**
 * Reading this computer's process table and listening ports with macOS's own tools (`ps`, `lsof`),
 * for the caller lookup (`callers.ts`) and the sampler (`trafficProcesses.ts`) alike. Its own file so
 * that neither of those imports the other for it.
 */

export interface Proc {
  pid: number
  ppid: number
  pgid: number
  name: string
}

/** `ps -A -o pid=,ppid=,pgid=,ucomm=`. */
export function parsePs(text: string): Proc[] {
  const out: Proc[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line)
    if (match) out.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), name: (match[4] ?? '').slice(0, LIMITS.TRAFFIC_KIND) })
  }
  return out
}

/** `lsof -nP -iTCP -sTCP:LISTEN -F pn`: which pid listens on each port. */
export function parseListeners(text: string): Map<number, number> {
  const out = new Map<number, number>()
  let pid = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) {
      const port = Number(line.slice(line.lastIndexOf(':') + 1))
      if (Number.isInteger(port) && port > 0 && !out.has(port)) out.set(port, pid)
    }
  }
  return out
}

export async function runQuiet(argv: string[]): Promise<string | null> {
  return untraced(async () => {
    try {
      const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
      const timer = setTimeout(() => child.kill(), 5000)
      const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
      clearTimeout(timer)
      return code === 0 ? text : null
    } catch {
      return null
    }
  })
}
