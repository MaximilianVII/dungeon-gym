import { describe, it, expect } from 'vitest'
import {
  canHold, castControl, castHold, castPattern, castSleep, clearCondition, conjureBeasts, conjureCount, endConcentration,
  endOfTurnSaves, enforceConcentration, holdTargetCount, isDormant, isIncapacitated, markedBy, placeMark, sleepPool, sleepVictims,
} from '../src/combat/control'
import { applyDamage, combatMode, grantTempHp, pushAway, resolveAttack, saveSucceeds, savingThrow } from '../src/combat/resolve'
import { castingLevel, naturalRecovery, upcast } from '../src/combat/slots'
import { buildEnemyBattler, buildPlayerBattler } from '../src/combat/setup'
import { getMonster } from '../src/combat/monsters'
import { hasCondition, healBattler, isOutOfFight, makesDeathSaves, type Battler, type CombatAttack, type CombatEvent } from '../src/combat/types'
import { starterCharacter, type ClassKey } from '../src/character/build'
import { testMap } from '../src/game/map'
import type { Vec2 } from '../src/game/types'
import { makeRng } from '../src/rng'
import { mkBattler, scriptRng } from './helpers'

// testMap rows 4 and 7 are open floor from x=1 to x=10; (5,1) is a wall.

function player(cls: ClassKey, pos: Vec2, id = 'p0'): Battler {
  return buildPlayerBattler({ ...starterCharacter(cls), id }, pos)
}

function monster(key: string, pos: Vec2, hp?: number): Battler {
  const b = buildEnemyBattler(getMonster(key)!, `${key}-${pos.x}-${pos.y}`, pos)
  if (hp !== undefined) b.hp = b.maxHp = hp
  return b
}

function spell(b: Battler, name: string): CombatAttack {
  const a = b.attacks.find((x) => x.name === name)
  if (!a) throw new Error(`${b.name} has no ${name}`)
  return a
}

const sword: CombatAttack = { name: 'Sword', toHit: 5, damage: { count: 1, sides: 6, bonus: 2 }, damageType: 'slashing', range: 1, source: 'weapon' }

