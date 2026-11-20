import type { TrackerRow } from 'kehikot-module-protocol'
import { sourceKey, type Source } from './sources.ts'

/** A row's identity: one item however it is spelled. GitHub numbers are shared by issues and PRs. */
export const identity = (s: Pick<Source, 'tracker' | 'host' | 'repo'>, kind: 'issue' | 'change' | null, number: number) =>
  `${sourceKey(s)}|${s.tracker === 'github' ? 'n' : (kind ?? 'issue')}|${number}`
export const rowIdentity = (row: TrackerRow) => identity(row, row.kind, row.number)

/** An open change whose CI was still running when it was read: its checks finishing moves no `updatedAt`. */
export const checking = (row: TrackerRow): boolean =>
  row.kind === 'change' && row.state === 'open' && (row.pipeline === 'running' || row.pipeline === 'pending')
