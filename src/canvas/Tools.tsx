import { Plug, Unplug } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import type { Presence } from '@/host/registry.ts'
import { notAnswering } from '@/host/reachable.ts'
import { Hint } from './Hint.tsx'

/**
 * A module's tools: what they are, and whether any agent has been told.
 *
 * ## What this was, and why it changed
 *
 * This used to be a mark and nothing else — a `<span>` with `cursor-default` and
 * no click handler — drawn only when the agent had NOT been told. The argument
 * was that silence is the good news: a module the agent already knows about is
 * working, and a green tick beside every working container would be decoration that
 * makes the one real warning harder to find.
 *
 * Half of that argument survives and half of it was wrong, and it is worth
 * being exact about which.
 *
 * **What survives** is the reason there is still no tick: a canvas full of
 * warnings teaches people to stop reading warnings, and the loud mark is only
 * loud because almost nothing else on a container is. That constraint governs every
 * decision below, and it is why a connected module gets the quietest control on
 * the header rather than a badge, a count, or a colour.
 *
 * **What was wrong** is the step from "there is nothing to warn about" to
 * "there is nothing to show". A person asked for this directly: clicking the
 * mark did nothing, and a module whose tools WERE connected gave them no way to
 * find out what those tools are. Those are two different questions — "is the
 * agent hearing this?" and "what is it hearing?" — and the old design answered
 * the first for some modules and the second for none of them. A module's tool
 * list is not visible anywhere else in this system; the only way to read it was
 * to ask an agent what tools it had.
 *
 * So the mark is now a control, and it is drawn whenever there is a door:
 *
 *   - **`untold` and `elsewhere` keep the loud mark.** An unplugged icon at full
 *     foreground weight. Something is wrong and the container says so from across the
 *     canvas, exactly as before.
 *   - **`told` gets a quiet one.** A plugged icon at the same weight as every
 *     other idle button on the header — the fold, the prompt, the remove. (The
 *     pin and the height toggle were two more when this was written; both have
 *     since been taken out of the strip.)
 *     It reads as one more thing you can open, which is what it is, and it does
 *     not compete for attention with the loud mark on the container beside it.
 *   - **`none` still draws nothing.** A module with no MCP door has no tools and
 *     no configuration; a control that opens a window saying "there is nothing
 *     here" wastes a press every time it is pressed.
 *
 * The two loud states remain different sentences, because they send a person
 * somewhere different. `untold` is "nothing is configured"; `elsewhere` is
 * "something with this name is configured and points at a different address",
 * which is nearly always a module that has moved port — and is worse, because
 * the agent will reach the old address, get nothing, and the failure will look
 * like a broken module rather than a stale line in a config file.
 *
 * ## Why the window belongs to the host
 *
 * The same reason `Prompts.tsx` gives, and it applies harder here. A module's
 * page is in an iframe, so a dialog it rendered would be clipped to its container —
 * a 220-pixel modal is not a modal. The sandbox has no `allow-modals` either,
 * so it could not fall back to `window.confirm`. And the subject of this window
 * is not the module at all: it is what the AGENT has been told, which is a fact
 * about a configuration file the module has never seen and must never be given
 * a way to write.
 */

/** The control on the container header. It opens the window below. */
export function ToolsMark({
  agent,
  name,
  onOpen,
}: {
  agent: Presence['agent']
  name: string
  onOpen(): void
}) {
  if (!agent || agent.kind === 'none') return null

  const wrong = agent.kind === 'untold' || agent.kind === 'elsewhere'

  const label =
    agent.kind === 'untold'
      ? `${name} offers tools to an agent, and no agent has been told about them. Open this to see the tools and to connect them.`
      : agent.kind === 'elsewhere'
        ? `An MCP server called "${agent.as}" is configured, and it points at ${agent.pointsAt} rather than at this module. An agent will reach that address and get nothing. Open this to repoint it.`
        : `${name}'s tools are connected, as "${agent.as}". Open this to see what it offers, or to disconnect it.`

  return (
    <Hint label={label} side="bottom">
      <Button
        variant="ghost"
        size="icon"
        aria-label={
          agent.kind === 'untold'
            ? 'tools not known to any agent'
            : agent.kind === 'elsewhere'
              ? 'tools configured elsewhere'
              : 'tools, connected'
        }
        /* `pointer-events-auto` explicitly. The container is `pointer-events-none` so
           the module's page shows through it, and every part that has to be
           pressed opts back in one at a time — see the essay in `Container.tsx`. A
           control that forgot this looks perfectly normal and is dead. */
        className={
          wrong
            ? 'text-foreground pointer-events-auto size-6 cursor-default'
            : 'text-muted-foreground hover:text-foreground pointer-events-auto size-6 cursor-default'
        }
        /* Stops the grid reading the press as the start of a drag, which would
           make this button unpressable. */
        onMouseDown={(event) => event.stopPropagation()}
        onClick={onOpen}
      >
        {wrong ? <Unplug className="size-3" /> : <Plug className="size-3" />}
      </Button>
    </Hint>
  )
}

