import { homedir } from 'node:os'

/**
 * Why a git command that talked to a remote failed, in words a person can act
 * on. The host never prompts (`QUIET_ENV`: no terminal prompt, ssh in
 * BatchMode), so a passphrase-locked SSH key that is not in the agent or the
 * keychain fails at once with "Permission denied (publickey)". Kehikot never
 * collects a passphrase; it says what to run in Terminal instead, as text to
 * copy, never run for the person.
 *
 * One classifier for every caller that runs git against a remote.
 */

export type GitFailureKind = 'ssh-key' | 'host-key' | 'https-credential' | 'offline'

export interface GitFailure {
  kind: GitFailureKind
  /** The plain sentence(s), the command inside in `backticks`. */
  said: string
  /** The command to copy, when there is one. Never run by Kehikot. */
  command: string | null
}

const SSH_KEY = [
  /permission denied \((?:[a-z,-]*publickey[a-z,-]*)\)/i,
  /enter passphrase/i,
  /incorrect passphrase/i,
  /bad passphrase/i,
  /load key .*: (?:incorrect passphrase|invalid format)/i,
  /no (?:supported )?identities/i,
  /agent refused operation/i,
  /sign_and_send_pubkey/i,
]
const HOST_KEY = [/host key verification failed/i, /remote host identification has changed/i]
const HTTPS = [
  /could not read (?:username|password)/i,
  /authentication failed/i,
  /terminal prompts disabled/i,
  /the requested url returned error: (?:401|403)/i,
  /http(?:s)? .*\b(?:401|403)\b/i,
  /invalid username or (?:password|token)/i,
]
const OFFLINE = [
  /could not resolve host/i,
  /could not resolve hostname/i,
  /network is unreachable/i,
  /connection (?:timed out|refused|reset)/i,
  /operation timed out/i,
  /failed to connect to/i,
  /unable to access .*(?:timed out|resolve)/i,
  /no route to host/i,
  /temporary failure in name resolution/i,
]

/** The host of a git remote URL (`git@host:o/r`, `ssh://…`, `https://…`), or null. */
export function hostOfRemote(remote: string | null | undefined): string | null {
  if (!remote) return null
  const url = remote.trim()
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)/.exec(url)
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return scp[1]!
  const full = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^:/]+)/i.exec(url)
  return full ? full[1]! : null
}

export function isSshRemote(remote: string | null | undefined): boolean {
  if (!remote) return false
  const url = remote.trim()
  return /^ssh:\/\//i.test(url) || (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && /^(?:[^@/\s]+@)?[^:/\s]+:/.test(url))
}

const identities = new Map<string, string | null>()

/** The first IdentityFile ssh would try for a host (`ssh -G`, which only reads configuration), or null. */
export function identityFor(host: string, read: (host: string) => string | null = sshConfigRead): string | null {
  if (!identities.has(host)) identities.set(host, read(host))
  return identities.get(host) ?? null
}

/** For tests: forget what `ssh -G` said. */
export function forgetIdentities(): void {
  identities.clear()
}

