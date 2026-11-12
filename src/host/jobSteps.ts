import { z } from 'zod'

/**
 * How far each install and update has got, as the page reads it from
 * `/host/steps` (`server/jobSteps.ts`), and the words for it.
 *
 * One store per page: it reads once when something first listens, again
 * whenever the host says a job began, changed step or ended (`{ steps: true }`
 * on `/host/watch`, `announceStepsChanged`), and every second while a job runs
 * — so the elapsed time and a fraction move while nobody touches anything.
 * Nothing is kept here that the host does not say: a reload reads the same.
 */

export const STEP_NAMES = ['queued', 'fetching', 'cloning', 'checkout', 'installing', 'building', 'starting', 'waiting', 'done', 'failed'] as const
export type StepName = (typeof STEP_NAMES)[number]

const stepSchema = z.enum(STEP_NAMES)

export const jobSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['install', 'update']),
  step: stepSchema,
  detail: z.string().nullable(),
  fraction: z.number().nullable(),
  stepMs: z.number(),
  totalMs: z.number(),
  steps: z.array(z.object({ step: stepSchema, ms: z.number() })),
  stalled: z.boolean(),
  failed: z.object({ step: stepSchema, why: z.string() }).optional(),
  cancellable: z.boolean(),
})
export type JobSaid = z.infer<typeof jobSchema>

const answerSchema = z.object({ jobs: z.record(z.string(), jobSchema), active: z.boolean() })

/** "0:12", "1:05", "12:40". */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** What a step is called while it runs: "Installing dependencies", "Checking out v1.6.0". */
export function stepLabel(step: StepName, detail: string | null): string {
  switch (step) {
    case 'queued':
      return detail ? `Waiting for its turn (${detail})` : 'Waiting for its turn'
    case 'fetching':
      return 'Fetching the newest version'
    case 'cloning':
      return 'Downloading'
    case 'checkout':
      return detail ? `Checking out ${detail}` : 'Checking out the newest release'
    case 'installing':
      return detail ? `Installing dependencies ${detail}` : 'Installing dependencies'
    case 'building':
      return 'Building the page'
    case 'starting':
      return 'Starting'
    case 'waiting':
      return 'Waiting for it to answer'
    case 'done':
      return 'Done'
    case 'failed':
      return 'Failed'
  }
}

/** What it was doing when it failed, for "It stopped while installing dependencies". */
const DOING: Record<StepName, string> = {
  queued: 'waiting for its turn',
  fetching: 'fetching the newest version',
  cloning: 'downloading',
  checkout: 'checking out the release',
  installing: 'installing dependencies',
  building: 'building the page',
  starting: 'starting',
  waiting: 'waiting for it to answer',
  done: 'finishing',
  failed: 'finishing',
}

/** The one line a job is shown with: "Installing dependencies… 0:12", "Done in 0:31", or where it failed. */
export function jobLine(job: JobSaid): string {
  if (job.failed) return `Stopped while ${DOING[job.failed.step]}`
  if (job.step === 'done') return `Done in ${clock(job.totalMs)}`
  return `${stepLabel(job.step, job.detail)}… ${clock(job.stepMs)}`
}

/** Said under a job nothing has moved in for a minute. */
export function stalledSaid(job: JobSaid): string {
  return `Nothing has changed for over a minute while ${DOING[job.step]}. It may be stuck; Cancel stops only this ${job.kind}.`
}

/** 0–100 for the bar, or null when the step cannot say (an indeterminate bar). */
export function barValue(job: JobSaid): number | null {
  if (job.step === 'done') return 100
  return job.fraction === null ? null : Math.round(job.fraction * 100)
}

/* ---------- the store ---------- */

type Jobs = Readonly<Record<string, JobSaid>>
const EMPTY: Jobs = Object.freeze({})
let jobs: Jobs = EMPTY
let active = false
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null
let reading = false
let again = false
/** How often the store reads while a job runs. */
export const READ_EVERY_MS = 1_000

function publish(next: Jobs): void {
  jobs = next
  for (const listener of [...listeners]) listener()
}

/** Read `/host/steps` now; while a job runs, again in a second. */
export async function readSteps(fetcher: typeof fetch = fetch): Promise<void> {
  if (reading) {
    again = true
    return
  }
  reading = true
  try {
    const response = await fetcher('/host/steps')
    if (!response.ok) return
    const parsed = answerSchema.safeParse(await response.json())
    if (!parsed.success) return
    active = parsed.data.active
    publish(parsed.data.jobs)
  } catch {
    /* The next read says. */
  } finally {
    reading = false
    if (timer) clearTimeout(timer)
    timer = null
    if (again) {
      again = false
      void readSteps(fetcher)
    } else if ((active || Object.values(jobs).some((job) => job.step === 'done')) && listeners.size > 0) {
      timer = setTimeout(() => void readSteps(fetcher), READ_EVERY_MS)
    }
  }
}

const STEPS_CHANGED = 'kehikot:steps-changed'
/** The host said an install or update began, changed step or ended. */
export function announceStepsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(STEPS_CHANGED))
}

let wired = false
export function subscribeSteps(listener: () => void): () => void {
  listeners.add(listener)
  if (!wired && typeof window !== 'undefined') {
    wired = true
    window.addEventListener(STEPS_CHANGED, () => void readSteps())
  }
  if (listeners.size === 1) void readSteps()
  return () => {
    listeners.delete(listener)
  }
}

export const stepsNow = (): Jobs => jobs

/** For tests: put the store in a known state. */
export function setStepsForTest(next: Jobs, isActive = false): void {
  active = isActive
  publish(next)
}

/** Cancel one module's install or update: the host stops the processes it started, and nothing else. */
export async function cancelSteps(id: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher('/host/steps/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const body = (await response.json().catch(() => null)) as { cancelled?: unknown } | null
    void readSteps(fetcher)
    return body?.cancelled === true
  } catch {
    return false
  }
}
