/*
 * The reader of `kehikot.json` in every host before the layout was split from
 * the view (`server/view.ts`) — copied from `server/kehikot.ts` as it was, and
 * kept here frozen. `test/view.test.ts` hands it what this host writes now: an
 * older Kehikot on a teammate's machine must still read the file, or the
 * layout stops travelling to everybody who has not updated.
 *
 * Do not edit this to make a test pass. It is the other program.
 */
import { LIMITS, MODULE_ID, PART_ID, REFRESH_EVERY_MAX } from 'kehikot-module-protocol'
import { z } from 'zod'

import { isVersionTag, TAG_MAX } from '../../../server/versions.ts'

const VERSION = 2
const KEY = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/
const NAME_MAX = 60

const containerSchema = z
  .object({
    module: z.string().regex(MODULE_ID, 'is not a module id'),
    x: z.number().int(),
    y: z.number().int(),
    w: z.number().int(),
    h: z.number().int(),
    grow: z.boolean().default(false),
    pinned: z.boolean().default(false),
    prompt: z.string().max(LIMITS.PROMPT).default(''),
    promptFor: z.string().regex(MODULE_ID, 'is not a module id').nullable().default(null),
    collapsed: z.boolean().default(false),
    /* `null` means "the height it has" — a hand-written container, or one
       from a file written before wishes existed. Resolved in `fromContainer`;
       the file this host writes always has a number here. */
    wish: z.number().int().nullable().default(null),
    /* What `wish` was called before it existed for open containers: the
       height a container had when it was folded, or null. Accepted so that a
       file written by the host before `wish` still reads, and read as the wish
       when there is no `wish`. Never written — a file this host writes says
       `wish` — and absent rather than defaulted, so the strict schema still
       refuses a file that carries a field this version has never heard of. */
    openH: z.number().int().nullable().optional(),
    selected: z.boolean().default(false),
    /* The bounds are the wire's, half by half: a group id is a `FILTER_ID`, a
       string value may be a typed query and so is a `FILTER_TEXT`, and a list
       is a `toggles` group's set of option ids. An empty list is read rather
       than refused — it is a hand-written "nothing switched on", and the
       placement drops it on the way in, since rest is stored as nothing. */
    filters: z
      .record(
        z.string().min(1).max(LIMITS.FILTER_ID),
        z.union([
          z.string().min(1).max(LIMITS.FILTER_TEXT),
          z.array(z.string().min(1).max(LIMITS.FILTER_ID)).max(LIMITS.FILTER_OPTIONS),
        ]),
      )
      .default({}),
    refreshEvery: z.number().max(REFRESH_EVERY_MAX).nullable().default(null),
    /* Which version the container runs — a semver tag — or absent for latest.
       Written only when the container is pinned, so a file with no pins is
       still one an older host (whose schema is strict) can read. A tag that is
       not semver is refused with the file, like any other malformed field. */
    version: z
      .string()
      .max(TAG_MAX)
      .refine(isVersionTag, 'is not a version tag such as v1.2.0')
      .nullable()
      .optional(),
  })
  .strict()

const epicSchema = z.string().trim().min(1).max(80).nullable().default(null)
const selectionSchema = z.array(z.string().min(1).max(LIMITS.REF)).max(LIMITS.REFS).default([])
/* Part ids, in the shape `partIdsIn` keeps. Optional in the file: absent is
   the whole epic. */
const partsSchema = z.array(z.string().regex(PART_ID, 'is not a part id')).max(LIMITS.PARTS).default([])

const kehikkoFields = {
  key: z.string().regex(KEY, 'is not a key: lowercase letters, digits and dashes'),
  name: z.string().trim().min(1).max(NAME_MAX),
  containers: z.array(containerSchema).max(64).default([]),
}

/* One container per module, said once for both versions of a kehikko. */
function oncePerModule(kehikko: { containers: { module: string }[] }, ctx: z.RefinementCtx): void {
  const seen = new Set<string>()
  for (const container of kehikko.containers) {
    if (seen.has(container.module)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['containers'],
        message: `has two containers for ${container.module}; a module is on a kehikko once`,
      })
    }
    seen.add(container.module)
  }
}

const kehikkoSchema = z.object(kehikkoFields).strict().superRefine(oncePerModule)

/* A kehikko as version 1 wrote it, with an epic and a selection of its own.
   Read for the move to version 2 and never written. */
const kehikkoV1Schema = z
  .object({ ...kehikkoFields, epic: epicSchema, selection: selectionSchema })
  .strict()
  .superRefine(oncePerModule)

/* Two kehikot with one key are two claims to be one kehikko, in either version. */
function keysOnce(file: { kehikot: { key: string }[] }, ctx: z.RefinementCtx): void {
  const seen = new Set<string>()
  for (const kehikko of file.kehikot) {
    if (seen.has(kehikko.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kehikot'],
        message: `two kehikot share the key "${kehikko.key}"; a key is what tells them apart, so give one a new one`,
      })
    }
    seen.add(kehikko.key)
  }
}

const fileSchema = z
  .object({
    version: z.literal(VERSION),
    epic: epicSchema,
    /* Optional in the file: absent is one epic. See "The shape of the file". */
    scope: z.enum(['epic', 'project']).default('epic'),
    parts: partsSchema,
    selection: selectionSchema,
    kehikot: z.array(kehikkoSchema).max(500),
  })
  .strict()
  .superRefine(keysOnce)

const fileV1Schema = z
  .object({
    version: z.literal(1),
    kehikot: z.array(kehikkoV1Schema).max(500),
  })
  .strict()
  .superRefine(keysOnce)

/** What a host before the split makes of a file: its parse, or its refusal. */
export function olderHostReads(text: string) {
  return fileSchema.safeParse(JSON.parse(text))
}
void fileV1Schema
