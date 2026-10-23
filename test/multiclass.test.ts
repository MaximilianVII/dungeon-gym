import { describe, it, expect } from 'vitest'
import {
  effectiveCasterLevel,
  hpForClassLevels,
  proficiencyBonus,
  extraAttacksFor,
  canMulticlass,
  canTakeLevelIn,
  totalLevel,
  KNOWN_CLASSES,
} from '../src/combat/multiclass'

describe('canTakeLevelIn — both the new and the current class prerequisites', () => {
  const fighterScores = { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 }

  it('staying in a class you already have is always allowed', () => {
    expect(canTakeLevelIn('fighter', { fighter: 5 }, { str: 3 }).ok).toBe(true)
  })

  it('entering a new class needs its prerequisite', () => {
    expect(canTakeLevelIn('rogue', { fighter: 5 }, fighterScores).ok).toBe(true)
    expect(canTakeLevelIn('wizard', { fighter: 5 }, fighterScores).ok).toBe(false)
  })

  it('…and the prerequisites of every class already taken (legacy only checked the target)', () => {
    // A wizard with STR 8 / DEX 14 / INT 15 meets rogue (DEX 13) and wizard (INT 13)…
    expect(canTakeLevelIn('rogue', { wizard: 5 }, { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }).ok).toBe(true)
    // …but a wizard with INT 12 (no wizard prerequisite) cannot leave the class.
    const r = canTakeLevelIn('rogue', { wizard: 5 }, { str: 8, dex: 14, con: 13, int: 12, wis: 12, cha: 10 })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/INT 13/)
  })

  it('rejects unknown classes', () => {
    expect(canTakeLevelIn('starfarer', { fighter: 5 }, fighterScores).ok).toBe(false)
  })
})

describe('effectiveCasterLevel — 5e multiclass spell-slot table', () => {
  it('full casters contribute their full level', () => {
    // A pure Wizard 5 → 5 caster levels → SRD slots = 4 / 3 / 2.
    expect(effectiveCasterLevel({ wizard: 5 })).toBe(5)
    expect(effectiveCasterLevel({ cleric: 3 })).toBe(3)
  })

  it('half casters contribute half (rounded down)', () => {
    expect(effectiveCasterLevel({ paladin: 3 })).toBe(1) // floor(3/2) = 1
    expect(effectiveCasterLevel({ ranger: 4 })).toBe(2)
  })

  it('full + full multiclass sums directly', () => {
    // Cleric 5 / Sorcerer 3 → 5 + 3 = 8 caster levels (both full casters).
    expect(effectiveCasterLevel({ cleric: 5, sorcerer: 3 })).toBe(8)
  })

  it('full + half multiclass adds (full) + floor(half/2)', () => {
    // Cleric 5 / Paladin 4 → 5 + floor(4/2) = 7.
    expect(effectiveCasterLevel({ cleric: 5, paladin: 4 })).toBe(7)
  })

  it('Warlock Pact Magic is SEPARATE — does not feed the shared table', () => {
    expect(effectiveCasterLevel({ warlock: 5 })).toBe(0)
    // Wizard 2 / Warlock 3 → 2 (only the wizard half feeds slots; Warlock is separate).
    expect(effectiveCasterLevel({ warlock: 3, wizard: 2 })).toBe(2)
  })

  it('martials and unknown classes contribute 0', () => {
    expect(effectiveCasterLevel({ fighter: 11 })).toBe(0)
    expect(effectiveCasterLevel({ rogue: 5, monk: 3, barbarian: 2 })).toBe(0)
  })
})

describe('hpForClassLevels — 5e averages with first-level max', () => {
  it('a single-class fighter at level 1 gets the hit-die max + CON mod', () => {
    // Fighter d10 → 10 + 2 = 12.
    expect(hpForClassLevels({ fighter: 1 }, 2)).toBe(12)
  })

  it('subsequent levels grant avg+1 of the hit die + CON mod', () => {
    // Fighter 5 with CON +2 → (10+2) + 4 × (6 + 2) = 12 + 32 = 44.
    expect(hpForClassLevels({ fighter: 5 }, 2)).toBe(44)
    // Wizard 5 with CON +1 → (6+1) + 4 × (4 + 1) = 7 + 20 = 27.
    expect(hpForClassLevels({ wizard: 5 }, 1)).toBe(27)
  })

  it('multiclass uses the highest-leveled class as the starting class', () => {
    // Fighter 4 / Wizard 1 (CON +1) → starting Fighter (d10):
    // (10+1) + 3×(6+1) + 1×(4+1) = 11 + 21 + 5 = 37.
    expect(hpForClassLevels({ fighter: 4, wizard: 1 }, 1)).toBe(37)
  })
})

