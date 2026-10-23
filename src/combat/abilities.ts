// ---------------------------------------------------------------------------
// Class signature combat abilities (the martial "buttons"; full casters lean on
// their spells instead). Granted per class key — a multiclassed bot gains the
// abilities of every class it has levels in.
//
//   rage            (Barbarian) — bonus action; extra melee damage and physical
//                                 resistance until the fight ends. Uses per
//                                 long rest by barbarian level.
//   cunning-dash    (Rogue)     — bonus-action Dash (Cunning Action, rogue 2+).
//   action-surge    (Fighter)   — take your action again (fighter 2+); 1 use per
//                                 short rest (2 from fighter 17).
//   second-wind     (Fighter)   — bonus-action self-heal, 1 use per short rest.
//   patient-defense (Monk)      — bonus-action Dodge (monk 2+).
//   inspire         (Bard)      — bonus action; an ALLY within 60 ft gains a
//                                 Bardic Inspiration die. CHA-mod uses per long
//                                 rest (per short rest from bard 5, Font of
//                                 Inspiration). Lore's Cutting Words spends them too.
// Use counts follow the SRD 5.1 class tables and live on the battler
// (`resources`), so they survive between fights and a JSON round-trip.
// ---------------------------------------------------------------------------

export type AbilityKey = 'rage' | 'cunning-dash' | 'action-surge' | 'second-wind' | 'patient-defense' | 'inspire'

const BY_CLASS: Record<string, { ability: AbilityKey; minLevel: number }[]> = {
  barbarian: [{ ability: 'rage', minLevel: 1 }],
  rogue: [{ ability: 'cunning-dash', minLevel: 2 }],
  fighter: [{ ability: 'second-wind', minLevel: 1 }, { ability: 'action-surge', minLevel: 2 }],
  monk: [{ ability: 'patient-defense', minLevel: 2 }],
  bard: [{ ability: 'inspire', minLevel: 1 }],
}

/** Limited-use class features, as remaining uses. */
export interface ClassResources {
  rage: number
  secondWind: number
  actionSurge: number
  inspiration: number
}

/** "Unlimited" rages at barbarian 20, as a JSON-safe number. */
export const UNLIMITED_USES = 99

/** Rages per long rest by barbarian level (SRD 5.1 barbarian table). */
export function rageUses(barbarianLevel: number): number {
  if (barbarianLevel <= 0) return 0
  if (barbarianLevel >= 20) return UNLIMITED_USES
  if (barbarianLevel >= 17) return 6
  if (barbarianLevel >= 12) return 5
  if (barbarianLevel >= 6) return 4
  if (barbarianLevel >= 3) return 3
  return 2
}

/** Bardic Inspiration die size by bard level. */
export function bardicDie(bardLevel: number): number {
  return bardLevel >= 15 ? 12 : bardLevel >= 10 ? 10 : bardLevel >= 5 ? 8 : 6
}

/** Full use counts for a build. */
export function maxResources(classLevels: Record<string, number>, chaScore: number): ClassResources {
  const fighter = classLevels.fighter ?? 0
  const bard = classLevels.bard ?? 0
  return {
    rage: rageUses(classLevels.barbarian ?? 0),
    secondWind: fighter >= 1 ? 1 : 0,
    actionSurge: fighter >= 17 ? 2 : fighter >= 2 ? 1 : 0,
    inspiration: bard >= 1 ? Math.max(1, Math.floor((chaScore - 10) / 2)) : 0,
  }
}

/** Uses after a rest: a long rest restores everything; a short rest restores
 *  Second Wind, Action Surge and (from bard 5) Bardic Inspiration. Pure. */
export function restoreResources(current: ClassResources, classLevels: Record<string, number>, chaScore: number, long: boolean): ClassResources {
  const max = maxResources(classLevels, chaScore)
  if (long) return max
  return {
    rage: current.rage,
    secondWind: max.secondWind,
    actionSurge: max.actionSurge,
    inspiration: (classLevels.bard ?? 0) >= 5 ? max.inspiration : current.inspiration,
  }
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
