import { beforeEach, describe, expect, test } from 'bun:test'

import { checkOnOrigin } from '../server/baseBranch.ts'
import type { Runner } from '../server/feedback.ts'
import { explainGitFailure, forgetIdentities, hostOfRemote, identityFor, isSshRemote, whyOfFailure } from '../server/gitAuth.ts'
import { QUIET_ENV } from '../server/updates.ts'
import { run } from '../server/versions.ts'
import { isGitReason, splitSaid } from '../src/host/gitSaid.ts'

const keyAt = (path: string | null) => () => path

const LOCKED = `git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`
const PASSPHRASE = `Enter passphrase for key '/Users/me/.ssh/id_ed25519': \nLoad key "/Users/me/.ssh/id_ed25519": incorrect passphrase supplied to decrypt private key`
const NO_IDENTITIES = `The agent has no identities.\ngit@github.com: Permission denied (publickey).`
const CHANGED = `@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\nfatal: Could not read from remote repository.`
const UNKNOWN = `Host key verification failed.\nfatal: Could not read from remote repository.`
const HTTPS = `fatal: could not read Username for 'https://github.com': terminal prompts disabled`
const HTTPS_AUTH = `remote: Invalid username or password.\nfatal: Authentication failed for 'https://gitlab.example.org/a/b.git/'`
const OFFLINE = `ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known\nfatal: Could not read from remote repository.`

describe('the classifier', () => {
  test('a locked key, plainly, with the command to copy', () => {
    const said = explainGitFailure(LOCKED, 'git@github.com:Jalez/kehikko.git', keyAt('/Users/me/.ssh/id_work'))!
    expect(said.kind).toBe('ssh-key')
    expect(said.command).toBe('ssh-add --apple-use-keychain /Users/me/.ssh/id_work')
    expect(said.said).toContain("Your SSH key is locked with a passphrase that isn't in your keychain, so Kehikot can't use it.")
    expect(said.said).toContain('In Terminal, run `ssh-add --apple-use-keychain /Users/me/.ssh/id_work` once, then press Retry.')
    expect(said.said).toContain('UseKeychain yes')
    expect(said.said).toContain('AddKeysToAgent yes')
  })

  test('with no key found, ~/.ssh/id_ed25519', () => {
    expect(explainGitFailure(LOCKED, 'git@github.com:a/b.git', keyAt(null))!.command).toBe('ssh-add --apple-use-keychain ~/.ssh/id_ed25519')
  })

  test('the host comes from ssh’s own line when the caller has no URL', () => {
    const asked: string[] = []
    explainGitFailure(LOCKED, null, (host) => (asked.push(host), null))
    expect(asked).toEqual(['github.com'])
  })

  test('a wrong passphrase and an empty agent are the same trouble', () => {
    expect(explainGitFailure(PASSPHRASE, null, keyAt(null))!.said).toContain('the passphrase it tried was not right')
    expect(explainGitFailure(NO_IDENTITIES, null, keyAt(null))!.kind).toBe('ssh-key')
  })

  test('a changed host key is never accepted for the person', () => {
    const said = explainGitFailure(CHANGED, 'git@github.com:a/b.git')!
    expect(said.kind).toBe('host-key')
    expect(said.command).toBe('ssh-keygen -R github.com')
    expect(said.said).toContain('does not accept it for you')
    const unknown = explainGitFailure(UNKNOWN, 'ssh://git@git.example.org/a/b.git')!
    expect(unknown.kind).toBe('host-key')
    expect(unknown.said).toContain('does not accept one for you')
  })

  test('an HTTPS sign-in', () => {
    expect(explainGitFailure(HTTPS, 'https://github.com/a/b.git')).toMatchObject({
      kind: 'https-credential',
      command: 'gh auth login',
      said: 'Sign in to github.com with `gh auth login` (or glab auth login for GitLab), then press Retry.',
    })
    expect(explainGitFailure(HTTPS_AUTH, 'https://gitlab.example.org/a/b.git')!.command).toBe('glab auth login --hostname gitlab.example.org')
    expect(explainGitFailure('fatal: unable to access x: The requested URL returned error: 403', 'https://github.com/a/b')!.kind).toBe('https-credential')
  })

  test('the network actually down', () => {
    const said = explainGitFailure(OFFLINE, 'git@github.com:a/b.git')!
    expect(said.kind).toBe('offline')
    expect(said.command).toBeNull()
    expect(said.said).toBe('github.com could not be reached from this computer: it may be offline, or a VPN or the host is down. Check the connection, then press Retry.')
  })

  test('anything else is left to the caller', () => {
    expect(explainGitFailure('fatal: repository not found', 'git@github.com:a/b.git')).toBeNull()
    expect(explainGitFailure('', null)).toBeNull()
  })

  test('remotes', () => {
    expect(hostOfRemote('git@github.com:a/b.git')).toBe('github.com')
    expect(hostOfRemote('ssh://git@host.example:2222/a/b.git')).toBe('host.example')
    expect(hostOfRemote('https://user@gitlab.com/a/b')).toBe('gitlab.com')
    expect(hostOfRemote('/some/local/path')).toBeNull()
    expect(isSshRemote('git@github.com:a/b.git')).toBe(true)
    expect(isSshRemote('https://github.com/a/b')).toBe(false)
  })

  beforeEach(() => forgetIdentities())
  test('the key is read from ssh -G once per host, and a stranger’s host name is never handed to ssh', () => {
    let reads = 0
    const read = () => (reads++, '/k')
    expect(identityFor('github.com', read)).toBe('/k')
    expect(identityFor('github.com', read)).toBe('/k')
    expect(reads).toBe(1)
    expect(identityFor('-oProxyCommand=x')).toBeNull()
  })
})

