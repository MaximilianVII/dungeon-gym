import { describe, it, expect } from 'vitest'
import { resolveAttack, resolveAreaAttack } from '../src/combat/resolve'
import { buildPlayerBattler } from '../src/combat/setup'
import { SUBCLASS_CATALOGUE, defaultSubclassFor, effectsOf, featuresUpTo, findEffect, getSubclass, subclassesFor } from '../src/combat/subclasses'
import { KNOWN_CLASSES } from '../src/combat/multiclass'
import type { CombatAttack } from '../src/combat/types'
import { SAMPLE_SOURCE, mkBattler, scriptRng } from './helpers'

const sword: CombatAttack = { name: 'Longsword', toHit: 6, damage: { count: 1, sides: 6, bonus: 2 }, damageType: 'slashing', range: 1, source: 'weapon' }
const fireBolt: CombatAttack = { name: 'Fire Bolt', toHit: 5, damage: { count: 1, sides: 10, bonus: 0 }, damageType: 'fire', range: 24, source: 'cantrip' }

describe('SRD subclass catalogue', () => {
  it('has exactly the twelve SRD 5.1 subclasses, one per class', () => {
    expect(SUBCLASS_CATALOGUE).toHaveLength(12)
    for (const cls of KNOWN_CLASSES) expect(subclassesFor(cls)).toHaveLength(1)
    expect(SUBCLASS_CATALOGUE.map((s) => s.key).sort()).toEqual(
      ['berserker', 'champion', 'devotion', 'draconic', 'evocation', 'fiend', 'hunter', 'land', 'life', 'lore', 'open_hand', 'thief'],
    )
    expect(defaultSubclassFor('druid')?.name).toBe('Circle of the Land')
    expect(getSubclass('moon')).toBeUndefined()
    expect(subclassesFor('starfarer')).toEqual([])
  })

  it('lists features up to a level', () => {
    expect(featuresUpTo('champion', 3).map((f) => f.key)).toEqual(['improved_critical'])
    expect(featuresUpTo('nope', 20)).toEqual([])
  })

  it('gates effects by CLASS level, falling back to charLevel', () => {
    expect(effectsOf({ subclass: 'champion', classLevels: { fighter: 2 } })).toEqual([])
    expect(effectsOf({ subclass: 'champion', classLevels: { fighter: 3 } })).toEqual([{ kind: 'critRange', range: 19 }])
    expect(effectsOf({ subclass: 'champion', charLevel: 15 })).toHaveLength(2)
    expect(effectsOf({})).toEqual([])
    expect(effectsOf({ subclass: 'nope', charLevel: 20 })).toEqual([])
    expect(findEffect({ subclass: 'life', classLevels: { cleric: 1 } }, 'healingBonus')).toEqual({ kind: 'healingBonus', n: 2 })
  })
})

