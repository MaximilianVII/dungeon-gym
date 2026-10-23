// ---------------------------------------------------------------------------
// In-run XP and level-ups. A gentle custom curve tuned for a dungeon run (not
// the SRD XP table): roughly a level-up every dungeon level or two early on,
// slowing as the character climbs. Pure.
// ---------------------------------------------------------------------------

export const MAX_LEVEL = 20

/** XP needed to advance FROM `level` to `level + 1`. */
export function xpToNext(level: number): number {
  if (level <= 3) return 30 + level * 10
  return 50 + level * 20
}

/**
 * XP granted for defeating a monster — scales with its hit points, with a bonus
 * for elite / boss roles.
 */
export function monsterXp(maxHp: number, role?: string): number {
  const base = Math.max(5, Math.round(maxHp * 1.5))
  if (role === 'boss') return base * 3
  if (role === 'elite') return Math.round(base * 1.5)
  return base
}

export interface XpProgress {
  /** XP left over after applying any level-ups. */
  xp: number
  /** How many character levels were gained (0 if none / already at the cap). */
  levelsGained: number
}

/**
 * Bank `earned` XP on top of `currentXp` for a character at `level`, then peel
 * off as many level-ups as the total allows (capped at level 20).
 */
export function applyXp(level: number, currentXp: number, earned: number): XpProgress {
  let xp = currentXp + earned
  let levelsGained = 0
  while (level + levelsGained < MAX_LEVEL && xp >= xpToNext(level + levelsGained)) {
    xp -= xpToNext(level + levelsGained)
    levelsGained++
  }
  return { xp, levelsGained }
}