function sshConfigRead(host: string): string | null {
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return null
  try {
    const run = Bun.spawnSync(['ssh', '-G', host], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', timeout: 3_000 })
    if (run.exitCode !== 0) return null
    const files = run.stdout
      .toString()
      .split('\n')
      .filter((line) => line.startsWith('identityfile '))
      .map((line) => line.slice('identityfile '.length).trim())
      .filter(Boolean)
    return files[0]?.replace(/^~(?=\/)/, homedir()) ?? null
  } catch {
    return null
  }
}

function tilde(path: string): string {
  const home = homedir()
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

export const KEYCHAIN_HINT = 'Adding AddKeysToAgent yes and UseKeychain yes under Host * in ~/.ssh/config keeps it loaded after that.'

/**
 * The plain reason a git failure's stderr shows, or null when it is none of
 * the known kinds (the caller then keeps what git said). `remote` is the URL
 * or the host it was talking to, when the caller knows it; `identity` finds
 * the key to name.
 */
export function explainGitFailure(
  stderr: string,
  remote?: string | null,
  identity: (host: string) => string | null = identityFor,
): GitFailure | null {
  const text = stderr ?? ''
  const host =
    hostOfRemote(remote) ??
    (remote && /^[A-Za-z0-9.-]+$/.test(remote) ? remote : null) ??
    /^(?:[^@\s]+@)?([A-Za-z0-9.-]+): permission denied/im.exec(text)?.[1] ??
    null
  const at = host ?? 'the remote'

  if (HOST_KEY.some((rule) => rule.test(text))) {
    const changed = /remote host identification has changed/i.test(text)
    return {
      kind: 'host-key',
      command: host ? `ssh-keygen -R ${host}` : null,
      said: changed
        ? `${at} now presents a different SSH host key than the one this computer remembers. That is expected if the server was rebuilt, and a warning sign if it was not, so Kehikot does not accept it for you. If you trust the change, run ${host ? '`ssh-keygen -R ' + host + '`' : 'ssh-keygen -R <host>'} in Terminal, connect once with ssh to confirm the new key, then press Retry.`
        : `This computer does not know ${at}'s SSH host key yet, and Kehikot does not accept one for you. In Terminal, run ${host ? '`ssh -T git@' + host + '`' : 'ssh once against the host'} and check the fingerprint it shows before answering yes, then press Retry.`,
    }
  }

  if (SSH_KEY.some((rule) => rule.test(text))) {
    const key = (host && identity(host)) || '~/.ssh/id_ed25519'
    const path = tilde(key)
    const command = `ssh-add --apple-use-keychain ${path}`
    const wrong = /incorrect passphrase|bad passphrase/i.test(text)
    return {
      kind: 'ssh-key',
      command,
      said:
        `Your SSH key is locked with a passphrase that isn't in your keychain, so Kehikot can't use it${wrong ? ' (the passphrase it tried was not right)' : ''}. ` +
        `In Terminal, run \`${command}\` once, then press Retry. ${KEYCHAIN_HINT}` +
        (host ? ` If the key is already loaded, ${host} may not have its public key on your account.` : ''),
    }
  }

  if (HTTPS.some((rule) => rule.test(text))) {
    const gitlab = host ? /gitlab/i.test(host) : false
    const command = host ? `${gitlab ? 'glab' : 'gh'} auth login${host === 'github.com' || host === 'gitlab.com' ? '' : ` --hostname ${host}`}` : 'gh auth login'
    return {
      kind: 'https-credential',
      command,
      said: `${host ? `Sign in to ${host}` : 'Sign in'} with \`${command}\`${gitlab ? '' : ' (or glab auth login for GitLab)'}, then press Retry.`,
    }
  }

  if (OFFLINE.some((rule) => rule.test(text))) {
    return {
      kind: 'offline',
      command: null,
      said: `${host ? host : 'The remote'} could not be reached from this computer: it may be offline, or a VPN or the host is down. Check the connection, then press Retry.`,
    }
  }
  return null
}

/** The remote a git command names, from its argv, when it names one outright. */
export function remoteInArgv(argv: readonly string[]): string | null {
  for (const arg of argv) if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg) || /^[^@/\s-][^@/\s]*@[^:/\s]+:/.test(arg)) return arg
  return null
}

/** The URL of the remote a `git -C <dir> … <name>` runs against, read locally, or null. */
function remoteOfCheckout(argv: readonly string[]): string | null {
  const at = argv.indexOf('-C')
  const dir = at >= 0 ? argv[at + 1] : undefined
  if (!dir) return null
  const name = argv.includes('upstream') ? 'upstream' : 'origin'
  try {
    const run = Bun.spawnSync(['git', '-C', dir, 'remote', 'get-url', name], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', timeout: 3_000 })
    return run.exitCode === 0 ? run.stdout.toString().trim() || null : null
  } catch {
    return null
  }
}

/** What a runner reports as its reason: the plain sentence when stderr is a known kind, else `fallback`. */
export function whyOfFailure(stderr: string, argv: readonly string[], fallback: string, remote?: string | null): string {
  return explainGitFailure(stderr, remote ?? remoteInArgv(argv) ?? (needsRemote(stderr) ? remoteOfCheckout(argv) : null))?.said ?? fallback
}

/** Only a failure that is about authentication is worth asking the checkout for its remote. */
function needsRemote(stderr: string): boolean {
  return [...SSH_KEY, ...HOST_KEY, ...HTTPS].some((rule) => rule.test(stderr))
}
