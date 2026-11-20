/**
 * The arguments most tools share, described once.
 *
 * Every tool that acts on a kehikko takes an optional `kehikko` and an optional `project` and says, in
 * every answer, which kehikko it acted on and how it decided — see `decide` in `where.ts`. `project`
 * reaches any project the host knows whichever one is on screen, so an agent asked to work elsewhere
 * uses these tools rather than writing the project's `.kehikot/host/` files by hand.
 */
export const KEHIKKO_PROPERTY = {
  project: {
    type: 'string',
    description:
      'Which project this is about, whichever one is on screen: its folder (an absolute path), its name or its id, '
      + 'as read_canvas and my_place print them. No page has to be open. A folder this host does not know yet that '
      + 'holds its own .git or .kehikot is added to its projects, as Add a project does, and the answer says so. '
      + 'Left out: this conversation’s place. With kehikko as well, that kehikko must be in this project.',
  },
  kehikko: {
    type: 'number',
    description:
      'Which kehikko (canvas) this is about, as the whole number read_canvas prints. Leave it out to act on '
      + 'the one a page of this host currently has open — which only works when exactly one page has one open, '
      + 'because two browser windows on two kehikot make "the open one" name two screens. Every answer says '
      + 'which kehikko it acted on.',
  },
} as const
