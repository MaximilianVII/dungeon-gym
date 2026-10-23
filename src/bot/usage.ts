// ---------------------------------------------------------------------------
// Ability usage tallies: how many times a bot used each named action in a run
// (signature abilities, each spell/cantrip by name, weapon attacks, potions,
// retreats). Pure data helpers — persistence belongs to the caller.
// ---------------------------------------------------------------------------

/** A map of action name → how many times it was used. */
export type UsageTally = Record<string, number>

/** A new tally with `b` added onto `a` (inputs untouched). */
export function mergeUsage(a: Readonly<UsageTally>, b: Readonly<UsageTally>): UsageTally {
  const out: UsageTally = { ...a }
  for (const [name, n] of Object.entries(b)) out[name] = (out[name] ?? 0) + n
  return out
}
