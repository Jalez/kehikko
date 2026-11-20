import { folded, laid, tiledTo } from '../../../src/host/columns.ts'
import { editCanvas, listCanvases, type Canvas } from '../../canvases.ts'
import { keep } from '../../kehikot.ts'
import { modulesIn } from '../bounds.ts'
import { canvasText } from '../canvasText.ts'
import type { Door } from '../door.ts'
import { KEHIKKO_PROPERTY } from '../params.ts'
import { kehikkoTool } from '../tool.ts'
import { AGENT, openFirst, SIGNED } from '../words.ts'

export const foldModules = kehikkoTool({
  name: 'fold_modules',
  schema: {
    description:
      'Fold containers on a kehikko down to their headers, unfold them, or both in one call — the same control '
      + 'a person presses in a container’s header, and they see it happen. Use it to make room for what is '
      + 'being worked on and to bring a folded module into view. Only on a kehikko that is open on a page of '
      + 'this host right now: one nobody is looking at is refused, because nobody would see it. Folding only: '
      + 'nothing is moved to another place, resized, removed or reordered — what is under a folded container is '
      + 'drawn up against it, as under a person’s press — the module keeps running, keeps what is in it and '
      + 'goes on being told what the kehikko is about, and no program is told it was folded. A folded '
      + 'container keeps the height its owner chose and is unfolded back towards it; in a full column it comes '
      + 'back shorter, and its column-mates are drawn shorter while it is open, as they would be under a '
      + 'person’s press. A container already as asked is left alone and named. The page marks the fold control '
      + 'of each container you changed and says there that an agent did it, and the person undoes it with one '
      + 'press on that control; say what you did anyway. The answer says which '
      + 'call puts back what you changed — make it when you are done with the room you made, and only for '
      + 'containers the person has not touched since. If the person folds or unfolds something themselves '
      + 'meanwhile, that is their arrangement: read_canvas again, leave it, and leave it out of the call that '
      + 'puts things back, which would otherwise flip their choice. Asking for a state a container is already '
      + 'in changes nothing. tile makes containers small squares instead — the module’s icon, name and what its '
      + 'footer says, the same as a person’s collapse button when they chose tiles — marked and put back the same way; '
      + 'unfold puts a tile back at the size and place it had.',
    inputSchema: {
      type: 'object',
      properties: {
        ...KEHIKKO_PROPERTY,
        fold: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The module ids to fold to their headers, exactly as read_canvas prints them, e.g. '
            + '["kehikot.<name>"]. Every one has to be on this kehikko.',
        },
        unfold: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The module ids to unfold, e.g. ["kehikot.<name>"]. Every one has to be on this kehikko, and none '
            + 'may also be in fold. A tile is unfolded back to the size and place it had.',
        },
        tile: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The module ids to make tiles: small squares with the module’s icon, name and footer readout. Every one '
            + 'has to be on this kehikko, and none may also be in fold or unfold.',
        },
      },
      required: [],
    },
  },
  run: ({ door, canvas, how }, args) => foldOn(canvas, how, args, door),
})

/**
 * `fold_modules`: containers folded to their headers or unfolded, and nothing
 * else about the arrangement touched.
 *
 * The write is the one the page's fold control makes — `folded` in
 * `columns.ts`: `collapsed` set, and every height redrawn from the wishes —
 * so an agent's fold is undone by the same press that undoes a person's, and
 * what a container is unfolded towards is the wish its owner left.
 *
 * Refused on a kehikko no page has open. Naming one is how an agent says
 * which of two screens it means, not a way to rearrange a canvas nobody is
 * looking at: the person would find it changed later, with nothing to say an
 * agent had been there.
 *
 * Refused whole for a stranger, for the reason `select_modules` is. A
 * container already as asked is not a refusal: it is named, and it is left
 * OUT of the call the answer offers for putting things back, so that undoing
 * an agent's folds does not unfold what a person had folded themselves.
 */