describe('Hold Person and paralysis', () => {
  it('paralyzes a humanoid that fails its WIS save, never a beast; concentration starts', () => {
    const bard = player('bard', { x: 1, y: 4 })
    const hold = spell(bard, 'Hold Person')
    const orc = monster('orc', { x: 3, y: 4 })
    const wolf = monster('dire-wolf', { x: 4, y: 4 })
    expect(canHold(hold, wolf)).toBe(false)
    const ev = castHold(scriptRng([[2, 20]]), bard, hold, [wolf, orc], [bard, orc, wolf], 2)
    expect(hasCondition(orc, 'paralyzed')).toBe(true)
    expect(hasCondition(wolf, 'paralyzed')).toBe(false)
    expect(bard.concentration).toBe('Hold Person')
    expect(ev.some((e) => e.kind === 'condition' && e.condition === 'paralyzed')).toBe(true)
    expect(isIncapacitated(orc)).toBe(true)
    expect(canHold(hold, orc)).toBe(false) // already held
  })

  it('a successful save resists; nobody held means no concentration', () => {
    const bard = player('bard', { x: 1, y: 4 })
    const orc = monster('orc', { x: 3, y: 4 })
    castHold(scriptRng([[19, 20]]), bard, spell(bard, 'Hold Person'), [orc], [bard, orc], 2)
    expect(hasCondition(orc, 'paralyzed')).toBe(false)
    expect(bard.concentration).toBeUndefined()
  })

  it('takes one more humanoid per slot level above 2nd', () => {
    expect(holdTargetCount(2)).toBe(1)
    expect(holdTargetCount(4)).toBe(3)
    const bard = player('bard', { x: 1, y: 4 })
    const a = monster('orc', { x: 3, y: 4 })
    const b = monster('orc', { x: 4, y: 4 })
    castHold(scriptRng([[2, 20], [2, 20]]), bard, spell(bard, 'Hold Person'), [a, b], [bard, a, b], 3)
    expect(hasCondition(a, 'paralyzed') && hasCondition(b, 'paralyzed')).toBe(true)
  })

  it('repeats the save at the end of each of its turns', () => {
    const bard = player('bard', { x: 1, y: 4 })
    const orc = monster('orc', { x: 3, y: 4 })
    castHold(scriptRng([[2, 20]]), bard, spell(bard, 'Hold Person'), [orc], [bard, orc], 2)
    endOfTurnSaves(scriptRng([[3, 20]]), orc)
    expect(hasCondition(orc, 'paralyzed')).toBe(true)
    const ev = endOfTurnSaves(scriptRng([[18, 20]]), orc)
    expect(hasCondition(orc, 'paralyzed')).toBe(false)
    expect(orc.saveEnds?.paralyzed).toBeUndefined()
    expect(ev[0]).toMatchObject({ kind: 'condition', condition: 'paralyzed ended' })
    // A save entry whose condition already lapsed is just cleaned up.
    orc.saveEnds = { paralyzed: { ability: 'wis', dc: 13 } }
    endOfTurnSaves(scriptRng([]), orc)
    expect(orc.saveEnds.paralyzed).toBeUndefined()
  })

  it('lapses when the caster loses concentration to damage, or drops', () => {
    const bard = player('bard', { x: 1, y: 4 })
    const orc = monster('orc', { x: 3, y: 4 })
    castHold(scriptRng([[2, 20]]), bard, spell(bard, 'Hold Person'), [orc], [bard, orc], 2)
    applyDamage(bard, 4, false, [], scriptRng([[18, 20]])) // CON save 18 + 1 ≥ 10: kept
    expect(bard.concentration).toBe('Hold Person')
    const ev: CombatEvent[] = []
    applyDamage(bard, 4, false, ev, scriptRng([[2, 20]]))
    expect(bard.concentration).toBeUndefined()
    expect(ev.some((e) => e.kind === 'condition' && e.condition.startsWith('lost concentration'))).toBe(true)
    enforceConcentration([bard, orc])
    expect(hasCondition(orc, 'paralyzed')).toBe(false)
    // Dropping to 0 HP ends concentration even without a save.
    bard.concentration = 'Hold Person'
    applyDamage(bard, 999, false, [])
    expect(bard.concentration).toBeUndefined()
  })

  it('concentration with nothing left to hold lapses, so the caster can cast again', () => {
    const bard = player('bard', { x: 1, y: 4 })
    const orc = monster('orc', { x: 3, y: 4 })
    castHold(scriptRng([[2, 20]]), bard, spell(bard, 'Hold Person'), [orc], [bard, orc], 2)
    enforceConcentration([bard, orc])
    expect(bard.concentration).toBe('Hold Person')
    orc.hp = 0
    enforceConcentration([bard, orc])
    expect(bard.concentration).toBeUndefined()
    // Hunter's Mark outlives its quarry (the mark moves on later).
    const ranger = player('ranger', { x: 1, y: 7 })
    const prey = monster('orc', { x: 4, y: 7 })
    placeMark(ranger, spell(ranger, "Hunter's Mark"), prey, [ranger, prey], true)
    prey.hp = 0
    enforceConcentration([ranger, prey])
    expect(ranger.concentration).toBe("Hunter's Mark")
  })

  it('an incapacitated caster cannot concentrate', () => {
    const bard = player('bard', { x: 1, y: 4 })
    const orc = monster('orc', { x: 3, y: 4 })
    castHold(scriptRng([[2, 20]]), bard, spell(bard, 'Hold Person'), [orc], [bard, orc], 2)
    bard.conditions.push('unconscious')
    bard.hp = 5
    enforceConcentration([bard, orc])
    expect(bard.concentration).toBeUndefined()
    expect(hasCondition(orc, 'paralyzed')).toBe(false)
  })

  it('attacks on a paralyzed creature have advantage and melee hits from 5 ft crit; it fails DEX saves', () => {
    const hero = mkBattler({ id: 'h', team: 'player', pos: { x: 2, y: 4 }, attacks: [sword] })
    const orc = monster('orc', { x: 3, y: 4 })
    orc.conditions.push('paralyzed')
    expect(combatMode(hero, orc, sword)).toBe('advantage')
    expect(savingThrow(makeRng(1), orc, 'dex')).toBe(-Infinity)
    expect(savingThrow(scriptRng([[10, 20]]), orc, 'wis')).toBe(10)
    const ev = resolveAttack(scriptRng([[12, 20], [12, 20], [3, 6], [3, 6]]), hero, sword, orc, 'advantage')
    expect(ev[0]).toMatchObject({ kind: 'attack', hit: true, crit: true })
    expect(orc.hp).toBe(orc.maxHp - 8) // 2d6 (crit) + 2
    // A ranged hit is not a crit.
    const bow: CombatAttack = { ...sword, name: 'Bow', range: 10 }
    const far = monster('orc', { x: 9, y: 4 })
    far.conditions.push('paralyzed')
    expect(resolveAttack(scriptRng([[12, 20], [3, 6]]), hero, bow, far)[0]).toMatchObject({ hit: true, crit: false })
  })
})

