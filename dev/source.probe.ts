/* What each registered module's header would say about its branch right now. Read-only. */
import { readRegistrations } from '../server/registrations.ts'
import { sourceOf } from '../server/source.ts'
import { systemProcesses } from '../server/takeover.ts'
import { offMain, branchWord } from '../src/host/source.ts'

const { registrations } = await readRegistrations()
for (const r of registrations) {
  const port = Number(new URL(r.url).port)
  const answering = (await systemProcesses.listenerOf(port)) !== null
  const source = await sourceOf(r.id, r.url, r.dir, answering, systemProcesses)
  if (!source) {
    console.log(`${r.id}: unreadable`)
    continue
  }
  const why = offMain(source)
  console.log(`${r.id}: ${branchWord(source)}${why.length ? `  ⚠ ${why.join('; ')} (${source.dir})` : ''}`)
}
