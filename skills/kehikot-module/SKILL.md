---
name: kehikot-module
description: Build a Kehikot module with Kehikot's help, from the first question to its first release. Only a person runs it, by typing /kehikot-module [what it is for].
argument-hint: "[what the module is for]"
disable-model-invocation: true
allowed-tools: Bash(curl -fsSL https://raw.githubusercontent.com/Jalez/kehikko-protocol/main/docs/building-a-module.md), Bash(bun test), Bash(bun run typecheck), Bash(bun run check:door), Bash(bun run check:parts)
---

The person typed `/kehikot-module $ARGUMENTS`: they want to build a Kehikot module and may know nothing about Kehikot. You build it WITH them, one step at a time, saying in a sentence or two what each step is for before you take it. They decide; you recommend.

The guide every step follows — "Building a module", from the protocol's repository:

!`curl -fsSL https://raw.githubusercontent.com/Jalez/kehikko-protocol/main/docs/building-a-module.md || echo "[the guide could not be read from GitHub]"`

If the guide did not load above, say so in one line, read it at https://github.com/Jalez/kehikko-protocol/blob/main/docs/building-a-module.md another way (or from the template's README and CLAUDE.md once cloned), and go on. The guide is the source of truth: where this skill and the guide disagree, the guide wins.

## The rules the module keeps

Hold every step to these; each one is in the guide, section 3, with its reason.

- **Storage boundary.** Project data only under `<project>/.kehikot/<folder>/`, through `moduleDir`/`moduleFile`, in `store.ts`. Nothing in a `data/` folder, the home folder or beside the code.
- **Header widths.** One row at 380, 280 and 200 pixels: labels of a few words (`LABEL_FIT`), at most four pinned runs, each with an icon. The page owns the state and declares the whole list on every change.
- **Text-only labels.** Every label, note, reason and anything a person or page wrote is drawn as text: no markup, no links, no URL opened from it.
- **Page-only writes.** Every `/api` write carries the page's ticket. The MCP door reads; a tool that writes says `readOnlyHint: false` and does only what the person would want an agent to do.
- **Agents never press person-only items.** `agents: true` only on a harmless switch, toggle or jump; never on a run that writes, sends or deletes, never on a `confirm` run.
- **The Inbox's one record.** What needs the person goes to `host.activity(items)`, whole, on every change. No list of notices of the module's own.
- **Plain-language copy.** Every sentence the person reads says what happened and what to do, in their words.
- **Releases.** Version in `package.json` only; notes in `notes/<version>.md` by the notes rules; an annotated tag on the merge commit on `main`.

## 1. Interview

Ask what the guide's section 1 table asks, ONE question per message, each with your recommended answer and why, waiting for the answer before the next. Start from `$ARGUMENTS` and skip anything it already answers. Ask only what changes the build:

1. What it is for, in the person's own sentence — and its short name (lowercase, dashes: `reading-list`), since the id `kehikot.<name>` is permanent.
2. Who uses it, and when in their work.
3. What it reads: the tracker (issues and pull requests, through the host's reading: `trackers:read`), papers or other files in the project, or only its own material.
4. What it keeps, and in which files under `.kehikot/<name>/`.
5. What agents should be able to do: which tools only read, which write, and what stays the person's.
6. What it shows, and what the person switches between (the header's View, Go and Run).
7. Whether what it holds belongs to parts of the epic (`reacts: ['parts']`) or not (a `partless` sentence).
8. What, if anything, needs the person or runs for a while (the Inbox).
9. Whether it offers a skill of its own.

Done when every question has an answer the person gave or accepted.

## 2. Design

Write a one-page design in the conversation: the name and id; one sentence of what it is for; who uses it and when; what it reads and keeps (files, `dataVersion`); the manifest's `declares.uses` and `reacts` or `partless`; the screen; the header items and which are `agents: true`; the MCP tools with read or write; the Inbox items; the skill, if any. Ask the person to confirm or change it. Done when they say it is right.

## 3. Scaffold

Ask: private or public repository, and under which GitHub owner (recommend private until the first release; Kehikot installs private repositories through the person's own `gh`). Show the exact command and run it only on their yes:

```
gh repo create <owner>/kehikko-<name> --template Jalez/kehikko-module-template --private|--public --clone
```

Then, in the clone: `bun install`, `bun run rename <name>` (add `--name "<Its name>"` when the person chose one), `bun install`, `bun test`. Rewrite the README's paragraphs and the manifest's `summary`, `guidance`, `tags` and `mcp.about` from the design, and remove the README's "Starting a module from this template" section. Commit locally. Push only when the person says so, every time. Done when `bun test` passes in the renamed clone.

## 4. Build test-first

Replace the template's notes with the design, one piece at a time, in this order: the store, the doors and tools, the header, the Inbox items, the page, the skill. For each: write the test in the file the template already has for that part, run it and see it fail, make it pass. Keep the template's tests for the rules (storage boundary, header widths, ticket, read-only door) passing throughout. Done when `bun test`, `bun run typecheck`, `bun run check:door` and `bun run check:parts` all pass, and every item of the design has a test.

## 5. Run it

Explain each step as you go.

1. **Against the stub host.** `bun run stub` (in the background), then have the person open the address it prints. Walk through it with them: the project and parts, picking a part, the header switch, the Inbox line, the MCP tool answering (`curl -s -X POST <module origin>/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<tool>","arguments":{"project":"<the stub project>"}}}'`). Stop it when done.
2. **In Kehikot.** With the person's yes, push. Then THEY install it: Kehikot's modules list › **Install from repository…** › `<owner>/kehikko-<name>`. Kehikot reads the repository with their own `gh`, installs it into its own folder and starts it from there; you cannot press that for them. They place it on a kehikko, turn its tools on in Settings › Module tools and its skill on in Settings › Skills. Read it back with the kehikko door's `read_canvas` when you have it.

Starting `./run.sh` or `bun run dev` in the clone registers the clone with Kehikot when nothing else is under that id, and Install from repository then says it is already registered: use the stub while building. Done when the person has seen it in a container on their kehikko and an agent has had an answer from its tool.

## 6. Release v0.1.0

Write `notes/0.1.0.md` with the person: 1–5 bullets, `- **Short bold lead.** One or two plain sentences.`, about what they will notice — no file names, hashes, protocol versions, TODO or hype. `package.json` already says `0.1.0`. Open a pull request with the notes; when it is merged, show the tag command and run it only on their yes:

```
git tag -a v0.1.0 -m v0.1.0 <merge commit on main> && git push origin v0.1.0
```

Watch the release workflow (`gh run watch`) and report the release's address, or what it refused and the fix. A private repository of another owner cannot call the shared workflow: copy its steps into the module's own `.github/workflows/release.yml` (the guide, section 6). Done when the release is published, or the person chose to stop before it.

## 7. Offer it to everybody (optional)

When the repository is public, tell the person they can propose it for Kehikot's official list: the module's details in Kehikot's modules list › **Propose for the official list**, which files an issue with their own `gh`. Offer it once; it is their choice.
