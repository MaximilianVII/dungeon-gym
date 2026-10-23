// ---------------------------------------------------------------------------
// Class signature combat abilities (the martial "buttons"; full casters lean on
// their spells instead). Granted per class key — a multiclassed bot gains the
// abilities of every class it has levels in.
//
//   rage            (Barbarian) — bonus action; extra melee damage and physical
//                                 resistance until the fight ends.
//   cunning-dash    (Rogue)     — bonus-action Dash (Cunning Action, rogue 2+).
//   action-surge    (Fighter)   — once per fight, take your action again (fighter 2+).
//   second-wind     (Fighter)   — once per fight, bonus-action self-heal.
//   patient-defense (Monk)      — bonus-action Dodge (monk 2+).
//   inspire         (Bard)      — bonus action; your next attack has advantage.
//
// Simplifications: per-fight instead of per-rest uses; Bardic Inspiration is
// self-targeted.
// ---------------------------------------------------------------------------

export type AbilityKey = 'rage' | 'cunning-dash' | 'action-surge' | 'second-wind' | 'patient-defense' | 'inspire'

const BY_CLASS: Record<string, { ability: AbilityKey; minLevel: number }[]> = {
  barbarian: [{ ability: 'rage', minLevel: 1 }],
  rogue: [{ ability: 'cunning-dash', minLevel: 2 }],
  fighter: [{ ability: 'second-wind', minLevel: 1 }, { ability: 'action-surge', minLevel: 2 }],
  monk: [{ ability: 'patient-defense', minLevel: 2 }],
  bard: [{ ability: 'inspire', minLevel: 1 }],
}

/** The signature abilities a build's class levels grant (deduped, stable order). */
export function grantAbilities(classLevels: Record<string, number>): AbilityKey[] {
  const out: AbilityKey[] = []
  for (const [cls, lvl] of Object.entries(classLevels)) {
    for (const { ability, minLevel } of BY_CLASS[cls.toLowerCase()] ?? []) {
      if (lvl >= minLevel && !out.includes(ability)) out.push(ability)
    }
  }
  return out
}
