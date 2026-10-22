import type { Database } from 'bun:sqlite'

import { edited, INTRO_VERSION, NOT_STARTED, onboardingSchema, type Onboarding, type OnboardingEdit } from '../src/host/onboarding.ts'

/**
 * Whether the person has seen the introduction, and where they left the tour:
 * one row of `settings` in `frame.sqlite` (`src/host/onboarding.ts` has the
 * shape and the rules). `GET /host/onboarding` reads it; `POST` changes it, and
 * is in `PAGE_ONLY` — no program but this host's page says the person saw
 * something.
 *
 * `KEHIKOT_ONBOARDING=off` answers as if both were done, for a scratch host an
 * agent screenshots: the introduction would otherwise stand over every page it
 * opens.
 */

const KEY = 'onboarding'

export function ensureOnboarding(db: Database): void {
  db.exec(`
    create table if not exists settings (
      key   text primary key,
      value text not null
    );
  `)
}

export function readOnboarding(db: Database, env: Record<string, string | undefined> = process.env): Onboarding {
  if (env.KEHIKOT_ONBOARDING === 'off') return { intro: INTRO_VERSION, tour: { at: null, finished: true } }
  try {
    const row = db.query<{ value: string }, [string]>('select value from settings where key = ?').get(KEY)
    return row ? onboardingSchema.parse(JSON.parse(row.value)) : NOT_STARTED
  } catch {
    return NOT_STARTED
  }
}

export function writeOnboarding(db: Database, edit: OnboardingEdit, env: Record<string, string | undefined> = process.env): Onboarding {
  const next = edited(readOnboarding(db, {}), edit)
  db.query('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(
    KEY,
    JSON.stringify(next),
  )
  return readOnboarding(db, env)
}