describe('Sleep', () => {
  it('puts the lowest-HP creatures down until the pool runs out; undead are immune', () => {
    const g1 = monster('goblin', { x: 5, y: 4 }, 7)
    const k = monster('kobold', { x: 6, y: 4 }, 5)
    const sk = monster('skeleton', { x: 5, y: 7 }, 3)
    const far = monster('goblin', { x: 10, y: 4 }, 1)
    const victims = sleepVictims({ x: 5, y: 4 }, [g1, k, sk, far], 4, 13)
    expect(victims.map((v) => v.id)).toEqual([k.id, g1.id])
    expect(sleepVictims({ x: 5, y: 4 }, [g1, k], 4, 4)).toEqual([])
  })

  it('upcasts by 2d8 per slot level and wakes a sleeper that takes damage', () => {
    const wiz = player('wizard', { x: 1, y: 4 })
    const sleep = spell(wiz, 'Sleep')
    expect(sleepPool(sleep, 1)).toEqual({ count: 5, sides: 8, bonus: 0 })
    expect(sleepPool(sleep, 3).count).toBe(9)
    expect(sleepPool(spell(wiz, 'Fire Bolt'), 1).count).toBe(0)
    const g = monster('goblin', { x: 6, y: 4 }, 7)
    castSleep(scriptRng([[2, 8], [2, 8], [2, 8], [1, 8], [1, 8]]), wiz, sleep, g.pos, [wiz, g], 1)
    expect(hasCondition(g, 'unconscious') && isDormant(g) && isIncapacitated(g)).toBe(true)
    applyDamage(g, 2, false, [])
    expect(hasCondition(g, 'unconscious')).toBe(false)
    expect(g.condTimers?.unconscious).toBeUndefined()
  })
})

describe('Hypnotic Pattern', () => {
  it('entrances creatures in the burst that fail a WIS save, until damaged', () => {
    const bard = player('bard', { x: 1, y: 4 })
    const pattern = spell(bard, 'Hypnotic Pattern')
    const a = monster('orc', { x: 6, y: 4 })
    const b = monster('orc', { x: 7, y: 4 })
    castPattern(scriptRng([[2, 20], [19, 20]]), bard, pattern, { x: 6, y: 4 }, [bard, a, b])
    expect(hasCondition(a, 'incapacitated')).toBe(true)
    expect(hasCondition(b, 'incapacitated')).toBe(false)
    expect(bard.concentration).toBe('Hypnotic Pattern')
    expect(combatMode(bard, a, pattern)).toBe('normal') // charmed + incapacitated grants no advantage
    applyDamage(a, 1, false, [])
    expect(hasCondition(a, 'incapacitated')).toBe(false)
    // Never its own caster; damage soaked by temporary HP still breaks the trance.
    const near = monster('orc', { x: 2, y: 4 })
    castPattern(scriptRng([[2, 20]]), bard, pattern, { x: 1, y: 4 }, [bard, near])
    expect(hasCondition(bard, 'incapacitated')).toBe(false)
    near.tempHp = 10
    applyDamage(near, 3, false, [])
    expect(hasCondition(near, 'incapacitated')).toBe(false)
  })
})

