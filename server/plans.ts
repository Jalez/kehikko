import {
  JOURNEYS_MODULE,
  journeyIn,
  moduleFolder,
  planOfJourney,
  plansUnion,
  stepsFromSchema,
  type ProvidedPlan,
  type StepsFrom,
  type StepsListResult,
} from 'kehikot-module-protocol'
import { readJourneys, readPlans, type PublishedPlans } from 'kehikot-module-protocol/serve'

import { folderSource } from './content.ts'

/** This host's id (`HOST_ID` in `kehikot.ts`), spelled here so the epic reader imports nothing of the canvas's. */
const HOST_ID = 'kehikko'

/**
 * An epic's steps, from whoever provides them (protocol 2.21.0).
 *
 * A module that keeps steps publishes them in its own `steps.json` (`writePlan`), and this host takes
 * the union of every publisher for the epic: `steps.list` answers it, each step saying which module
 * provides it, and `epic.get` carries its steps. No module is named in the union.
 *
 * ## The fallback, while Journeys has not published
 *
 * Before 2.21.0 this host read an epic's steps out of the Journeys module's own file, and before that
 * out of its own epic file. Neither stops at once: for as long as the project has no
 * `.kehikot/journeys/steps.json`, the record Journeys keeps for the epic — or, with no record, the
 * steps in this host's own file — is read as one more plan (`planOfJourney`), under
 * `kehikot.journeys` (or this host's id) with `fallback: true`. So a person sees the same steps
 * while modules move, and the day Journeys writes its file the fallback stops, file and all. It goes
 * in protocol 3.0 with `journey.ts`.
 *
 * Read on every call, like the rest of `holdings.ts`: the files are a module's, rewritten while this
 * host runs.
 */

/** The folder the Journeys module keeps its files in. */
const JOURNEYS_FOLDER = moduleFolder(JOURNEYS_MODULE)

/** One provider's plan for the epic, with the folder it is read from (what orders the union). */
export interface EpicPlan extends ProvidedPlan {
  folder: string
}

/** Every plan for one epic, and where its steps are when no module publishes them. */
export interface EpicPlans {
  /** Every provider, by folder name: the published plans, and the fallback where it applies. */
  plans: EpicPlan[]
  /** Whether any module (not the fallback) published a plan for this epic. */
  published: boolean
  /** The older record's `stepsFrom`, when its steps are kept where nobody publishes them. */
  elsewhere: StepsFrom | null
}

/** Whether the Journeys module has published a `steps.json`, for any epic: from then on its old file is not read for steps. */
export function journeysPublish(published: readonly PublishedPlans[]): boolean {
  return published.some((one) => one.folder === JOURNEYS_FOLDER)
}

/**
 * Every plan for one epic. `own` is this host's file for it, read by the caller; `journeys` and
 * `published` are the Journeys document and every module's `steps.json`, read once by a caller
 * walking every epic. A folder whose file names no module is the module `folderSource` names.
 */
export function epicPlans(
  dir: string,
  slug: string,
  own: Record<string, unknown>,
  journeys: unknown = readJourneys(dir),
  published: readonly PublishedPlans[] = readPlans(dir),
): EpicPlans {
  const plans: EpicPlan[] = []
  for (const one of published) {
    if (!Object.hasOwn(one.epics, slug)) continue
    const module = one.module ?? folderSource(one.folder)
    if (module) plans.push({ module, folder: one.folder, plan: one.epics[slug]! })
  }
  const anyPublished = plans.length > 0
  let elsewhere: StepsFrom | null = null
  if (!journeysPublish(published)) {
    const record = journeyIn(journeys, slug)
    const base: Record<string, unknown> = record ?? own
    const plan = planOfJourney(base)
    if (plan === null) {
      const from = stepsFromSchema.safeParse(base.stepsFrom)
      if (from.success) elsewhere = from.data
    } else if (plan.steps.length > 0) {
      plans.push({ module: record ? JOURNEYS_MODULE : HOST_ID, folder: record ? JOURNEYS_FOLDER : '', plan, fallback: true })
    }
  }
  plans.sort((a, b) => a.folder.localeCompare(b.folder))
  return { plans, published: anyPublished, elsewhere }
}

/**
 * `steps.list`'s answer for one epic: the union (`plansUnion`), or — for an epic whose steps are kept
 * where no module publishes them, and nobody else provides any — `{ stepsFrom }` with no `steps` at
 * all, because an empty list would say there are none.
 */
export function stepsAnswer(found: EpicPlans): StepsListResult {
  const union = plansUnion(found.plans)
  if (union.steps.length === 0 && found.elsewhere) return { stepsFrom: found.elsewhere }
  return union
}
