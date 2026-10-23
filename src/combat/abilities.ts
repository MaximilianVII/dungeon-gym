import type { CombatAttack } from './types'

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
  /** Druid Wild Shape (2 per short rest from druid 2). */
  wildShape: number
}

/** A druid's beast form (SRD beast stat blocks, reduced to what combat reads). */
export interface BeastForm {
  name: string
  hp: number
  ac: number
  attack: CombatAttack
  attacksPerAction: number
}

/** The best SRD beast a Circle of the Land druid can become at this level
 *  (CR 1/4 from 2, CR 1/2 from 4, CR 1 from 8; no flying or swimming forms). */
export function wildShapeForm(druidLevel: number): BeastForm | null {
  if (druidLevel >= 8) return { name: 'Brown Bear', hp: 34, ac: 11, attacksPerAction: 2, attack: { name: 'Bear Maul', toHit: 6, damage: { count: 1, sides: 10, bonus: 4 }, damageType: 'slashing', range: 1, source: 'weapon' } }
  if (druidLevel >= 4) return { name: 'Ape', hp: 19, ac: 12, attacksPerAction: 2, attack: { name: 'Ape Fist', toHit: 5, damage: { count: 1, sides: 6, bonus: 3 }, damageType: 'bludgeoning', range: 1, source: 'weapon' } }
  if (druidLevel >= 2) return { name: 'Wolf', hp: 11, ac: 13, attacksPerAction: 1, attack: { name: 'Wolf Bite', toHit: 4, damage: { count: 2, sides: 4, bonus: 2 }, damageType: 'piercing', range: 1, source: 'weapon' } }
  return null
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
    wildShape: (classLevels.druid ?? 0) >= 2 ? 2 : 0,
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
    wildShape: max.wildShape,
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
