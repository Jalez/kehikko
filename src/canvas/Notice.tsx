import type { Presence } from '@/host/registry.ts'
import type { noticeOf, Showing } from '@/host/standing.ts'
import { ConditionPanel } from './Conditions.tsx'
import { Start, Update, UpdateFor } from './Start.tsx'

/**
 * What a container shows in place of its module's page when there is no page
 * to frame: the sentence, and the one press that changes it. Drawn by the
 * container (`Container.tsx`) over its hollow body; decided by `noticeOf`.
 *
 * A module that does not fit this Kehikot (protocol `fitOf`) gets the
 * protocol's words: "Monitor needs a newer Kehikot" over "It uses the call log,
 * added in protocol 2.20.", and "Update Kehikot" — or "<Module> needs an
 * update" and "Update <Module>". All text: the module's name is in them as the
 * module wrote it, and none of it is markup.
 */
export function ContainerNotice({
  showing,
  notice,
  presence,
  onStarted,
}: {
  showing: Extract<Showing, { kind: 'notice' }>
  notice: ReturnType<typeof noticeOf>
  presence: Pick<Presence, 'id' | 'at' | 'protocols'>
  onStarted(): void
}) {
  return (
    <ConditionPanel
      condition={showing.condition}
      lifecycle={showing.asleep ? 'asleep' : undefined}
      title={notice.title}
      line={notice.line}
      detail={notice.detail}
      at={presence.at}
      /* A fit names what is missing in its line; the table of protocol
         numbers would only say "2, 2, 2" beside it. */
      protocols={notice.fix ? undefined : presence.protocols}
    >
      {/* Only for silence. An incompatible module is running and answering —
          starting it again would change nothing, and the panel already says
          which protocol each side speaks, which is the thing to act on.

          A module the host is already starting never reaches here: it is a
          cover, with no button to spawn a second copy. `asleep` keeps the
          button: the host will start it when this kehikko next asks, and
          somebody who would rather not wait for that has every right to say
          so now. */}
      {notice.offer === 'start' ? <Start module={presence.id} onStarted={onStarted} /> : null}
      {/* Running, and refused: an update changes that, a start does not. See `noticeOf`. */}
      {notice.offer === 'update' ? <Update /> : null}
      {/* Does not fit: "Update Kehikot", or "Update <Module>" at its row. See `noticeOf`. */}
      {notice.fix ? <UpdateFor label={notice.fix.label} module={notice.fix.module ? presence.id : undefined} /> : null}
    </ConditionPanel>
  )
}
