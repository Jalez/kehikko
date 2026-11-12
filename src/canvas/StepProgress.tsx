import { useState, useSyncExternalStore } from 'react'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { barValue, cancelSteps, jobLine, stalledSaid, stepsNow, subscribeSteps, type JobSaid } from '@/host/jobSteps.ts'

/**
 * An install or update as it goes: the step it is on and for how long
 * ("Installing dependencies… 0:12"), a bar — filling where the step says how
 * far it has got, sliding where it cannot — and, when it failed, which step
 * and why in the host's own words. A job nothing has moved in for a minute
 * says so and offers Cancel, which stops only that job's processes.
 *
 * Never just "Updating": every place that shows an install or update in
 * progress shows this. `server/jobSteps.ts` is where the steps come from.
 */

/** Every job the host is running or just ended, by module id. */
export function useJobSteps(): Readonly<Record<string, JobSaid>> {
  return useSyncExternalStore(subscribeSteps, stepsNow, stepsNow)
}

/** One module's job, or null. */
export function useJob(id: string | null): JobSaid | null {
  const all = useJobSteps()
  return id !== null && Object.hasOwn(all, id) ? all[id]! : null
}

export function StepProgress({ job, named = false, className = '' }: { job: JobSaid; named?: boolean; className?: string }) {
  const [cancelling, setCancelling] = useState(false)
  const failed = job.failed
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`} data-testid="step-progress" data-step={job.step} data-module={job.id}>
      <p className={`truncate text-xs tabular-nums ${failed ? 'text-destructive' : 'text-muted-foreground'}`} data-testid="step-line">
        {named ? <span className="text-foreground font-medium">{job.name}: </span> : null}
        {jobLine(job)}
      </p>
      {failed ? null : <Progress value={barValue(job)} aria-label={`${job.name}: ${jobLine(job)}`} />}
      {failed ? (
        <p className="text-destructive text-xs break-words" data-testid="step-failed">
          {failed.why}
        </p>
      ) : null}
      {job.stalled && job.cancellable ? (
        <div className="flex items-start gap-2" data-testid="step-stalled">
          <p className="text-muted-foreground flex-1 text-xs">{stalledSaid(job)}</p>
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            disabled={cancelling}
            onClick={() => {
              setCancelling(true)
              void cancelSteps(job.id).finally(() => setCancelling(false))
            }}
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** Several modules installing or updating: each with its state, the running ones first. */
export function StepList({ jobs }: { jobs: readonly JobSaid[] }) {
  if (jobs.length === 0) return null
  const order = (job: JobSaid) => (job.failed ? 1 : job.step === 'done' ? 2 : 0)
  const sorted = [...jobs].sort((a, b) => order(a) - order(b))
  return (
    <div className="flex flex-col gap-2" data-testid="step-list" aria-live="polite">
      {sorted.map((job) => (
        <StepProgress key={job.id} job={job} named />
      ))}
    </div>
  )
}
