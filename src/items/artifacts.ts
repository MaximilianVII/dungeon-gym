import { rollDie, type Rng } from '../combat/dice'

// ---------------------------------------------------------------------------
// Artifacts — the run's power progression. Clearing a level offers a choice of
// up to 3 artifacts; the picked one boosts the character for the rest of the
// run. Rarity tiers scale with depth. Effects are flat modifiers.
// ---------------------------------------------------------------------------

export type Rarity = 'common' | 'uncommon' | 'rare' | 'very-rare' | 'legendary'

export interface ArtifactEffect {
  maxHp?: number
  ac?: number
  toHit?: number
  damageBonus?: number
  /** Extra speed in feet. */
  speed?: number
}

export interface Artifact {
  key: string
  name: string
  rarity: Rarity
  effect: ArtifactEffect
}

export const ARTIFACTS: Artifact[] = [
  { key: 'iron-charm', name: 'Iron Charm', rarity: 'common', effect: { maxHp: 4 } },
  { key: 'whetstone', name: 'Whetstone', rarity: 'common', effect: { damageBonus: 1 } },
  { key: 'swift-boots', name: 'Swift Boots', rarity: 'common', effect: { speed: 10 } },
  { key: 'warded-ring', name: 'Warded Ring', rarity: 'uncommon', effect: { ac: 1 } },
  { key: 'keen-sigil', name: 'Keen Sigil', rarity: 'uncommon', effect: { toHit: 1 } },
  { key: 'bracers-defense', name: 'Guard Bracers', rarity: 'rare', effect: { ac: 2 } },
  { key: 'giants-vigor', name: 'Giant’s Vigor', rarity: 'rare', effect: { maxHp: 12 } },
  { key: 'slayers-mark', name: 'Slayer’s Mark', rarity: 'very-rare', effect: { toHit: 2, damageBonus: 1 } },
  { key: 'heart-mountain', name: 'Heart of the Mountain', rarity: 'legendary', effect: { maxHp: 20, ac: 1 } },
]

export function getArtifact(key: string): Artifact | undefined {
  return ARTIFACTS.find((a) => a.key === key)
}

// Which rarities a level's reward leans toward (index = level just cleared).
const RARITY_BY_LEVEL: Rarity[][] = [
  ['common', 'common', 'uncommon'],
  ['common', 'uncommon', 'uncommon'],
  ['uncommon', 'rare', 'rare'],
  ['rare', 'very-rare', 'legendary'],
]

/**
 * Draw up to 3 distinct artifact choices for clearing the given level, biased
 * to the depth's rarity tier and excluding ones already owned.
 */
export function drawRewards(rng: Rng, levelIndex: number, owned: readonly string[]): Artifact[] {
  const tiers = RARITY_BY_LEVEL[Math.min(levelIndex, RARITY_BY_LEVEL.length - 1)]
  const picks: Artifact[] = []
  const taken = (a: Artifact): boolean => owned.includes(a.key) || picks.some((p) => p.key === a.key)
  for (const tier of tiers) {
    const pool = ARTIFACTS.filter((a) => a.rarity === tier && !taken(a))
    const candidates = pool.length > 0 ? pool : ARTIFACTS.filter((a) => !taken(a))
    if (candidates.length === 0) break
    picks.push(candidates[rollDie(rng, candidates.length) - 1])
  }
  return picks
}

/** Fixed survival-first scoring a bot uses to pick one artifact. */
export function artifactScore(a: Artifact): number {
  const e = a.effect
  return (e.maxHp ?? 0) + (e.ac ?? 0) * 6 + (e.toHit ?? 0) * 2 + (e.damageBonus ?? 0) * 2 + (e.speed ?? 0) * 0.2
}
