/**
 * A sentence the host wrote about a git failure (`server/gitAuth.ts`) holds its
 * command between backticks. The page shows that command as text to copy and
 * never runs it. Plain strings only: nothing here is markup or a link.
 */
export type SaidPart = { text: string; command: boolean }

export function splitSaid(said: string): SaidPart[] {
  const parts: SaidPart[] = []
  said.split(/`([^`\n]+)`/).forEach((text, at) => {
    if (text) parts.push({ text, command: at % 2 === 1 })
  })
  return parts
}

/** Whether this reads as the host's plain reason, so a "could not be reached" prefix in front of it would contradict it. */
export function isGitReason(said: string): boolean {
  return /`[^`\n]+`/.test(said) || /could not be reached from this computer/.test(said)
}