async function foldOn(
  canvas: Canvas,
  how: string,
  args: Record<string, unknown>,
  door: Door,
): Promise<{ text: string; failed: boolean }> {
  const asked = { fold: [] as string[], unfold: [] as string[], tile: [] as string[] }
  for (const key of ['fold', 'unfold', 'tile'] as const) {
    if (args[key] === undefined || args[key] === null) continue
    const ids = modulesIn(args[key], 'fold_modules', key)
    if (!ids.ok) return { text: ids.why, failed: true }
    asked[key] = ids.ids
  }
  const named = [...asked.fold, ...asked.unfold, ...asked.tile]
  if (!named.length) {
    return {
      text:
        'fold_modules needs fold, unfold, tile or more than one: lists of module ids as read_canvas prints them, e.g. fold: '
        + '["kehikot.<name>"], unfold: ["kehikot.<name>"]. Nothing was changed.',
      failed: true,
    }
  }
  const both = named.filter((id, at) => named.indexOf(id) !== at && named.indexOf(id) < at)
  if (both.length) {
    const ids = [...new Set(both)]
    return {
      text: `${ids.join(', ')} ${ids.length === 1 ? 'is' : 'are'} in more than one of fold, unfold and tile, which is no instruction at all. Nothing was changed.`,
      failed: true,
    }
  }

  const which = door.which()
  const watched = door.watched ? door.watched() : which.ok ? [which.id] : []
  if (!watched.includes(canvas.id)) {
    const names = new Map(listCanvases(door.db).map((c) => [c.id, c.name]))
    return {
      text:
        `kehikko ${canvas.id} (${canvas.name}) is not open on any page of this host, so nobody would see a container `
        + 'fold or unfold there, and this tool only changes what the person can watch change and put back with one '
        + `press. Nothing was folded or unfolded. ${
          watched.length
            ? `Open on a page right now: ${watched.map((id) => `${id} (${names.get(id) ?? 'deleted'})`).join(', ')}.`
            : 'No page of this host has any kehikko open right now.'
        } ${openFirst(door, canvas)} read_canvas still reads kehikko ${canvas.id}, and place_modules still adds to it.`,
      failed: true,
    }
  }

  const on = new Map(canvas.placements.map((p) => [p.i, p]))
  const strangers = named.filter((id) => !on.has(id))
  if (strangers.length) {
    return {
      text:
        `${strangers.join(', ')} ${strangers.length === 1 ? 'is not a container' : 'are not containers'} on kehikko `
        + `${canvas.id} (${canvas.name}), so nothing was folded or unfolded. What is on it: ${
          on.size ? [...on.keys()].join(', ') : 'nothing at all'
        }.`,
      failed: true,
    }
  }

  /* Each container's state before the call: what the call that puts it back asks for. */
  const before = (id: string): 'fold' | 'unfold' | 'tile' => (on.get(id)?.collapsed ? 'fold' : on.get(id)?.tiled ? 'tile' : 'unfold')
  const folding = asked.fold.filter((id) => !on.get(id)?.collapsed)
  /* A tile is not in view either: unfolding one puts it back. */
  const unfolding = asked.unfold.filter((id) => on.get(id)?.collapsed || on.get(id)?.tiled)
  const tiling = asked.tile.filter((id) => !on.get(id)?.tiled || on.get(id)?.collapsed)
  const changing = [...folding, ...unfolding, ...tiling]
  const already = named.filter((id) => !changing.includes(id))
  const leftAlone = already.length
    ? `${already.join(', ')} ${already.length === 1 ? 'was' : 'were'} already as asked and left alone.`
    : ''
  if (!changing.length) {
    return {
      text:
        `${leftAlone} Nothing was changed on kehikko ${canvas.id} (${canvas.name}), ${how}.\n\n`
        + canvasText({ db: door.db, canvas, how, seen: await door.seen() }),
      failed: false,
    }
  }

  /* Nothing is awaited between `decide` reading the arrangement and this
     write, so the list written is the one that was read: a drag, an add or a
     removal the person lands cannot fall in between and be overwritten. The
     sweep `seen` makes is awaited after, as it is in `select_modules`. */
  /* `laid`: stored where the grid will draw it, so the page that re-reads this
     has nothing of its own to save — a save that would be a whole arrangement
     and would overwrite this door's next call. See `laid` in `columns.ts`. */
  const placements = laid(tiledTo(folded(canvas.placements, { fold: folding, unfold: unfolding }), { tile: tiling }))
  const written = editCanvas(door.db, canvas.id, { placements })
  if (written) keep(door.db, written.project)
  if (!written) {
    return { text: `kehikko ${canvas.id} was there a moment ago and is not now; nothing was folded.`, failed: true }
  }
  /* Written first, woken after — see `select_modules`. The note is what the
     page signs each fold control with; see `folded` in `wake.ts`. */
  door.wake(canvas.id, { by: SIGNED, fold: folding, unfold: unfolding, ...(tiling.length ? { tile: tiling } : {}) })

  /* A column that is full gives an unfolded container less than it asks for.
     Said, because "unfolded" would otherwise read as "in view at its height". */
  const short = written.placements.filter((p) => unfolding.includes(p.i) && p.h < p.wish)
  const backTo = (state: 'fold' | 'unfold' | 'tile') => changing.filter((id) => before(id) === state)
  const back = (['unfold', 'fold', 'tile'] as const)
    .map((state) => (backTo(state).length ? `${state}: ${JSON.stringify(backTo(state))}` : null))
    .filter((part): part is string => part !== null)
  return {
    text:
      `On kehikko ${canvas.id} (${canvas.name}), ${how}:`
      + (folding.length ? ` folded ${folding.join(', ')}.` : '')
      + (unfolding.length ? ` unfolded ${unfolding.join(', ')}.` : '')
      + (tiling.length ? ` made ${tiling.join(', ')} ${tiling.length === 1 ? 'a tile' : 'tiles'}.` : '')
      + short.map((p) => ` ${p.i} is drawn at ${p.h} of the ${p.wish} rows it asks for, because its column is full.`).join('')
      + (leftAlone ? ` ${leftAlone}` : '')
      + ' Nothing was moved to another place, resized or removed — what is under a folded container is drawn up against it and comes back down when it is unfolded, as under a person’s press — and no module was told.'
      + ` On the page, the fold control of each is marked and says "${
        folding.length ? `folded by ${SIGNED}` : tiling.length ? `made a tile by ${SIGNED}` : `unfolded by ${SIGNED}`
      }" until the person presses it, which puts it back; say what you did anyway (${AGENT}).`
      + ` To put back what this call changed: fold_modules with ${back.join(', ')}.`
      + ' Make that call only if the person has not folded or unfolded those containers themselves since:'
      + ' read_canvas says how each is now, and one they changed is theirs, so leave it out. A container already'
      + ' in the state asked for is left as it is, so asking again changes nothing.'
      + '\n\n'
      + canvasText({ db: door.db, canvas: written, how, seen: await door.seen() }),
    failed: false,
  }
}