describe('subclass effects in combat', () => {
  it('Champion crits on 19 from fighter 3, on 18 from fighter 15', () => {
    const champ = mkBattler({ team: 'player', subclass: 'champion', classLevels: { fighter: 5 } })
    const t = mkBattler({ hp: 50, maxHp: 50, ac: 30 })
    const ev = resolveAttack(scriptRng([[19, 20], [3, 6], [3, 6]]), champ, sword, t)
    expect(ev.some((e) => e.kind === 'attack' && e.crit && e.hit)).toBe(true)
    expect(t.hp).toBe(42)
    const low = mkBattler({ team: 'player', subclass: 'champion', classLevels: { fighter: 2 } })
    const t2 = mkBattler({ hp: 50, maxHp: 50, ac: 30 })
    resolveAttack(scriptRng([[19, 20]]), low, sword, t2)
    expect(t2.hp).toBe(50)
    const high = mkBattler({ team: 'player', subclass: 'champion', classLevels: { fighter: 15 } })
    const t3 = mkBattler({ hp: 50, maxHp: 50, ac: 30 })
    resolveAttack(scriptRng([[18, 20], [1, 6], [1, 6]]), high, sword, t3)
    expect(t3.hp).toBe(46)
  })

  it('Lore bard: Cutting Words turns a hit into a miss, spending a Bardic Inspiration use', () => {
    const bard = mkBattler({ team: 'player', subclass: 'lore', classLevels: { bard: 3 }, ac: 20, hp: 30, maxHp: 30, resources: { rage: 0, secondWind: 0, actionSurge: 0, inspiration: 1 } })
    const orc = mkBattler()
    resolveAttack(scriptRng([[14, 20], [3, 6]]), orc, sword, bard)
    expect(bard.hp).toBe(30)
    expect(bard.resources?.inspiration).toBe(0)
    resolveAttack(scriptRng([[14, 20], [2, 6]]), orc, sword, bard)
    expect(bard.hp).toBe(26)
  })

  it('Evoker: Potent Cantrip deals half on a miss (wizard 6+), Sculpt Spells spares allies', () => {
    const evoker = mkBattler({ team: 'player', subclass: 'evocation', classLevels: { wizard: 6 } })
    const t = mkBattler({ hp: 10, maxHp: 10, ac: 30 })
    resolveAttack(scriptRng([[1, 20], [4, 10]]), evoker, fireBolt, t)
    expect(t.hp).toBe(8)
    const novice = mkBattler({ team: 'player', subclass: 'evocation', classLevels: { wizard: 5 } })
    const t2 = mkBattler({ hp: 10, maxHp: 10, ac: 30 })
    resolveAttack(scriptRng([[1, 20]]), novice, fireBolt, t2)
    expect(t2.hp).toBe(10)
    const ally = mkBattler({ team: 'player', id: 'a', hp: 10, maxHp: 10 })
    const blast: CombatAttack = { ...fireBolt, name: 'Shatter', source: 'spell', area: 1 }
    const ev = resolveAreaAttack(scriptRng([[5, 10]]), evoker, blast, { x: 0, y: 0 }, [evoker, ally], 1)
    expect(ally.hp).toBe(10)
    expect(ev.some((e) => e.kind === 'ability' && e.ability.startsWith('Sculpted'))).toBe(true)
  })

  it('Fiend: Dark One’s Own Luck rerolls one failed save per fight (warlock 6+)', () => {
    const caster = mkBattler({ team: 'enemy' })
    const fiend = mkBattler({ team: 'player', subclass: 'fiend', classLevels: { warlock: 6 }, hp: 40, maxHp: 40 })
    const burst: CombatAttack = { name: 'Nova', toHit: 6, damage: { count: 2, sides: 10, bonus: 0 }, damageType: 'necrotic', range: 10, area: 2, source: 'spell' }
    resolveAreaAttack(scriptRng([[10, 10], [10, 10], [2, 20], [20, 20]]), caster, burst, { x: 0, y: 0 }, [caster, fiend], 2)
    expect(fiend.hp).toBe(30)
    expect(fiend.darkOneLuckUsed).toBe(true)
  })

  it('Open Hand: a melee hit can knock the target prone', () => {
    const monk = mkBattler({ team: 'player', subclass: 'open_hand', classLevels: { monk: 3 } })
    const t = mkBattler({ hp: 30, maxHp: 30, ac: 5 })
    resolveAttack(scriptRng([[15, 20], [3, 6], [1, 2]]), monk, sword, t)
    expect(t.conditions).toContain('prone')
    expect(t.condTimers?.prone).toBe(1)
  })

  it('Draconic Resilience adds 1 HP per sorcerer level when building the battler', () => {
    const b = buildPlayerBattler({ ...SAMPLE_SOURCE, classKey: 'sorcerer', classLevels: { sorcerer: 5 }, subclass: 'draconic', maxHp: 27 }, { x: 0, y: 0 })
    expect(b.maxHp).toBe(32)
  })
})