describe('Conjure Animals', () => {
  it('brings beasts in on the caster side; they vanish when concentration ends', () => {
    const druid = player('druid', { x: 2, y: 4 })
    const conjure = spell(druid, 'Conjure Animals')
    expect(conjureCount(conjure, 3)).toBe(2)
    expect(conjureCount(conjure, 5)).toBe(4)
    expect(conjureCount(conjure, 9)).toBe(8)
    expect(conjureCount(spell(druid, 'Produce Flame'), 3)).toBe(0)
    const foe = monster('orc', { x: 9, y: 4 })
    const beasts = conjureBeasts(druid, conjure, [druid, foe], testMap, 3, (i) => `ally-${i}`)
    expect(beasts.map((b) => b.id)).toEqual(['ally-0', 'ally-1'])
    for (const b of beasts) {
      expect(b.team).toBe('player')
      expect(b.summoner).toBe(druid.id)
      expect(makesDeathSaves(b)).toBe(false)
      expect(Math.max(Math.abs(b.pos.x - 2), Math.abs(b.pos.y - 4))).toBe(1)
    }
    expect(druid.concentration).toBe('Conjure Animals')
    endConcentration(druid, [druid, foe, ...beasts])
    expect(beasts.every((b) => b.hp === 0 && isOutOfFight(b))).toBe(true)
  })

  it('a summon at 0 HP simply drops (no death saves, no mercy cap)', () => {
    const druid = player('druid', { x: 2, y: 4 })
    const [wolf] = conjureBeasts(druid, spell(druid, 'Conjure Animals'), [druid], testMap, 3, (i) => `ally-${i}`)
    const ev: CombatEvent[] = []
    applyDamage(wolf, wolf.maxHp, false, ev)
    expect(ev.some((e) => e.kind === 'dead')).toBe(true)
    expect(wolf.deathSaves).toBeUndefined()
    // Concentration lapses when the druid is downed → beasts leave.
    const [w2] = conjureBeasts(druid, spell(druid, 'Conjure Animals'), [druid], testMap, 3, (i) => `ally-${i + 5}`)
    druid.hp = 0
    enforceConcentration([druid, w2])
    expect(w2.hp).toBe(0)
  })

  it('castControl spends the slot and dispatches every kind', () => {
    const druid = player('druid', { x: 2, y: 4 })
    const slots = [...druid.spellSlots!]
    const r = castControl(makeRng(1), druid, spell(druid, 'Conjure Animals'), {}, [druid], testMap, (i) => `a${i}`)
    expect(r.summons.length).toBe(2)
    expect(druid.spellSlots![2]).toBe(slots[2] - 1)
    druid.spellSlots = [0, 0, 0]
    expect(castControl(makeRng(1), druid, spell(druid, 'Conjure Animals'), {}, [druid], testMap, (i) => `a${i}`)).toEqual({ events: [], summons: [] })
    expect(castControl(makeRng(1), druid, spell(druid, 'Produce Flame'), {}, [druid], testMap, (i) => `a${i}`).summons).toEqual([])
    const bard = player('bard', { x: 1, y: 4 })
    const orc = monster('orc', { x: 3, y: 4 })
    expect(castControl(scriptRng([[1, 20]]), bard, spell(bard, 'Hold Person'), { targets: [orc] }, [bard, orc], testMap, String).events.length).toBeGreaterThan(1)
    const g = monster('goblin', { x: 6, y: 4 }, 3)
    castControl(makeRng(2), bard, spell(bard, 'Sleep'), { center: g.pos }, [bard, g], testMap, String)
    expect(hasCondition(g, 'unconscious')).toBe(true)
    const o2 = monster('orc', { x: 7, y: 7 })
    castControl(scriptRng([[1, 20]]), bard, spell(bard, 'Hypnotic Pattern'), { center: o2.pos }, [bard, o2], testMap, String)
    expect(hasCondition(o2, 'incapacitated')).toBe(true)
    const ranger = player('ranger', { x: 1, y: 7 })
    const prey = monster('orc', { x: 4, y: 7 })
    castControl(makeRng(1), ranger, spell(ranger, "Hunter's Mark"), { targets: [prey] }, [ranger, prey], testMap, String)
    expect(markedBy(ranger, [ranger, prey])).toBe(prey)
  })
})