/** What the host's server said about one module's door. Mirrors `/host/tools`. */
interface AtTheDoor {
  ok: true
  module: string
  as: string
  url: string
  transport: string
  agent: NonNullable<Presence['agent']>
  writesTo: string
  configuredIn: { scope: 'user' } | { scope: 'local'; project: string } | null
  command: string
  tools:
    | { ok: true; tools: { name: string; description: string }[] }
    | { ok: false; why: 'silent' | 'refused' | 'not-mcp'; says: string }
}

/**
 * The sentence that stops this feature from looking broken.
 *
 * Claude Code reads its MCP configuration when a session starts. Connecting a
 * server mid-session does not add tools to that session — it applies to the
 * next one. Without this said on screen, the very first thing a person does
 * after pressing Connect is ask their agent to use a tool, be told it does not
 * exist, and conclude the button did nothing. That is the likeliest way this
 * whole window disappoints, so it is in the UI rather than in a comment, and it
 * is shown before the press as well as after it.
 */
const NEXT_SESSION =
  'An agent that is already running will not see this. Claude Code reads its MCP configuration when a session starts, so a change here applies to the next session rather than to the one you have open.'

export function ToolsDialog({
  open,
  onOpenChange,
  module,
  name,
  onChanged,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  module: string
  name: string
  /** Look again, so the mark on the container catches up with the press. */
  onChanged(): void
}) {
  const [door, setDoor] = useState<AtTheDoor | null>(null)
  const [asking, setAsking] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const [pressing, setPressing] = useState(false)
  const [said, setSaid] = useState<string | null>(null)

  /*
   * Asked when the window opens, and never on the sweep.
   *
   * The server's essay in `tools.ts` has the argument: a handshake with every
   * module's MCP door on every "look again" is a host that hangs for reasons a
   * person cannot see. Here it is one module, at the moment somebody asked
   * about that module, and the wait is theirs to have chosen.
   */
  const ask = useCallback(async () => {
    setAsking(true)
    setRefused(null)
    try {
      const response = await fetch(`/host/tools?module=${encodeURIComponent(module)}`, {
        cache: 'no-store',
      })
      const body = (await response.json()) as AtTheDoor | { ok: false; why?: string }
      if (!response.ok || !body.ok) {
        setDoor(null)
        setRefused(
          ('why' in body && body.why) || "The host's server would not answer for that module.",
        )
        return
      }
      setDoor(body)
    } catch (error) {
      setDoor(null)
      /* One sentence, one place. See `host/reachable.ts`: this was one of four
         hand-written wordings of the same fault, none of which said what a
         person could do about it. */
      setRefused(notAnswering(error))
    } finally {
      setAsking(false)
    }
  }, [module])

  useEffect(() => {
    if (!open) return
    setDoor(null)
    setSaid(null)
    void ask()
  }, [open, ask])

  const press = async (what: 'connect' | 'disconnect' | 'repoint') => {
    setPressing(true)
    setSaid(null)
    try {
      const response = await fetch('/host/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        /* One module id and one word. Nothing here names a server or a url: the
           server derives both from its own registry. See `doorFor` in
           `server/server.ts` for why that is not a detail. */
        body: JSON.stringify({ module, press: what }),
      })
      const body = (await response.json()) as {
        ok?: boolean
        why?: string
        said?: string
        command?: string
      }
      if (!body.ok) {
        setSaid(body.why ?? body.said ?? 'It did not work, and the host did not say why.')
      } else {
        setSaid(
          what === 'disconnect'
            ? `Removed. ${NEXT_SESSION}`
            : `Written to ${door?.writesTo ?? 'user'} scope. ${NEXT_SESSION}`,
        )
      }
      /* Read back either way. A failed press may still have changed something —
         a repoint removes before it adds — and the window has to show what is
         actually configured rather than what was hoped for. */
      await ask()
      onChanged()
    } catch (error) {
      setSaid(notAnswering(error))
    } finally {
      setPressing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `min-w-0` on everything that holds a tool description. A description is
          a paragraph somebody else wrote and it can be any length at all; a
          flex or grid child without it takes its min-content width from the
          longest unbreakable run, which is how a 220-pixel container elsewhere in
          this workspace ended up with a 1187-pixel floor under it. */}
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Tools from {name}</DialogTitle>
          <DialogDescription>
            What this module offers an agent through its MCP door, and whether any agent has been
            told the door exists.
          </DialogDescription>
        </DialogHeader>

        {refused ? <p className="text-sm leading-relaxed break-words">{refused}</p> : null}

        {door ? (
          <div className="min-w-0 space-y-3">
            <Connection door={door} pressing={pressing} onPress={press} />

            {/* Said whether or not anything has just been pressed. Somebody
                deciding whether to press Connect needs it as much as somebody
                who already did. */}
            <p className="text-muted-foreground text-xs leading-relaxed">{NEXT_SESSION}</p>

            {said ? (
              <p className="bg-muted min-w-0 rounded-md p-3 text-xs leading-relaxed break-words">
                {said}
              </p>
            ) : null}

            <ToolList tools={door.tools} name={name} at={door.url} />

            {/* The other half of NEXT_SESSION, and it only exists for `told`.
                NEXT_SESSION says a config change waits for the next session;
                this says the list itself can drift inside one. The list above
                was read from the module at the moment this window opened. An
                agent mid-session is holding whatever the module answered when
                that session started — and these are dev servers, which restart
                on every save of the file the tools live in, so the two lists
                diverging is the normal case here rather than an edge. Nothing
                at this layer can push the new list into a running session; the
                honest sentence says so instead of implying the window and the
                agent are looking at the same thing. */}
            {door.agent.kind === 'told' && door.tools.ok && door.tools.tools.length > 0 ? (
              <p className="text-muted-foreground text-xs leading-relaxed">
                This list was read from {name} just now. An agent mid-session is using the list from
                when its session started — if the module has reloaded since, the two can differ, and
                only a new session catches the agent up.
              </p>
            ) : null}
          </div>
        ) : asking ? (
          <p className="text-muted-foreground text-sm">Asking {name} what it offers…</p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * What the agent has been told, and the one press that changes it.
 *
 * The scope is named before anything is written and not after. `agentKnows`
 * flattens global and project scope when it reads, which is right for the
 * question "has the agent been told" and wrong for a button: a press that
 * writes has to put the entry somewhere specific, and a person handing a host
 * permission to edit their agent's configuration is owed the where.
 */
function Connection({
  door,
  pressing,
  onPress,
}: {
  door: AtTheDoor
  pressing: boolean
  onPress(what: 'connect' | 'disconnect' | 'repoint'): void
}) {
  const where =
    door.configuredIn === null
      ? null
      : door.configuredIn.scope === 'user'
        ? 'in user scope, which is global to this machine'
        : `in local scope, under ${door.configuredIn.project}`

  return (
    <div className="min-w-0 space-y-2 rounded-md border p-3">
      <p className="min-w-0 text-sm leading-relaxed break-words">
        {door.agent.kind === 'told' ? (
          <>
            Connected as <span className="font-mono text-xs">{door.agent.as}</span>
            {where ? `, ${where}` : null}.
          </>
        ) : door.agent.kind === 'elsewhere' ? (
          <>
            A server called <span className="font-mono text-xs">{door.agent.as}</span> is configured
            {where ? ` ${where}` : null}, and it points at{' '}
            <span className="font-mono text-xs">{door.agent.pointsAt}</span> rather than at this
            module. An agent will reach that address and get nothing — which looks like a broken
            module rather than a stale line in a config file.
          </>
        ) : (
          <>
            No agent has been told about this door. Whatever is listed below exists and is not
            reachable from a conversation.
          </>
        )}
      </p>

      <p className="text-muted-foreground min-w-0 font-mono text-[11px] break-all">
        {door.url} · {door.transport}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {door.agent.kind === 'untold' ? (
          <Hint label={`writes to ${door.writesTo} scope, by running: ${door.command}`} side="top">
            <Button
              size="sm"
              className="h-7 px-3 text-xs"
              disabled={pressing}
              onClick={() => onPress('connect')}
            >
              <Plug className="size-3" />
              {pressing ? 'connecting…' : `connect it as “${door.as}”`}
            </Button>
          </Hint>
        ) : null}

        {door.agent.kind === 'elsewhere' ? (
          <Hint
            label={`this rewrites the existing “${door.agent.as}”: it is removed from wherever it is configured, then written again in ${door.writesTo} scope pointing at this module`}
            side="top"
          >
            <Button
              size="sm"
              className="h-7 px-3 text-xs"
              disabled={pressing}
              onClick={() => onPress('repoint')}
            >
              <Plug className="size-3" />
              {pressing ? 'repointing…' : 'point it at this module'}
            </Button>
          </Hint>
        ) : null}

        {door.agent.kind === 'told' || door.agent.kind === 'elsewhere' ? (
          <Hint label={`removes it wherever it is configured, by running: claude mcp remove ${door.agent.as}`} side="top">
            <Button
              variant="secondary"
              size="sm"
              className="h-7 px-3 text-xs"
              disabled={pressing}
              onClick={() => onPress('disconnect')}
            >
              <Unplug className="size-3" />
              {pressing ? 'removing…' : `disconnect “${door.agent.as}”`}
            </Button>
          </Hint>
        ) : null}
      </div>

      {/* Which scope, and what will be run, in full, before it is run. The host
          does not edit `~/.claude.json` itself; it runs the CLI that owns that
          file — see the essay in `server/register.ts`. */}
      {door.agent.kind === 'told' ? null : (
        <>
          <p className="text-xs leading-relaxed">
            This writes to <span className="font-mono">{door.writesTo}</span> scope
            {door.agent.kind === 'elsewhere'
              ? ', and rewrites an entry this host did not create.'
              : ', which is global to this machine rather than tied to one directory.'}
          </p>
          <p className="text-muted-foreground min-w-0 font-mono text-[11px] break-all">
            {door.agent.kind === 'elsewhere'
              ? `claude mcp remove ${door.agent.as} && ${door.command}`
              : door.command}
          </p>
        </>
      )}
    </div>
  )
}

/**
 * The tools themselves, or the reason there are none to show.
 *
 * Three failures and three sentences, because they send a person to three
 * different places: nothing listening, something listening that is not an MCP
 * server, and a working door with an empty list. The last is not a fault and is
 * not drawn as one.
 *
 * No `Badge` anywhere near a description. shadcn's badge has `whitespace-nowrap`
 * in its base, and a tool description is exactly the variable-length string that
 * turns that into a min-content floor wider than the window it sits in.
 */
function ToolList({ tools, name, at }: { tools: AtTheDoor['tools']; name: string; at: string }) {
  if (!tools.ok) {
    return (
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">
          {tools.why === 'silent'
            ? 'Its door did not answer.'
            : tools.why === 'refused'
              ? 'Its door refused the question.'
              : 'Something is answering at that address and it is not speaking MCP.'}
        </p>
        <p className="text-muted-foreground min-w-0 text-xs leading-relaxed break-words">
          {tools.says}
        </p>
        <p className="text-muted-foreground min-w-0 text-xs leading-relaxed break-words">
          {tools.why === 'not-mcp'
            ? `${name} says its MCP door is at ${at}. A dev server answering its own index page at that path looks exactly like this.`
            : `${name}'s manifest says its door is at ${at}.`}
        </p>
      </div>
    )
  }

  if (tools.tools.length === 0) {
    return (
      <p className="text-muted-foreground min-w-0 text-sm leading-relaxed break-words">
        {name} serves an MCP door and offers no tools through it. That is not a fault — the door
        answered correctly, with an empty list — but connecting it would give an agent nothing.
      </p>
    )
  }

  return (
    <div className="min-w-0 space-y-2">
      <p className="text-sm font-medium">
        {tools.tools.length} {tools.tools.length === 1 ? 'tool' : 'tools'}
      </p>
      <ul className="min-w-0 space-y-2">
        {tools.tools.map((tool) => (
          <li key={tool.name} className="min-w-0 rounded-md border p-2.5">
            <p className="min-w-0 font-mono text-xs font-medium break-all">{tool.name}</p>
            {tool.description ? (
              <p className="text-muted-foreground mt-1 min-w-0 text-xs leading-relaxed break-words">
                {tool.description}
              </p>
            ) : (
              <p className="text-muted-foreground mt-1 text-xs italic">
                It ships without a description, so an agent has only the name to go on.
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
