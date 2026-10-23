import type { Rng } from '../src/rng'
import type { Battler } from '../src/combat/types'
import type { PlayerSource } from '../src/combat/setup'

/**
 * Scripted RNG: each call returns the fraction that makes rollDie(_, sides)
 * produce `face`. Pairs are [face, sides] in the exact order the code rolls.
 */
export function scriptRng(rolls: [number, number][]): Rng {
  let i = 0
  return () => {
    if (i >= rolls.length) throw new Error(`RNG exhausted at call ${i}`)
    const [face, sides] = rolls[i++]
    return (face - 0.5) / sides
  }
}

/** An RNG that always returns the same value. */
export function constRng(v: number): Rng {
  return () => v
}

export const SAMPLE_SOURCE: PlayerSource = {
  name: 'Tester',
  classKey: 'fighter',
  classLevels: { fighter: 5 },
  abilityScores: { str: 16, dex: 10, con: 14, int: 10, wis: 10, cha: 10 },
  maxHp: 44,
  ac: 19,
  speed: 30,
  dexModifier: 0,
  attacks: [{ name: 'Longsword', toHit: 6, damage: { count: 1, sides: 8, bonus: 3 }, damageType: 'slashing', range: 1, source: 'weapon' }],
  attacksPerAction: 2,
  spells: [],
  spellSlots: [],
  abilities: [],
}

/** A bare battler for condition / resolution tests. */
export function mkBattler(over: Partial<Battler> = {}): Battler {
  return {
    id: 'x', name: 'X', team: 'enemy', glyph: 'g', pos: { x: 0, y: 0 },
    maxHp: 10, hp: 10, ac: 10, speedTiles: 6, initiativeMod: 0, initiative: 0,
    attacks: [], attacksPerAction: 1, conditions: [], ...over,
  }
}
