/**
 * The Inbox's ask "which epic is this conversation for?", from the page's side.
 *
 * An agent conversation that was not started from a place in Kehikot asks the
 * host where it belongs (`my_place`, or a tool that needs an epic), and the
 * host files ONE item per conversation in the Inbox, under its own name
 * (`placeRoutes.ts` on the server). The page draws the person's quick answers
 * under that item: the epic on screen first, the project's other epics, and
 * "Not about an epic". A press posts `/host/place/answer` — the page's alone —
 * and the host ties the conversation and drops the item.
 *
 * Pure apart from `answerAsk`, so the rule for the choices is tested here.
 */

/** The host's own name in the Inbox, and the prefix its asks' ids carry. Spelled as `HOST_ID` and `ASK_PREFIX` on the server. */
export const HOST_MODULE = 'kehikko'
export const ASK_PREFIX = 'place-ask:'

/** How many epics are offered as quick answers; the rest are the agent's to name with set_my_place. */
export const ASK_EPICS_MAX = 6

export interface AskChoice {
  epic: string | null
  label: string
}

export function isPlaceAsk(entry: { module: string; id: string }): boolean {
  return entry.module === HOST_MODULE && entry.id.startsWith(ASK_PREFIX)
}

/** The quick answers: the epic on screen first, then the others in the dropdown's order, then none. */
export function askChoices(onScreen: string | null, epics: readonly { slug: string; title?: string }[]): AskChoice[] {
  const titled = (one: { slug: string; title?: string }) => one.title?.trim() || one.slug
  const shown = onScreen ? epics.find((one) => one.slug === onScreen) : undefined
  const rest = epics.filter((one) => one.slug !== onScreen).slice(0, shown ? ASK_EPICS_MAX - 1 : ASK_EPICS_MAX)
  return [
    ...(shown ? [{ epic: shown.slug, label: `${titled(shown)} (on screen)` }] : []),
    ...rest.map((one) => ({ epic: one.slug, label: titled(one) })),
    { epic: null, label: 'Not about an epic' },
  ]
}

/** The person's press: tie that conversation to the epic, in this project, on the kehikko open. */
export async function answerAsk(body: { project: number; session: string; epic: string | null; kehikko: number | null }): Promise<boolean> {
  try {
    const response = await fetch('/host/place/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return response.ok
  } catch {
    return false
  }
}
