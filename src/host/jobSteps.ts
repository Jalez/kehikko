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
  bytes: z.number().nullable().optional(),
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

/** The steps an install or an update goes through, in order, and about how long each takes (ms; measured by hand). */
const SEQUENCES: Record<JobSaid['kind'], ReadonlyArray<readonly [StepName, number]>> = {
  update: [['fetching', 1000], ['checkout', 300], ['installing', 1400], ['building', 1200], ['starting', 300], ['waiting', 500]],
  install: [['cloning', 3000], ['checkout', 300], ['installing', 1400], ['building', 1200], ['starting', 300], ['waiting', 500]],
}

/** Where a job is in its steps: "step 3 of 6". Null for a step that is not one of them (queued, done, failed). */
export function stepCounter(job: Pick<JobSaid, 'kind' | 'step'>): { at: number; of: number } | null {
  const sequence = SEQUENCES[job.kind]
  const index = sequence.findIndex(([step]) => step === job.step)
  return index < 0 ? null : { at: index + 1, of: sequence.length }
}

/**
 * How far the whole job has got, 0..1, across its steps: each step weighs its
 * typical duration; inside the step now, git's fraction where it says one,
 * otherwise the time it has run against what it usually takes (never past 90%,
 * since it is only a guess). Null when nothing is known — a step that is not
 * one of the job's — so the bar slides instead.
 */
export function overallFraction(job: Pick<JobSaid, 'kind' | 'step' | 'fraction' | 'stepMs'>): number | null {
  if (job.step === 'done') return 1
  if (job.step === 'queued') return 0
  const sequence = SEQUENCES[job.kind]
  const index = sequence.findIndex(([step]) => step === job.step)
  if (index < 0) return null
  const total = sequence.reduce((sum, [, weight]) => sum + weight, 0)
  const before = sequence.slice(0, index).reduce((sum, [, weight]) => sum + weight, 0)
  const weight = sequence[index]![1]
  const within = job.fraction !== null ? Math.max(0, Math.min(1, job.fraction)) : Math.min(0.9, Math.max(0, job.stepMs) / weight)
  return (before + weight * within) / total
}

/** "1.2 MB" for a byte count. */
export function bytesSaid(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

/** What the bar's tooltip says about why it is not exact bytes like the app's. */
export const BAR_EXPLAINED =
  'Modules update in steps on this computer: fetching, installing, building. The app downloads one file, so it can show exact bytes.'

/** The one line a job is shown with: "Installing dependencies · step 3 of 6 · 0:12", "Waiting · 1 ahead", "Done in 0:31", or where it failed. */
export function jobLine(job: JobSaid): string {
  if (job.failed) return `Stopped while ${DOING[job.failed.step]}`
  if (job.step === 'done') return `Done in ${clock(job.totalMs)}`
  if (job.step === 'queued') return job.detail ? `Waiting · ${job.detail}` : 'Waiting'
  const counter = stepCounter(job)
  const parts = [stepLabel(job.step, job.detail)]
  if (counter) parts.push(`step ${counter.at} of ${counter.of}`)
  parts.push(clock(job.totalMs))
  if (typeof job.bytes === 'number' && (job.step === 'fetching' || job.step === 'cloning')) parts.push(bytesSaid(job.bytes))
  return parts.join(' · ')
}

/** Said under a job nothing has moved in for a minute. */
export function stalledSaid(job: JobSaid): string {
  return `Nothing has changed for over a minute while ${DOING[job.step]}. It may be stuck; Cancel stops only this ${job.kind}.`
}

/** 0–100 for the bar across all the steps, or null when nothing is known (an indeterminate bar). */
export function barValue(job: JobSaid): number | null {
  const whole = overallFraction(job)
  return whole === null ? null : Math.round(whole * 100)
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
