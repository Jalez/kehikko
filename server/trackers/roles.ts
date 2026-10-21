import type { MyRole, TrackerRow } from 'kehikot-module-protocol'

/**
 * The person's roles on a row (protocol 2.7.0 `myRoles`), worked out from who
 * they are on that row's tracker host (`Adapter.me`) and the logins the row
 * carries. Pure: the reading applies it over every row it holds.
 *
 * Logins are compared without case: GitHub and GitLab treat `Jalez` and
 * `jalez` as one person. Being mentioned in a comment is not a role.
 */

export const sameLogin = (a: string | null | undefined, b: string): boolean =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

/** Reviewer roles first, since that is what a person looks for; then author, then assignee. */
export function rolesFor(row: Pick<TrackerRow, 'reviewers' | 'authorLogin' | 'assigneeLogins'>, me: string): MyRole[] {
  const out: MyRole[] = []
  const review = (row.reviewers ?? []).find((r) => sameLogin(r.login, me))
  if (review) out.push(review.state === 'requested' ? 'reviewer-asked' : 'reviewer-done')
  if (sameLogin(row.authorLogin, me)) out.push('author')
  if ((row.assigneeLogins ?? []).some((login) => sameLogin(login, me))) out.push('assignee')
  return out
}

/** The row with `myRoles` set for `me`: `[]` when they have none. */
export function withRoles(row: TrackerRow, me: string): TrackerRow {
  return { ...row, myRoles: rolesFor(row, me) }
}