describe('proficiencyBonus', () => {
  it('matches the SRD table (+2 / +3 / +4 / +5 / +6)', () => {
    expect(proficiencyBonus(1)).toBe(2)
    expect(proficiencyBonus(4)).toBe(2)
    expect(proficiencyBonus(5)).toBe(3)
    expect(proficiencyBonus(9)).toBe(4)
    expect(proficiencyBonus(13)).toBe(5)
    expect(proficiencyBonus(17)).toBe(6)
  })
})

describe('extraAttacksFor — only the highest source applies (no stack)', () => {
  it('fighter gains Extra Attack at 5 / 11 / 20', () => {
    expect(extraAttacksFor({ fighter: 4 })).toBe(1)
    expect(extraAttacksFor({ fighter: 5 })).toBe(2)
    expect(extraAttacksFor({ fighter: 11 })).toBe(3)
    expect(extraAttacksFor({ fighter: 20 })).toBe(4)
  })

  it('barbarian / paladin / ranger / monk gain Extra Attack at 5', () => {
    expect(extraAttacksFor({ barbarian: 5 })).toBe(2)
    expect(extraAttacksFor({ paladin: 5 })).toBe(2)
    expect(extraAttacksFor({ ranger: 5 })).toBe(2)
    expect(extraAttacksFor({ monk: 5 })).toBe(2) // martial arts grants extra unarmed strike
  })

  it('does NOT stack across classes (5e rule)', () => {
    // Fighter 5 (extra attack) + Paladin 5 (extra attack) → still 2 total, not 3.
    expect(extraAttacksFor({ fighter: 5, paladin: 5 })).toBe(2)
    // Fighter 11 wins over Paladin 5.
    expect(extraAttacksFor({ fighter: 11, paladin: 5 })).toBe(3)
  })

  it('pure casters and low-level martials get no extras', () => {
    expect(extraAttacksFor({ wizard: 11 })).toBe(1)
    expect(extraAttacksFor({ fighter: 4, wizard: 1 })).toBe(1)
  })
})

describe('canMulticlass — 5e prereqs', () => {
  it('a wizard needs INT 13', () => {
    expect(canMulticlass('wizard', { str: 16, dex: 12, con: 14, int: 12, wis: 10, cha: 8 }).ok).toBe(false)
    expect(canMulticlass('wizard', { str: 16, dex: 12, con: 14, int: 13, wis: 10, cha: 8 }).ok).toBe(true)
  })

  it('a fighter needs STR or DEX 13 (any-of)', () => {
    expect(canMulticlass('fighter', { str: 8, dex: 13, con: 14, int: 12, wis: 10, cha: 8 }).ok).toBe(true)
    expect(canMulticlass('fighter', { str: 13, dex: 8, con: 14, int: 12, wis: 10, cha: 8 }).ok).toBe(true)
    expect(canMulticlass('fighter', { str: 12, dex: 12, con: 14, int: 13, wis: 10, cha: 8 }).ok).toBe(false)
  })

  it('a paladin needs BOTH STR 13 and CHA 13 (all-of)', () => {
    expect(canMulticlass('paladin', { str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 12 }).ok).toBe(false)
    expect(canMulticlass('paladin', { str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 13 }).ok).toBe(true)
  })

  it('a monk needs DEX 13 and WIS 13', () => {
    expect(canMulticlass('monk', { str: 8, dex: 13, con: 12, int: 10, wis: 12, cha: 8 }).ok).toBe(false)
    expect(canMulticlass('monk', { str: 8, dex: 13, con: 12, int: 10, wis: 13, cha: 8 }).ok).toBe(true)
  })

  it('returns a human-readable reason on failure', () => {
    const r = canMulticlass('wizard', { str: 16, int: 10 })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/INT 13/i)
  })

  it('unknown class is rejected with a reason', () => {
    const r = canMulticlass('starfarer', { str: 16, dex: 16, con: 16, int: 16, wis: 16, cha: 16 })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/Unknown/i)
  })
})

describe('totalLevel + KNOWN_CLASSES', () => {
  it('totalLevel sums class levels', () => {
    expect(totalLevel({ fighter: 4, wizard: 1 })).toBe(5)
    expect(totalLevel({})).toBe(0)
  })

  it('KNOWN_CLASSES lists the 12 SRD classes', () => {
    expect(KNOWN_CLASSES).toHaveLength(12)
    expect(KNOWN_CLASSES).toContain('fighter')
    expect(KNOWN_CLASSES).toContain('wizard')
    expect(KNOWN_CLASSES).toContain('warlock')
  })
})
