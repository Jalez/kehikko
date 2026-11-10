/**
 * The app's host binary asked to run a script: it runs the script, as Bun.
 *
 * ## The case this is for
 *
 * Inside the desktop app the host is one compiled binary, and that binary IS a
 * Bun: with `BUN_BE_BUN=1` it is the `bun` an installed module is started and
 * built with (`buildBun` in `moduleBuilds.ts`). So a module's
 * `process.execPath` is this binary, and a module that hands it on — as the
 * runtime for a helper script a session it started runs later — hands on THIS
 * binary. Run without `BUN_BE_BUN` (a session's environment drops it, rightly:
 * see `personEnv` in the protocol), the binary did not run the script. It booted
 * a whole second host, on whatever `PORT` that environment still carried — the
 * port of the module that started the session. That second host held the
 * module's port with Kehikot's own page, the module moved itself elsewhere, and
 * the container read "Something is answering … not JSON".
 *
 * The host takes no arguments. So a compiled host given any is not being asked
 * to be a host: it re-runs itself as Bun with those arguments, and exits with
 * what that run exited with. A host started with none (the desktop shell's
 * start) is untouched, and a host run from a checkout (`bun server/server.ts`)
 * is never compiled, so this never applies there.
 */

/** Where Bun keeps a compiled binary's own modules: `Bun.main` starts here inside one (`B:\~BUN\` on Windows). */
const COMPILED = /^(\/\$bunfs\/|[A-Za-z]:\\~BUN\\)/

/**
 * The arguments to hand Bun, or null to start the host. Pure. `argv` is
 * `process.argv` — in a compiled binary `['bun', Bun.main, ...what it was given]`.
 */
export function asBun(argv: readonly string[], main: string): string[] | null {
  if (!COMPILED.test(main)) return null
  const given = argv.slice(2)
  return given.length > 0 ? given : null
}

/** Run this binary as Bun with `args`, and end this process with its exit code. */
export function beBun(args: readonly string[], execPath: string = process.execPath): never {
  const ran = Bun.spawnSync([execPath, ...args], {
    env: { ...process.env, BUN_BE_BUN: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  process.exit(ran.exitCode ?? 1)
}
