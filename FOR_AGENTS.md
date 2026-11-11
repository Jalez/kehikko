# For agents

What changed in Kehikot itself for agent sessions, newest first. A session that started before an
update is told the changes after the one it was told, once, at its next prompt (protocol 2.61.0,
`server/agentChanges.ts`). A module says its own in the "For agents" section of its release notes.

A host PR that changes what an agent session sees or may do — a tool on the kehikko door, a rule it
is held to, a guard — adds a section at the top: `## <the next number>`, then one or two bullets in
the agent's terms. Name no module and no vendor. Nothing else here is read.

## 2

- The person can mute a module's own messages to agents in a project ("Messages to agents" in its Container menu). `read_canvas` marks such a module; its notices and posts are not delivered. Your own messages to other sessions, and the person's, are never muted. No tool mutes or unmutes.

## 1

- A question you end a turn with (`needs-decision`, with up to 6 choices) is answered by the person from the Inbox, and the answer is typed into this conversation as theirs.
- `kehikko_skills` on the kehikko door reads the skills the person wrote for this kehikko; follow one when its description fits the task.
