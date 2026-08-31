# Kehikot

**A local-first workbench where you and your coding agent look at the same
project through the same panes.**

You arrange small independent programs — a paper reader, a checklist, a diff, a
real terminal — on a canvas. Each one shows you something. Each one also serves
an MCP server, so the agent in your terminal can use it. Putting a module on the
canvas tells both of you what this work is about.

Each program sits in a **pane**: a box with a thin header (its name, and the
controls to pin, fold or remove it) and the program's own page filling the rest.
A canvas is an arrangement of panes, and you can have several canvases per
project — one for writing, one for reviewing, one for code.

Everything runs on your own machine. Nothing is hosted, nothing phones home, and
your data lives in your project as plain JSON.

> *Kehikko* is Finnish for a frame. *Kehikot* are the frames — the app is named
> after the arrangement, not the things inside it, because the things inside it
> are somebody else's programs.

---

## Why you might want this

Working with a coding agent, the same problem keeps recurring: **you and the
agent are looking at different things.** You have a paper open and it does not
know; it has a checklist and you cannot see it; you both have opinions about
which issue matters and no shared surface for either.

Kehikot is that surface. A module here is not a UI panel with an API bolted on —
it answers to a person and to an agent equally:

- Its **page** is what you see, framed on the canvas.
- Its **MCP server** is what the agent calls.
- Its **`guidance`** is what its presence obliges, composed into the prompt the
  agent is handed and attributed to the module that said it:

  > Every change on this kehikko is held to a checklist, and the work is not
  > finished when the code is finished — it is finished when the items are
  > ticked. — `roadmap.checklist`

So a canvas is a statement of scope, not decoration.

**This is probably for you if** you work with Claude Code or a similar agent on
a long project, you already keep notes and checklists somewhere, and you want
them where the agent can reach them without you pasting.

**It is probably not for you if** you want a hosted product, a team tool with
accounts, or something that works without your reading a little of how it fits
together. This is a workbench, and it assumes you are willing to open the
drawers.

## Status

Working and used daily by its author; not packaged for strangers yet. Twelve
modules, each its own repository. Expect to run a few dev servers and to edit a
path or two. The protocol between host and module is stable enough that modules
built weeks apart still interoperate; the setup story is the rough part.

## Getting started

```bash
git clone https://github.com/Jalez/kehikko
cd kehikko && bun install
./run.sh                       # API on 4180, page on 4181
```

Open <http://127.0.0.1:4181>. You will have an empty workbench: a host with no
modules. Each module is a separate repository you clone, install and register:

```bash
git clone https://github.com/Jalez/kehikko-checklist
cd kehikko-checklist && bun install
bun run register               # writes ~/.roadmap/modules/roadmap.checklist.json
./run.sh                       # serves on its own port
```

Reload the host and it is there. The host sweeps that registry directory —
nothing has a module list compiled into it.

Then **add a project**: the button at the end of the project list opens a folder
browser. Point it at a repository you work in.

## The model

```
project  (a repository or worktree — a folder on disk)
  ├── epics    (<project>/data/epics, when it has any)
  └── kehikot  (many; one per purpose)
```

A **project** is the container. A **kehikko** is one named canvas inside it:
which panes, arranged where, and what they are about. An **epic** is what a
kehikko is currently about. Not every
project has epics, and one that does not says so rather than showing an empty
picker.

Modules keep their data in `<project>/.kehikot/<module>/` as plain JSON — beside
the work it describes rather than inside somebody's app, so it is readable,
greppable and hand-editable. That folder is gitignored by default, because it is
one person's working material and not the project's. Remove the line to share
it.

## The modules

