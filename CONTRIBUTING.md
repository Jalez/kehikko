# Contributing to Kehikot

Thank you for helping. Kehikot is a desktop workbench (the app), a protocol,
and a set of modules, each in its own repository:

| Repository | What it is |
|---|---|
| [kehikko](https://github.com/Jalez/kehikko) | the host: the canvas, the Inbox, the server every module talks to |
| [kehikko-desktop](https://github.com/Jalez/kehikko-desktop) | the macOS app that wraps the host (Tauri) |
| [kehikko-protocol](https://github.com/Jalez/kehikko-protocol) | the package every module and the host speak |
| `kehikko-<name>` | one module each: Journeys, Checklist, Notes, Terminal, … |
| [kehikko-module-template](https://github.com/Jalez/kehikko-module-template) | the starting point for a new module |

## How changes get in

1. **Fork** the repository and work on a branch in your fork.
2. **Open a pull request** against `main`. Say what changes for the person
   using it, and how you checked it.
3. The maintainer reviews it, may ask for changes, and merges it.

`main` is protected: changes reach it only through pull requests. Please don't
change the version number unless you're asked to. In the host and the app, fill
in the pull request's **Release note** section: one line on what the person
using Kehikot notices, or `none`. The app is released automatically from those
lines. A module keeps its notes in `notes/`; its release is tagged when the PR
that bumps its version is merged.

Why so careful: merging is publishing. The host's `modules.json` on `main` is
read by every installed app, a module's release tag reaches every machine
that runs it, and an app tag ships a signed update.

## Working on the host

```sh
bun install
bun run serve     # the host's server
bun run dev       # the canvas, in another terminal
```

Before opening a pull request:

```sh
bun run typecheck
bun test
bun run check:storage
```

Browser tests (Playwright) are skipped unless `KEHIKOT_BROWSER_TESTS=1` is set.
The maintainer runs them on CI; you don't need to.

Read `CLAUDE.md` in the repository: it holds the rules the code keeps, such as
where a project's data may be written (`<project>/.kehikot/<module>/` only) and
what a module may ask of the host.

## Working on a module

Each module is a small program of its own, with `bun install`, `bun test`,
`bun run typecheck` and `bun run build`. Its README says how to run it next to
a host.

To build a new one, start from
[Building a module](https://github.com/Jalez/kehikko-protocol/blob/main/docs/building-a-module.md),
or type `/kehikot-module` in Claude Code.

## Agents welcome, with the same rules

If you use a coding agent, it follows the same steps: a branch in your fork, a
pull request, the checks above. Each repository's `CLAUDE.md` is written for it.

## Reporting a security problem

Please don't open a public issue. See [SECURITY.md](SECURITY.md).
