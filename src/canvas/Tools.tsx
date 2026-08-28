import { Unplug } from 'lucide-react'

import type { Presence } from '@/host/registry.ts'
import { Hint } from './Hint.tsx'

/**
 * A mark on a pane whose module offers tools no agent has been told about.
 *
 * ## The failure it makes visible
 *
 * A module can serve an MCP door, say so in its manifest, and answer it
 * perfectly — while the agent has never been told the door exists. Those are
 * two programs with two configurations and nothing has ever connected them. The
 * result is an agent working on a canvas surrounded by tools it cannot see, and
 * no symptom anywhere: the module is `ready`, the door answers, and the tools
 * are simply absent from a conversation happening somewhere else.
 *
 * This is the quietest failure in the system, so it gets the loudest treatment
 * the strip allows — which is still only a small mark, because a canvas full of
 * warnings teaches people to stop reading them.
 *
 * ## Shown only when there is something to do
 *
 * `told` draws nothing, and `none` draws nothing. A module with no MCP door has
 * nothing missing, and one the agent already knows about is working — the
 * absence of a mark is the good news, and adding a green tick for it would be
 * decoration that makes the real mark harder to spot.
 *
 * The two that do draw are different sentences, and keeping them apart is the
 * point. `untold` is "nothing is configured"; `elsewhere` is "something with
 * this name is configured and points at a different address", which is nearly
 * always a module that has moved port. The second is worse, because the agent
 * will reach the old address, get nothing, and the failure will look like a
 * broken module rather than a stale line in a config file.
 */
export function Tools({ agent, name }: { agent: Presence['agent']; name: string }) {
  if (!agent || agent.kind === 'none' || agent.kind === 'told') return null

  const label =
    agent.kind === 'untold'
      ? `${name} offers tools to an agent, and no agent has been told about them. Nothing is configured for its MCP door, so the tools are simply absent from the conversation.`
      : `An MCP server called "${agent.as}" is configured, and it points at ${agent.pointsAt} rather than at this module. An agent will reach that address and get nothing, which looks like a broken module rather than a stale line in a config file.`

  return (
    <Hint label={label} side="bottom">
      <span
        aria-label={agent.kind === 'untold' ? 'tools not known to any agent' : 'tools configured elsewhere'}
        className="text-muted-foreground hover:text-foreground pointer-events-auto flex size-6 shrink-0 cursor-default items-center justify-center"
      >
        <Unplug className="size-3" />
      </span>
    </Hint>
  )
}
