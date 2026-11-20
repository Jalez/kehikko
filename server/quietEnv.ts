/**
 * The environment every git (and gh) the host runs is given. Its own file so that
 * `versions.ts` and `updates.ts`, which both run git, need not import each other.
 */

/** No terminal to prompt in, so nothing may prompt. */
export const QUIET_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
}
