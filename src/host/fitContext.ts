import { contextSchema, type ModuleContext } from 'kehikot-module-protocol'

/**
 * A context as every page can read it: within the protocol's limits.
 *
 * A page reads the greeting and every `kehikot.context` with its own copy of
 * `hostMessageSchema`, and that schema caps what it carries (`LIMITS`: the
 * prompt at 8 KiB, the selection at `REFS`, the containers at `CONTAINERS`…).
 * Those caps have not moved between protocol versions, so a context within
 * this host's own schema is within every older page's too, and the fields an
 * older page does not know it strips.
 *
 * What a page does with a greeting over a cap depends on its version. From
 * protocol 2.93.0 it says so (`kehikot.page.error`, `where: 'greeting'`).
 * Before that it DROPS it without a word, and the container waits a minute and
 * reports a page that "has said nothing". A canvas with enough modules on it
 * composed a prompt over 8 KiB (`promptFor`), and every page on it built
 * before 2.93.0 went quiet, reload after reload.
 *
 * So the host keeps its side of the contract here, for every module whatever
 * protocol it was built on: whatever its own schema calls too big — a string
 * or a list — is cut to the limit, and the rest of the context goes as it is.
 * The paths cut are returned, so the caller can say it once.
 */
export function fitContext(context: ModuleContext): { context: ModuleContext; cut: string[] } {
  let checked = contextSchema.safeParse(context)
  if (checked.success) return { context, cut: [] }

  const fitted = structuredClone(context) as unknown as Record<string, unknown>
  const cut: string[] = []
  /* One pass cuts every field the schema named; a second catches a field inside one that was
     itself cut (a container within a list of too many). Bounded, so a schema that refuses for
     another reason cannot loop. */
  for (let pass = 0; pass < 3 && !checked.success; pass++) {
    let changed = false
    for (const issue of checked.error.issues) {
      if (issue.code !== 'too_big' || (typeof issue.maximum !== 'number' && typeof issue.maximum !== 'bigint')) continue
      const max = Number(issue.maximum)
      const parent = at(fitted, issue.path.slice(0, -1))
      const key = issue.path[issue.path.length - 1]
      if (parent === null || key === undefined) continue
      const value = (parent as Record<string | number, unknown>)[key]
      if (typeof value === 'string' && value.length > max) {
        ;(parent as Record<string | number, unknown>)[key] = value.slice(0, max)
      } else if (Array.isArray(value) && value.length > max) {
        ;(parent as Record<string | number, unknown>)[key] = value.slice(0, max)
      } else continue
      changed = true
      const path = issue.path.join('.')
      if (!cut.includes(path)) cut.push(path)
    }
    if (!changed) break
    checked = contextSchema.safeParse(fitted)
  }
  return { context: fitted as unknown as ModuleContext, cut }
}

/** The object or array at `path` under `root`, or null when there is none. */
function at(root: unknown, path: readonly (string | number)[]): object | null {
  let here: unknown = root
  for (const step of path) {
    if (here === null || typeof here !== 'object') return null
    here = (here as Record<string | number, unknown>)[step]
  }
  return here !== null && typeof here === 'object' ? here : null
}
