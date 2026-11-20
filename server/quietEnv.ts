/**
 * The environment every git (and gh) the host runs is given. Its own file so that
 * `versions.ts` and `updates.ts`, which both run git, need not import each other.
 * A git spawned straight from the host names it (`test/git-reads-leave-index.test.ts`).
 */

/**
 * No terminal to prompt in, so nothing may prompt.
 *
 * And no optional locks: `git status` (and `diff`, and others) refresh the index's
 * stat cache as a side effect and WRITE `.git/index`, holding `index.lock` while
 * they do. On a person's own checkout that changes their repository behind their
 * back and races their git — their commit fails on our lock. `GIT_OPTIONAL_LOCKS=0`
 * drops only those optional writes; a fetch, a checkout or a pull the host means
 * to make takes its locks as before.
 */
export const QUIET_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
  GIT_OPTIONAL_LOCKS: '0',
}