describe('the callers', () => {
  const answering = (err: string, code = 128): Runner => async (argv) => {
    if (argv.includes('get-url')) return { code: 0, out: 'git@github.com:a/b.git', err: '' }
    if (argv.includes('ls-remote')) return { code, out: '', err }
    return { code: argv.includes('rev-parse') ? 0 : 1, out: '', err: '' }
  }

  test('the base-branch check names the real reason and still uses the last fetch', async () => {
    const got = await checkOnOrigin('/x', 'development', answering(LOCKED))
    expect(got.ok).toBe(true)
    expect(got.ok && got.note).toContain("Your SSH key is locked with a passphrase that isn't in your keychain")
    expect(got.ok && got.note).toContain("origin's last fetch instead, which has development")
    expect(JSON.stringify(got)).not.toContain('could not be reached')
  })

  test('without a last fetch it refuses with the reason', async () => {
    const runner: Runner = async (argv) => (argv.includes('rev-parse') ? { code: 1, out: '', err: '' } : answering(HTTPS)(argv))
    const got = await checkOnOrigin('/x', 'development', runner)
    expect(got).toMatchObject({ ok: false })
    expect(!got.ok && got.why).toContain('Sign in to')
    expect(!got.ok && got.why).toContain('Its last fetch has no branch called development.')
  })

  test('an unknown failure keeps the old words', async () => {
    const got = await checkOnOrigin('/x', 'development', answering('fatal: something odd'))
    expect(got.ok && got.note).toBe('origin could not be reached, so this was checked against its last fetch, which has development.')
  })

  test('the version runner (installs, release checks, the app’s protocols) says it too', () => {
    expect(whyOfFailure(LOCKED, ['git', 'ls-remote', '--tags', 'git@github.com:a/b.git'], 'x')).toContain('ssh-add --apple-use-keychain')
    expect(whyOfFailure('fatal: odd', ['git', 'ls-remote', 'git@github.com:a/b.git'], 'plain')).toBe('plain')
  })

  test('the real runner, against a port nothing listens on, explains rather than echoing git', async () => {
    const ran = await run(['git', 'ls-remote', 'ssh://git@127.0.0.1:1/a/b.git'], { timeoutMs: 10_000 })
    expect(ran.ok).toBe(false)
    if (!ran.ok) expect(ran.why).not.toContain('Enter passphrase')
  })

  test('nothing ever prompts', () => {
    expect(QUIET_ENV.GIT_TERMINAL_PROMPT).toBe('0')
    expect(QUIET_ENV.GIT_SSH_COMMAND ?? '').toContain('BatchMode=yes')
  })
})

describe('the page', () => {
  test('a command is text between backticks, the rest is words', () => {
    expect(splitSaid('Run `ssh-add x` once, then press Retry.')).toEqual([
      { text: 'Run ', command: false },
      { text: 'ssh-add x', command: true },
      { text: ' once, then press Retry.', command: false },
    ])
    expect(isGitReason('Sign in with `gh auth login`')).toBe(true)
    expect(isGitReason('something failed')).toBe(false)
  })
})
