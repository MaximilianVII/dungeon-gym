import { describe, it, expect } from 'vitest'
import { CLASS_KEYS, abilityMod, buildCharacter, isClassKey, martialArtsDie, spellsForBuild, starterCharacter, starterSpec } from '../src/character/build'
import { attacksPerActionFor, casterSlots, casterSlotsMulti, hpGainPerLevel, maxSlotLevelOf, profBonus, totalLevelOf } from '../src/character/progression'
import { SPELL_NAMES, cantripDice, grantSpells } from '../src/combat/spells'
import { buildPlayerBattler } from '../src/combat/setup'

describe('the 12 starting characters', () => {
  it('builds one level-5 character per class with distinct names', () => {
    expect(CLASS_KEYS).toHaveLength(12)
    const names = new Set<string>()
    for (const cls of CLASS_KEYS) {
      const c = starterCharacter(cls)
      expect(c.classKey).toBe(cls)
      expect(c.classLevels).toEqual({ [cls]: 5 })
      expect(c.maxHp).toBeGreaterThan(20)
      expect(c.attacks.length).toBeGreaterThan(0)
      expect(c.subclass).toBeDefined()
      names.add(c.name)
    }
    expect(names.size).toBe(12)
  })

  it('fighter: chain mail + shield + Defense, d10 HP, Extra Attack, Champion', () => {
    const f = starterCharacter('fighter')
    expect(f).toMatchObject({ maxHp: 44, ac: 19, speed: 30, attacksPerAction: 2, subclass: 'champion', abilities: ['second-wind', 'action-surge'] })
    expect(f.attacks[0]).toMatchObject({ name: 'Longsword', toHit: 5, damage: { count: 1, sides: 8, bonus: 2 }, range: 1 })
    expect(f.spells).toEqual([])
    expect(f.spellSlots).toEqual([])
  })

  it('barbarian: Unarmored Defense, Fast Movement, d12 HP', () => {
    expect(starterCharacter('barbarian')).toMatchObject({ ac: 13, maxHp: 50, speed: 40, abilities: ['rage'], subclass: 'berserker' })
  })

  it('monk: Unarmored Defense, Unarmored Movement, Martial Arts die', () => {
    const m = starterCharacter('monk')
    expect(m).toMatchObject({ ac: 14, speed: 40, attacksPerAction: 2, abilities: ['patient-defense'] })
    expect(m.attacks[0]).toMatchObject({ toHit: 5, damage: { count: 1, sides: 6, bonus: 2 } })
    expect(martialArtsDie(1)).toBe(4)
    expect(martialArtsDie(11)).toBe(8)
    expect(martialArtsDie(17)).toBe(10)
  })

  it('casters get slots and class spells with their own casting ability', () => {
    const w = starterCharacter('wizard')
    expect(w).toMatchObject({ maxHp: 27, ac: 12, spellSlots: [4, 3, 2], subclass: 'evocation' })
    const fireBolt = w.spells.find((s) => s.name === 'Fire Bolt')
    expect(fireBolt).toMatchObject({ toHit: 5, damage: { count: 2, sides: 10 } })
    expect(w.spells.some((s) => s.name === 'Fireball')).toBe(true)
    expect(w.spells.some((s) => s.name === 'Ice Storm')).toBe(false)
    const warlock = starterCharacter('warlock')
    expect(warlock.spellSlots).toEqual([0, 0, 2])
    expect(warlock.spells.map((s) => s.name)).toEqual(['Eldritch Blast', 'Vampiric Touch'])
    const cleric = starterCharacter('cleric')
    expect(cleric.ac).toBe(18)
    expect(cleric.spells.find((s) => s.name === 'Healing Word')?.heal).toEqual({ count: 1, sides: 4, bonus: 2 })
    expect(starterCharacter('druid')).toMatchObject({ ac: 14, subclass: 'land' })
    expect(starterCharacter('paladin').spellSlots).toEqual([4, 2])
    expect(starterCharacter('ranger').attacks[0].name).toBe('Shortbow')
    expect(starterCharacter('rogue')).toMatchObject({ ac: 14, abilities: ['cunning-dash'] })
    expect(starterCharacter('bard')).toMatchObject({ abilities: ['inspire'], subclass: 'lore' })
  })

  it('Draconic sorcerer: unarmored AC 13 + DEX and +1 HP per level on the battler', () => {
    const s = starterCharacter('sorcerer')
    expect(s).toMatchObject({ ac: 15, maxHp: 27, subclass: 'draconic' })
    expect(buildPlayerBattler(s, { x: 0, y: 0 }).maxHp).toBe(32)
  })

  it('multiclass spells use each class’s own ability and spell level access', () => {
    const scores = { str: 10, dex: 10, con: 10, int: 16, wis: 14, cha: 8 }
    const spells = spellsForBuild({ cleric: 5, wizard: 1 }, scores)
    const burning = spells.find((s) => s.name === 'Burning Hands')
    expect(burning?.toHit).toBe(3 + 3) // prof 3 + INT 3
    expect(spells.find((s) => s.name === 'Sacred Flame')?.toHit).toBe(3 + 2) // WIS 2
    expect(spells.some((s) => s.name === 'Fireball')).toBe(false) // wizard 1 knows 1st level only
    expect(spells.some((s) => s.name === 'Spirit Guardians')).toBe(true)
    expect(spells.find((s) => s.name === 'Sacred Flame')?.damage.count).toBe(2) // total level 6
  })

  it('is pure and rejects unknown weapons', () => {
    const spec = starterSpec('fighter')
    const before = JSON.stringify(spec)
    buildCharacter(spec)
    expect(JSON.stringify(spec)).toBe(before)
    expect(() => buildCharacter({ ...spec, weapons: ['lightsaber'] })).toThrow(/Unknown weapon/)
    expect(isClassKey('wizard')).toBe(true)
    expect(isClassKey('starfarer')).toBe(false)
    expect(abilityMod(15)).toBe(2)
    expect(abilityMod(8)).toBe(-1)
  })

  it('heavy armor cancels Fast Movement; a shield cancels monk Unarmored Defense', () => {
    const barb = buildCharacter({ ...starterSpec('barbarian'), armor: 'plate' })
    expect(barb.speed).toBe(30)
    expect(barb.ac).toBe(18)
    const monk = buildCharacter({ ...starterSpec('monk'), shield: true })
    expect(monk.ac).toBe(10 + 2 + 2)
    expect(monk.speed).toBe(30)
    const medium = buildCharacter({ ...starterSpec('fighter'), armor: 'breastplate', abilityScores: { str: 10, dex: 18, con: 10, int: 10, wis: 10, cha: 10 } })
    expect(medium.ac).toBe(14 + 2 + 1 + 2)
  })
})

