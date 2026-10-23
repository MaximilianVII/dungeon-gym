import type { Battler } from './types'
import { hashString, makeRng } from '../rng'

// ---------------------------------------------------------------------------
// Elite / affix monsters. An affix layers a modifier on an ordinary monster,
// applied at build time inside combat/setup's buildEnemyBattler.
//
// Affixes are rolled DETERMINISTICALLY from the enemy's id + dungeon depth, so
// the same foe is the same elite across rebuilds and a resumed run. None appear
// on floor 1; the chance grows with depth and caps. A boss always rolls one.
//
// shielded / hasted / brutal are stat changes applied here. vampiric has no
// stat change — it lifesteals on a hit, resolved in combat/resolve.
// ---------------------------------------------------------------------------

export type Affix = 'shielded' | 'hasted' | 'brutal' | 'vampiric'

export const AFFIXES: readonly Affix[] = ['shielded', 'hasted', 'brutal', 'vampiric'] as const

/** One-word tag per affix (prepended to the foe's name). */
export const AFFIX_LABELS: Record<Affix, string> = {
  shielded: 'Shielded',
  hasted: 'Hasted',
  brutal: 'Brutal',
  vampiric: 'Vampiric',
}

/** Fraction of damage a vampiric attacker heals on a hit (read by resolve). */
export const VAMPIRIC_LIFESTEAL = 0.5

/** Chance an ordinary foe at this depth is an elite. None on floor 1 (index 0). */
export function affixChance(depthIndex: number): number {
  if (depthIndex <= 0) return 0
  return Math.min(0.4, 0.08 + depthIndex * 0.03)
}

/** Roll an affix for an enemy, deterministic from its id + depth. null = plain foe. */
export function rollAffix(id: string, depthIndex: number, isBoss: boolean): Affix | null {
  const rng = makeRng(hashString(`${id}:${depthIndex}`))
  const gate = rng()
  if (!isBoss && gate >= affixChance(depthIndex)) return null
  return AFFIXES[Math.floor(rng() * AFFIXES.length)]
}

/** Apply an affix's build-time stat changes to a fresh enemy battler (mutates it). */
export function applyAffix(b: Battler, affix: Affix): void {
  b.affix = affix
  b.name = `${AFFIX_LABELS[affix]} ${b.name}`
  switch (affix) {
    case 'shielded':
      b.ac += 3
      b.maxHp = Math.round(b.maxHp * 1.4)
      b.hp = b.maxHp
      break
    case 'hasted':
      b.speedTiles += 2
      b.attacksPerAction = Math.max(1, b.attacksPerAction) + 1
      break
    case 'brutal':
      b.attacks = b.attacks.map((a) => ({ ...a, toHit: a.toHit + 2, damage: { ...a.damage, bonus: a.damage.bonus + 3 } }))
      break
    case 'vampiric':
      break
  }
}
