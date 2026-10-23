// ---------------------------------------------------------------------------
// Dice — the randomness layer for 5e-lite combat.
//
// All randomness goes through an injected RNG (() => number in [0,1)) so combat
// is deterministic and unit-testable: tests pass a scripted RNG to force exact
// d20 results. Runs use the serializable mulberry32 in ../rng.
// ---------------------------------------------------------------------------

import type { Rng } from '../rng'

export type { Rng }

/** Roll one die with the given number of sides (1..sides). */
export function rollDie(rng: Rng, sides: number): number {
  return Math.floor(rng() * sides) + 1
}

export type D20Mode = 'normal' | 'advantage' | 'disadvantage'

export interface D20Roll {
  /** The d20 face used after applying advantage/disadvantage. */
  value: number
  /** The raw d20 dice rolled (1 for normal, 2 for adv/disadv). */
  rolls: number[]
  nat20: boolean
  nat1: boolean
}

/** Roll a d20, applying advantage (take higher) or disadvantage (take lower). */
export function rollD20(rng: Rng, mode: D20Mode = 'normal'): D20Roll {
  const a = rollDie(rng, 20)
  if (mode === 'normal') {
    return { value: a, rolls: [a], nat20: a === 20, nat1: a === 1 }
  }
  const b = rollDie(rng, 20)
  const value = mode === 'advantage' ? Math.max(a, b) : Math.min(a, b)
  return { value, rolls: [a, b], nat20: value === 20, nat1: value === 1 }
}

export interface DamageDice {
  count: number
  sides: number
  bonus: number
}

/** Parse "1d8+3" / "2d6" / "1d10-1" into structured dice. Throws on garbage. */
export function parseDamage(notation: string): DamageDice {
  const m = notation.trim().match(/^(\d+)d(\d+)\s*([+-]\s*\d+)?$/i)
  if (!m) throw new Error(`Bad damage notation: "${notation}"`)
  const bonus = m[3] ? parseInt(m[3].replace(/\s+/g, ''), 10) : 0
  return { count: parseInt(m[1], 10), sides: parseInt(m[2], 10), bonus }
}

export interface DamageRoll {
  total: number
  rolls: number[]
  crit: boolean
}

/**
 * Roll damage. On a crit the 5e rule is "double the dice" (not the modifier),
 * so we roll twice as many dice and add the flat bonus once.
 */
export function rollDamage(rng: Rng, dice: DamageDice, crit = false): DamageRoll {
  const n = crit ? dice.count * 2 : dice.count
  const rolls: number[] = []
  for (let i = 0; i < n; i++) rolls.push(rollDie(rng, dice.sides))
  const total = Math.max(0, rolls.reduce((s, r) => s + r, 0) + dice.bonus)
  return { total, rolls, crit }
}
