/**
 * The host's relative-time units, in one place: the age words of the Inbox and the space picker and
 * the picker's time headings read these, so their boundaries cannot drift apart.
 */
export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
/** Activity younger than this is "Just now" under the space picker's time headings. */
export const JUST_NOW = 5 * MINUTE