| | | |
|---|---|---|
| [references](https://github.com/Jalez/kehikko-references) | issues and changes, read from the project's own GitHub | 7820 |
| [journeys](https://github.com/Jalez/kehikko-journeys) | hand-written narrative beside the live state of the work | 7840 |
| [orchestrator](https://github.com/Jalez/kehikko-orchestrator) | starts agent sessions on what is selected | 7850 |
| [checklist](https://github.com/Jalez/kehikko-checklist) | what a change or a paper is held to | 7860 |
| [paper](https://github.com/Jalez/kehikko-paper) | the epic's paper, as A4 pages rather than markup | 7870 |
| [diff](https://github.com/Jalez/kehikko-diff) | the diff of whichever change is selected | 7890 |
| [tests](https://github.com/Jalez/kehikko-tests) | what was actually run against the change you are looking at | 7900 |
| [notifications](https://github.com/Jalez/kehikko-notifications) | what happened, and on which kehikko | 7910 |
| [terminal](https://github.com/Jalez/kehikko-terminal) | a real shell, in a pane | 7920 |
| [citations](https://github.com/Jalez/kehikko-citations) | what the paper cites, and what it cites that does not exist | 7930 |
| [notes](https://github.com/Jalez/kehikko-notes) | notes anchored to a passage, including the author's own | 7940 |
| [learning](https://github.com/Jalez/kehikko-learning) | questions about what you are reading | 7950 |

## Writing your own module

A module is any program that serves three things:

1. `/.well-known/roadmap-module.json` — a manifest describing itself
2. a page the host frames
3. optionally, an MCP server

The contract is [`roadmap-module-protocol`](https://github.com/Jalez/kehikko-protocol):
eight messages over `postMessage`, plus one for events. The host runs its own
copy of every schema rather than trusting a module's, and the package's shapes
are a convenience for module authors, never the check.

Nothing in the protocol lets one module name another. Modules interact through
**state the host composes** — the selection, the passage being pointed at, the
subject — so no module has to know its neighbours exist. The one exception is
the event bus, where a module declares a format it emits or consumes and the
host carries the payload, stamping the sender itself so nothing can post under
another module's name.

## Why iframes and separate servers

Because the modules are genuinely independent programs. Terminal needs
`node-pty`, a native binary; Paper carries a source-mapped LaTeX parser;
References shells out to `gh`. One bundle would mean one dependency graph, one
React version, and a native crash in the terminal taking down your thesis
reader.

The sandbox is real too. A module without `declares.storage` runs on an opaque
origin and cannot reach its own cookies, let alone another module's. Terminal
holds a live shell; Notes reads your thesis.

And the boundary produced the design. Because modules *cannot* reach into each
other, they had to agree on contracts. If they shared a process the shortest
path would always have been to import the other module's store, and there would
be a tangle where there is now a protocol.

The costs are known: modules run whether or not a canvas is showing them, and
each has written the same wire client by hand. Both are being paid down.

## Things worth knowing before changing anything

**The frames outlive the panes.** An iframe that moves in the DOM has its
document destroyed — a running terminal, a half-typed note, every scroll
position. So the frames live in their own layer under the grid and are shown or
hidden, never re-parented. Folding a pane, switching kehikko and changing
project all leave the document alone; a test asserts no `load` event fires
across a fold.

**The grid is `pointer-events: none`, with parts opting back in.** The frames
layer sits under it so the module stays clickable. A control that does not opt
in will look dead.

**Start it with `./run.sh`.** Anything else loses `KEHIKKO_ROADMAP_DIR`, which
seeds the first project, and `epics.list` then honestly answers with nothing — a
failure where every layer reports correctly and the map is simply empty.

**There are no modals.** The sandbox has no `allow-modals`, so `confirm()`
silently returns `false` and the button does nothing, forever, with nothing in
the console. Destructive actions use a two-press arm.

## Layout

```
server/      the API on 4180 — registry, canvases, projects, and the methods a
             module's question is relayed to
src/host/    the wire, the division of who answers what, the event bus
src/canvas/  the panes, the frames layer, the header, the dialogs
```

`bun test` for the suite, `bun run typecheck` for the types.

## Prior art it borrows from, and departs from

**VS Code** — the workbench idea, and lazy activation, which this does not have
yet. But its extensions cannot render; they declare contributions and the editor
draws them. Here every module *is* a view, which is the case VS Code reaches for
a webview — an iframe. So the exception there is the rule here.

**MCP** — the reason an agent can use any of this. Each module owns its own
server rather than the host proxying, so a module's tools work whether or not
anything is framed.