describe("Hunter's Mark", () => {
  it('adds 1d6 to the marker’s weapon hits on the quarry, and moves when the quarry drops', () => {
    const ranger = mkBattler({ id: 'r', team: 'player', pos: { x: 2, y: 4 }, attacks: [sword, { name: "Hunter's Mark", toHit: 5, damage: { count: 0, sides: 0, bonus: 0 }, damageType: 'force', range: 18, source: 'spell', slotLevel: 1, control: { kind: 'mark', bonus: { count: 1, sides: 6, bonus: 0 } } }] })
    const mark = ranger.attacks[1]
    const orc = monster('orc', { x: 3, y: 4 }, 30)
    const other = monster('orc', { x: 4, y: 4 }, 30)
    placeMark(ranger, mark, orc, [ranger, orc, other], true)
    expect(markedBy(ranger, [ranger, orc, other])).toBe(orc)
    expect(ranger.concentration).toBe("Hunter's Mark")
    resolveAttack(scriptRng([[15, 20], [3, 6], [5, 6]]), ranger, sword, orc)
    expect(orc.hp).toBe(30 - (3 + 2 + 5))
    placeMark(ranger, mark, other, [ranger, orc, other], false)
    expect(hasCondition(orc, 'marked')).toBe(false)
    expect(markedBy(ranger, [ranger, orc, other])).toBe(other)
    expect(placeMark(ranger, sword, orc, [ranger, orc], true)).toEqual([])
  })
})

