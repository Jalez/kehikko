import { resultSchemaFor } from 'roadmap-module-protocol'

/**
 * Hold the host's own answers to the shapes the protocol names.
 *
 * The package describes the answer to a few methods, and is careful about why:
 * most answers are a host's material and no two hosts hold the same amount of
 * it, but `epics.list` is the front door — every other question takes a slug
 * and this is the only place to get one — and `view.goto` and `projects.pick`
 * report the outcome of an act the protocol itself defines, where "you are now
 * looking at it" and "there is nothing by that name" send a person to different
 * places.
 *
 * `projects.pick` is the one where parsing the host's own answer is more than
 * hygiene. Its three outcomes are arranged so that a module cannot tell "this
 * host holds no projects" from "I would rather not", and the schema is what
 * enforces the arrangement: a host that filled in `project` beside a
 * `cancelled`, or invented a fourth outcome, is refused here rather than
 * teaching a framed program something about the disk.
 *
 * The package also says, correctly, that running its schema is a convenience
 * and not the check, because the check has to run on the deciding side. That is
 * an argument about what a MODULE should do with what a host sent it. This
 * function is the host doing the same thing to itself, and it is worth doing
 * for a different reason: the package is under active development beside this
 * host, and a shape that changes there and not here would leave this host
 * confidently answering the front door in a shape nobody can read. Parsing its
 * own answer is how the host finds that out — here, in one function, rather
 * than as a module author's bug report.
 *
 * A method with no schema is UNSPECIFIED, which the package is explicit about:
 * absence does not mean "expects nothing". So an answer to one of those passes
 * through untouched rather than being validated against an empty shape.
 */
export function shaped(method: string, data: unknown): { ok: true; data: unknown } | { ok: false; why: string } {
  const schema = resultSchemaFor(method)
  if (!schema) return { ok: true, data }

  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? issue.path.join('.') : 'the answer'
    return {
      ok: false,
      why: `This host's answer to ${method} does not match the shape the protocol names for it: ${where} — ${issue?.message ?? 'malformed'}. That is a fault in the host, not in the call.`,
    }
  }
  /* The parsed value, not the one that went in: the schema fills defaults, and
     a module reading a field the host left off would otherwise find nothing
     there when the protocol says what should be there. */
  return { ok: true, data: parsed.data }
}