describe('progression tables', () => {
  it('slots, proficiency, Extra Attack, HP per level', () => {
    expect(casterSlots('wizard', 1)).toEqual([2])
    expect(casterSlots('wizard', 20)).toEqual([4, 3, 3, 3, 3, 2, 2, 1, 1])
    expect(casterSlots('paladin', 1)).toBeNull()
    expect(casterSlots('paladin', 5)).toEqual([4, 2])
    expect(casterSlots('warlock', 11)).toEqual([0, 0, 0, 0, 3])
    expect(casterSlots('fighter', 5)).toBeNull()
    expect(casterSlotsMulti({ fighter: 5 })).toBeNull()
    // Pact Magic adds to the shared pool (wizard 3: 4/2, warlock 2: two 1st-level).
    expect(casterSlotsMulti({ wizard: 3, warlock: 2 })).toEqual([6, 2])
    // Legacy bug: a lone half-caster used the shared table (Paladin 5 → [3]).
    expect(casterSlotsMulti({ paladin: 5 })).toEqual([4, 2])
    expect(casterSlotsMulti({ ranger: 3 })).toEqual([3])
    // Two spellcasting classes → shared table at caster level 5 + floor(4/2).
    expect(casterSlotsMulti({ cleric: 5, paladin: 4 })).toEqual([4, 3, 3, 1])
    expect(casterSlotsMulti({ warlock: 5 })).toEqual([0, 0, 2])
    expect(maxSlotLevelOf([4, 3, 0])).toBe(2)
    expect(profBonus(5)).toBe(3)
    expect(attacksPerActionFor('fighter', 11)).toBe(3)
    expect(attacksPerActionFor('ranger', 5)).toBe(2)
    expect(attacksPerActionFor('wizard', 20)).toBe(1)
    expect(hpGainPerLevel('barbarian')).toBe(9)
    expect(hpGainPerLevel('wizard')).toBe(6)
    expect(hpGainPerLevel('paladin')).toBe(8)
    expect(hpGainPerLevel('rogue')).toBe(7)
    expect(totalLevelOf({ fighter: 3, rogue: 2 })).toBe(5)
  })
})

describe('spell catalogue', () => {
  it('grants class spells capped by slot level, with cantrip scaling', () => {
    expect(grantSpells('fighter', 5, 3, 0, 5)).toEqual([])
    const low = grantSpells('wizard', 5, 1, 3, 1)
    expect(low.map((s) => s.name)).toEqual(['Fire Bolt', 'Ray of Frost', 'Burning Hands'])
    expect(low[0].damage.count).toBe(1)
    expect(cantripDice(5)).toBe(2)
    expect(cantripDice(11)).toBe(3)
    expect(cantripDice(17)).toBe(4)
    expect(grantSpells('BARD', 5, 1, 0, 1).find((s) => s.name === 'Vicious Mockery')?.applies).toEqual({ condition: 'frightened', rounds: 1 })
  })

  it('contains only SRD 5.1 spells (non-SRD ones were removed, not renamed)', () => {
    for (const banned of ['Witch Bolt', 'Chromatic Orb', 'Arms of Hadar', 'Hunger of Hadar', 'Synaptic Static', 'Thunderous Smite', 'Hail of Thorns']) {
      expect(SPELL_NAMES).not.toContain(banned)
    }
  })
})