describe('pushes, beams, upcasting, temporary HP', () => {
  it('pushAway moves a creature straight back until a wall or a creature stops it', () => {
    const t = monster('orc', { x: 3, y: 4 })
    expect(pushAway(t, { x: 2, y: 4 }, 4, testMap, [t])).toBe(4)
    expect(t.pos).toEqual({ x: 7, y: 4 })
    const w = monster('orc', { x: 3, y: 1 })
    expect(pushAway(w, { x: 2, y: 1 }, 4, testMap, [w])).toBe(1) // (5,1) is a wall
    const blocker = monster('goblin', { x: 5, y: 7 })
    const b = monster('orc', { x: 3, y: 7 })
    expect(pushAway(b, { x: 2, y: 7 }, 4, testMap, [b, blocker])).toBe(1)
    expect(pushAway(b, b.pos, 2, testMap, [b])).toBe(0)
  })

  it('Eldritch Blast fires one beam per die; Repelling Blast pushes per hit', () => {
    const lock = player('warlock', { x: 1, y: 4 })
    const eb = spell(lock, 'Eldritch Blast')
    expect(eb.beams).toBe(2)
    const orc = monster('orc', { x: 2, y: 4 }, 100)
    const ev = resolveAttack(scriptRng([[15, 20], [4, 10], [15, 20], [4, 10]]), lock, eb, orc, 'normal', [lock, orc], testMap)
    expect(ev.filter((e) => e.kind === 'attack').length).toBe(2)
    expect(orc.hp).toBe(100 - 2 * (4 + 2))
    expect(orc.pos.x).toBe(6) // 2 tiles per beam
  })

  it('upcast adds the "At Higher Levels" dice (and rays) per slot level', () => {
    const lock = player('warlock', { x: 1, y: 4 })
    const shatter = spell(lock, 'Shatter')
    expect(castingLevel(lock, shatter)).toBe(3) // Pact Magic slots are 3rd level
    expect(upcast(shatter, 3).damage).toEqual({ count: 4, sides: 8, bonus: 0 })
    expect(upcast(shatter, 2)).toBe(shatter)
    const wiz = player('wizard', { x: 1, y: 4 })
    const ray = upcast(spell(wiz, 'Scorching Ray'), 3)
    expect(ray.damage.count).toBe(8)
    expect(ray.beams).toBe(4)
    const cleric = player('cleric', { x: 1, y: 4 })
    const cure = upcast(spell(cleric, 'Cure Wounds'), 3)
    expect(cure.heal?.count).toBe(3)
    expect(cure.slotLevel).toBe(3)
    expect(upcast(spell(wiz, 'Sleep'), 3)).toBe(spell(wiz, 'Sleep')) // pool scales via sleepPool instead
  })

  it('temporary HP soak damage first and never stack', () => {
    const p = player('fighter', { x: 1, y: 4 })
    grantTempHp(p, 5)
    grantTempHp(p, 3)
    expect(p.tempHp).toBe(5)
    applyDamage(p, 3, false, [])
    expect(p.tempHp).toBe(2)
    expect(p.hp).toBe(p.maxHp)
    applyDamage(p, 6, false, [])
    expect(p.tempHp).toBeUndefined()
    expect(p.hp).toBe(p.maxHp - 4)
  })

  it("Dark One's Blessing: a Fiend warlock gains CHA + level temp HP on a kill", () => {
    const lock = player('warlock', { x: 1, y: 4 })
    const eb = spell(lock, 'Eldritch Blast')
    const gob = monster('goblin', { x: 3, y: 4 }, 3)
    resolveAttack(scriptRng([[15, 20], [4, 10]]), lock, eb, gob)
    expect(gob.hp).toBe(0)
    expect(lock.tempHp).toBe(2 + 5)
    const fighter = player('fighter', { x: 1, y: 7 })
    const g2 = monster('goblin', { x: 2, y: 7 }, 1)
    resolveAttack(makeRng(5), fighter, { ...sword, toHit: 99 }, g2)
    expect(fighter.tempHp).toBeUndefined()
  })

  it('Natural Recovery regains slots worth half the druid level, highest first', () => {
    expect(naturalRecovery([0, 0, 0], [4, 3, 2], 5)).toEqual({ slots: [0, 0, 1], recovered: true })
    expect(naturalRecovery([0, 1, 2], [4, 3, 2], 5)).toEqual({ slots: [1, 2, 2], recovered: true })
    expect(naturalRecovery([4, 3, 2], [4, 3, 2], 5)).toEqual({ slots: [4, 3, 2], recovered: false })
  })

  it('healing from 0 HP wakes a downed creature and resets its death saves', () => {
    const p = player('fighter', { x: 1, y: 4 })
    p.hp = 0
    p.conditions.push('unconscious')
    p.deathSaves = { successes: 1, failures: 2, stable: false, dead: false }
    expect(healBattler(p, 5)).toBe(5)
    expect(hasCondition(p, 'unconscious')).toBe(false)
    expect(p.deathSaves).toEqual({ successes: 0, failures: 0, stable: false, dead: false })
    expect(healBattler(p, 1000)).toBe(p.maxHp - 5)
  })

  it('Bardic Inspiration rescues a failed saving throw when the die can make it', () => {
    const p = player('fighter', { x: 1, y: 4 })
    p.conditions.push('inspired')
    p.inspirationDie = 8
    // CON save: d20 8 + 5 = 13 < 15, the d8 adds 4 → 17.
    expect(saveSucceeds(scriptRng([[8, 20], [4, 8]]), p, 'con', 15)).toBe(true)
    expect(hasCondition(p, 'inspired')).toBe(false)
    // Hopeless (13 + 8 < 30): the die is kept.
    p.conditions.push('inspired')
    p.inspirationDie = 8
    expect(saveSucceeds(scriptRng([[8, 20]]), p, 'con', 30)).toBe(false)
    expect(hasCondition(p, 'inspired')).toBe(true)
  })

  it('clearCondition drops the condition with its timer, source and save', () => {
    const b = mkBattler({ conditions: ['paralyzed'], condTimers: { paralyzed: 3 }, condSource: { paralyzed: 'x' }, saveEnds: { paralyzed: { ability: 'wis', dc: 12 } } })
    clearCondition(b, 'paralyzed')
    expect(b.conditions).toEqual([])
    expect([b.condTimers?.paralyzed, b.condSource?.paralyzed, b.saveEnds?.paralyzed]).toEqual([undefined, undefined, undefined])
  })
})
