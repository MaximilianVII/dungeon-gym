import { describe, it, expect } from 'vitest'
import { parseDamage, rollDamage, rollD20 } from '../src/combat/dice'
import { buildPlayerBattler, buildEnemyBattler, rollInitiative, monsterDepthScale, cloneAttack } from '../src/combat/setup'
import { resolveAttack, resolveAreaAttack, rollDeathSave, applyDamage, combatMode, tickConditions, rageDamageBonus } from '../src/combat/resolve'
import { planEnemyTurn } from '../src/combat/ai'
import { bossTurn } from '../src/combat/boss'
import { GOBLIN, SKELETON, CULTIST, ACOLYTE, BANDIT, ORC_WARLORD, getMonster, bossForBiome } from '../src/combat/monsters'
import { affixChance, rollAffix, applyAffix } from '../src/combat/affixes'
import { grantAbilities } from '../src/combat/abilities'
import { addCondition, hasCondition, isDown, isOutOfFight, removeCondition, type CombatAttack, type CombatEvent } from '../src/combat/types'
import { testMap } from '../src/game/map'
import { lineOfSight } from '../src/game/los'
import { makeRng } from '../src/rng'
import { SAMPLE_SOURCE, mkBattler, scriptRng } from './helpers'

const sword16: CombatAttack = { name: 'Longsword', toHit: 6, damage: { count: 1, sides: 6, bonus: 2 }, damageType: 'slashing', range: 1, source: 'weapon' }

describe('dice', () => {
  it('parses damage notation and rejects garbage', () => {
    expect(parseDamage('1d8+3')).toEqual({ count: 1, sides: 8, bonus: 3 })
    expect(parseDamage('2d6')).toEqual({ count: 2, sides: 6, bonus: 0 })
    expect(parseDamage('1d10-1')).toEqual({ count: 1, sides: 10, bonus: -1 })
    expect(() => parseDamage('banana')).toThrow()
  })

  it('rolls damage, doubling dice on a crit', () => {
    expect(rollDamage(scriptRng([[5, 8]]), { count: 1, sides: 8, bonus: 3 }).total).toBe(8)
    expect(rollDamage(scriptRng([[5, 8], [4, 8]]), { count: 1, sides: 8, bonus: 3 }, true).total).toBe(12)
  })

  it('never returns negative damage', () => {
    expect(rollDamage(scriptRng([[1, 4]]), { count: 1, sides: 4, bonus: -5 }).total).toBe(0)
  })

  it('applies advantage / disadvantage', () => {
    expect(rollD20(scriptRng([[7, 20], [15, 20]]), 'advantage').value).toBe(15)
    expect(rollD20(scriptRng([[7, 20], [15, 20]]), 'disadvantage').value).toBe(7)
    expect(rollD20(scriptRng([[20, 20]])).nat20).toBe(true)
    expect(rollD20(scriptRng([[1, 20]])).nat1).toBe(true)
  })
})

describe('setup', () => {
  it('rolls initiative and orders highest first', () => {
    const player = buildPlayerBattler(SAMPLE_SOURCE, { x: 1, y: 1 })
    const goblin = buildEnemyBattler(GOBLIN, 'g1', { x: 5, y: 1 })
    const { order } = rollInitiative(scriptRng([[5, 20], [18, 20]]), [player, goblin])
    expect(order.map((b) => b.id)).toEqual(['g1', 'player'])
  })

  it('breaks initiative ties in the player’s favour', () => {
    const player = buildPlayerBattler({ ...SAMPLE_SOURCE, dexModifier: 2 }, { x: 1, y: 1 })
    const goblin = buildEnemyBattler(GOBLIN, 'g1', { x: 5, y: 1 })
    const { order } = rollInitiative(scriptRng([[10, 20], [10, 20]]), [goblin, player])
    expect(order[0].id).toBe('player')
  })

  it('gives battlers deep copies of the source attacks (no shared objects)', () => {
    const b = buildPlayerBattler(SAMPLE_SOURCE, { x: 0, y: 0 })
    b.attacks[0].toHit += 10
    b.attacks[0].damage.bonus += 10
    expect(SAMPLE_SOURCE.attacks[0].toHit).toBe(6)
    expect(SAMPLE_SOURCE.attacks[0].damage.bonus).toBe(3)
    const c = cloneAttack({ ...sword16, heal: { count: 1, sides: 4, bonus: 0 }, applies: { condition: 'prone', rounds: 1 } })
    expect(c.heal).toEqual({ count: 1, sides: 4, bonus: 0 })
  })

  it('falls back to an unarmed strike when the sheet has no weapon', () => {
    const b = buildPlayerBattler({ ...SAMPLE_SOURCE, attacks: [] }, { x: 0, y: 0 })
    expect(b.attacks[0].name).toBe('Unarmed strike')
  })

  it('scales monsters with depth and never mutates the stat block', () => {
    expect(monsterDepthScale(0)).toEqual({ hpMult: 1, acBonus: 0, hitBonus: 0, dmgBonus: 0 })
    expect(monsterDepthScale(24)).toMatchObject({ acBonus: 2, hitBonus: 3, dmgBonus: 4 })
    const g0 = buildEnemyBattler(GOBLIN, 'g1', { x: 0, y: 0 }, 0)
    expect(g0).toMatchObject({ hp: 7, ac: 15 })
    expect(g0.affix).toBeUndefined()
    const deep = buildEnemyBattler(GOBLIN, 'g1', { x: 0, y: 0 }, 24)
    expect(deep.maxHp).toBeGreaterThan(7)
    expect(GOBLIN.attacks[0].toHit).toBe(4)
  })

  it('builds a boss with a telegraphed AoE and always an affix', () => {
    const boss = buildEnemyBattler(ORC_WARLORD, 'b1', { x: 0, y: 0 }, 4)
    expect(boss.bossAoe?.area).toBe(2)
    expect(boss.telegraphCdMax).toBe(3)
    expect(boss.affix).toBeDefined()
    expect(getMonster('nope')).toBeUndefined()
    expect(bossForBiome('cave')).toBe('spider-broodmother')
    expect(bossForBiome('unknown')).toBe('orc-warlord')
  })
})

describe('affixes', () => {
  it('are deterministic, absent on floor 1 and capped', () => {
    expect(affixChance(0)).toBe(0)
    expect(affixChance(100)).toBe(0.4)
    expect(rollAffix('goblin-3', 0, false)).toBeNull()
    expect(rollAffix('goblin-3', 7, false)).toBe(rollAffix('goblin-3', 7, false))
    expect(rollAffix('boss', 0, true)).not.toBeNull()
  })

  it('apply their stat changes', () => {
    const s = mkBattler({ maxHp: 10, hp: 10, ac: 10, name: 'Orc' })
    applyAffix(s, 'shielded')
    expect(s).toMatchObject({ ac: 13, maxHp: 14, hp: 14, name: 'Shielded Orc' })
    const h = mkBattler({ speedTiles: 6 })
    applyAffix(h, 'hasted')
    expect(h).toMatchObject({ speedTiles: 8, attacksPerAction: 2 })
    const b = mkBattler({ attacks: [sword16] })
    applyAffix(b, 'brutal')
    expect(b.attacks[0]).toMatchObject({ toHit: 8, damage: { bonus: 5 } })
    expect(sword16.toHit).toBe(6)
  })

  it('a vampiric attacker heals for half the damage it deals', () => {
    const vamp = mkBattler({ affix: 'vampiric', hp: 2, maxHp: 20 })
    const target = mkBattler({ team: 'player', hp: 30, maxHp: 40, ac: 5 })
    resolveAttack(scriptRng([[15, 20], [6, 6]]), vamp, sword16, target) // 6+2 = 8 dmg
    expect(target.hp).toBe(22)
    expect(vamp.hp).toBe(6)
  })
})

describe('resolveAttack', () => {
  const attacker = buildPlayerBattler(SAMPLE_SOURCE, { x: 0, y: 0 })
  const freshGoblin = () => buildEnemyBattler(GOBLIN, 'g1', { x: 0, y: 0 })

  it('hits and deals damage when total beats AC', () => {
    const g = freshGoblin()
    const events = resolveAttack(scriptRng([[18, 20], [4, 6]]), attacker, sword16, g)
    expect(events.find((e) => e.kind === 'attack' && e.hit)).toBeTruthy()
    expect(g.hp).toBe(1)
  })

  it('misses when total is below AC', () => {
    const g = freshGoblin()
    const events = resolveAttack(scriptRng([[2, 20]]), attacker, sword16, g)
    expect(g.hp).toBe(7)
    expect(events.some((e) => e.kind === 'damage')).toBe(false)
  })

  it('crits on a natural 20 (auto-hit, doubled dice) and can drop a foe', () => {
    const g = freshGoblin()
    const events = resolveAttack(scriptRng([[20, 20], [4, 6], [5, 6]]), attacker, sword16, g)
    expect(events.some((e) => e.kind === 'attack' && e.crit)).toBe(true)
    expect(g.hp).toBe(0)
    expect(events.some((e) => e.kind === 'dead')).toBe(true)
  })

  it('rage adds damage on melee and halves incoming physical damage', () => {
    expect(rageDamageBonus(1)).toBe(2)
    expect(rageDamageBonus(9)).toBe(3)
    expect(rageDamageBonus(16)).toBe(4)
    const rager = mkBattler({ conditions: ['raging'], classLevels: { barbarian: 9 } })
    const t = mkBattler({ hp: 30, maxHp: 30, ac: 5 })
    resolveAttack(scriptRng([[15, 20], [4, 6]]), rager, sword16, t) // 4+2+3
    expect(t.hp).toBe(21)
    const ragingTarget = mkBattler({ hp: 30, maxHp: 30, ac: 5, conditions: ['raging'] })
    resolveAttack(scriptRng([[15, 20], [4, 6]]), mkBattler(), sword16, ragingTarget) // floor(6/2)
    expect(ragingTarget.hp).toBe(27)
  })

  it('a hit with an applies-rider inflicts the condition for its duration', () => {
    const target = mkBattler({ hp: 10, ac: 5 })
    const web: CombatAttack = { name: 'Web', toHit: 10, damage: { count: 1, sides: 4, bonus: 0 }, damageType: 'bludgeoning', range: 6, applies: { condition: 'restrained', rounds: 2 } }
    resolveAttack(scriptRng([[15, 20], [2, 4]]), mkBattler(), web, target)
    expect(hasCondition(target, 'restrained')).toBe(true)
    expect(target.condTimers?.restrained).toBe(2)
  })
})

describe('area attacks', () => {
  const fireball: CombatAttack = { name: 'Fireball', toHit: 6, damage: { count: 8, sides: 6, bonus: 0 }, damageType: 'fire', range: 30, area: 2, source: 'spell', applies: { condition: 'frightened', rounds: 1 } }

  it('rolls once, saves for half, never hits allies or targets out of range', () => {
    const caster = mkBattler({ team: 'player', id: 'p' })
    const ally = mkBattler({ team: 'player', id: 'a', pos: { x: 1, y: 0 }, hp: 50, maxHp: 50 })
    const near = mkBattler({ id: 'n', pos: { x: 1, y: 1 }, hp: 50, maxHp: 50 })
    const far = mkBattler({ id: 'f', pos: { x: 9, y: 9 }, hp: 50, maxHp: 50 })
    const saver = mkBattler({ id: 's', pos: { x: 0, y: 2 }, hp: 50, maxHp: 50 })
    const dice: [number, number][] = Array.from({ length: 8 }, () => [3, 6] as [number, number]) // 24
    resolveAreaAttack(scriptRng([...dice, [2, 20], [20, 20]]), caster, fireball, { x: 0, y: 0 }, [caster, ally, near, far, saver], 2)
    expect(ally.hp).toBe(50)
    expect(far.hp).toBe(50)
    expect(near.hp).toBe(26) // failed save (2 vs DC 14) → full + rider
    expect(hasCondition(near, 'frightened')).toBe(true)
    expect(saver.hp).toBe(38) // saved → half
  })
})

describe('death saves + mercy rule', () => {
  function downedPlayer() {
    const p = buildPlayerBattler(SAMPLE_SOURCE, { x: 0, y: 0 })
    p.hp = 5
    return p
  }

  it('caps one hit on a full-HP player to 60 % of max HP', () => {
    const p = buildPlayerBattler(SAMPLE_SOURCE, { x: 0, y: 0 })
    applyDamage(p, 40, false, [])
    expect(p.hp).toBe(44 - 26)
  })

  it('drops to unconscious (not dead) on first reaching 0', () => {
    const p = downedPlayer()
    const ev: CombatEvent[] = []
    applyDamage(p, 8, false, ev)
    expect(p.hp).toBe(0)
    expect(isDown(p)).toBe(true)
    expect(p.deathSaves?.dead).toBe(false)
    expect(hasCondition(p, 'unconscious')).toBe(true)
  })

  it('massive damage kills outright', () => {
    const p = downedPlayer()
    applyDamage(p, 100, false, [])
    expect(p.deathSaves?.dead).toBe(true)
    expect(isOutOfFight(p)).toBe(true)
  })

  it('counts successes and failures; three failures kill', () => {
    const p = downedPlayer()
    p.hp = 0
    rollDeathSave(scriptRng([[15, 20]]), p)
    expect(p.deathSaves?.successes).toBe(1)
    for (let i = 0; i < 3; i++) rollDeathSave(scriptRng([[5, 20]]), p)
    expect(p.deathSaves?.dead).toBe(true)
    expect(rollDeathSave(scriptRng([]), p)).toEqual([])
  })

  it('three successes stabilise', () => {
    const p = downedPlayer()
    p.hp = 0
    for (let i = 0; i < 3; i++) rollDeathSave(scriptRng([[12, 20]]), p)
    expect(p.deathSaves?.stable).toBe(true)
  })

  it('a natural 1 is two failures; a natural 20 revives at 1 HP', () => {
    const p1 = downedPlayer()
    p1.hp = 0
    rollDeathSave(scriptRng([[1, 20]]), p1)
    expect(p1.deathSaves?.failures).toBe(2)
    const p2 = downedPlayer()
    p2.hp = 0
    addCondition(p2, 'unconscious')
    rollDeathSave(scriptRng([[20, 20]]), p2)
    expect(p2.hp).toBe(1)
    expect(hasCondition(p2, 'unconscious')).toBe(false)
  })

  it('taking a hit while already down is a failure (two on a crit); three kill', () => {
    const p = downedPlayer()
    p.hp = 0
    applyDamage(p, 3, true, [])
    expect(p.deathSaves?.failures).toBe(2)
    applyDamage(p, 3, false, [])
    expect(p.deathSaves?.dead).toBe(true)
  })
})

describe('conditions', () => {
  const melee: CombatAttack = { name: 'Sword', toHit: 5, damage: { count: 1, sides: 6, bonus: 0 }, damageType: 'slashing', range: 1 }
  const bow: CombatAttack = { ...melee, name: 'Bow', range: 12 }

  it('nets advantage/disadvantage from conditions (and cancels them)', () => {
    const frightened = mkBattler({ conditions: ['frightened'] })
    const plain = mkBattler()
    expect(combatMode(frightened, plain, melee)).toBe('disadvantage')
    const restrained = mkBattler({ conditions: ['restrained'] })
    expect(combatMode(plain, restrained, melee)).toBe('advantage')
    expect(combatMode(frightened, restrained, melee)).toBe('normal')
    expect(combatMode(mkBattler({ conditions: ['inspired'] }), plain, melee)).toBe('normal') // the die is added on a miss instead
    expect(combatMode(plain, mkBattler({ conditions: ['dodging'] }), melee)).toBe('disadvantage')
    expect(combatMode(plain, mkBattler({ conditions: ['prone'] }), melee)).toBe('advantage')
    expect(combatMode(plain, mkBattler({ conditions: ['prone'] }), bow)).toBe('disadvantage')
  })

  it('add/remove are idempotent and tickConditions drops expired ones', () => {
    const b = mkBattler()
    addCondition(b, 'poisoned')
    addCondition(b, 'poisoned')
    expect(b.conditions).toEqual(['poisoned'])
    removeCondition(b, 'prone')
    b.condTimers = { poisoned: 2 }
    tickConditions(b)
    expect(b.condTimers.poisoned).toBe(1)
    tickConditions(b)
    expect(hasCondition(b, 'poisoned')).toBe(false)
    tickConditions(mkBattler())
  })
})

describe('enemy AI', () => {
  it('steps toward the player and attacks in melee when adjacent', () => {
    const player = buildPlayerBattler(SAMPLE_SOURCE, { x: 1, y: 4 })
    const goblin = buildEnemyBattler(GOBLIN, 'g1', { x: 5, y: 4 })
    const plan = planEnemyTurn(goblin, [player, goblin], testMap)
    expect(plan.moves.length).toBeGreaterThan(0)
    expect(Math.max(Math.abs(plan.finalPos.x - 1), Math.abs(plan.finalPos.y - 4))).toBe(1)
    expect(plan.attack?.attack.range).toBe(1)
    expect(plan.attack?.targetId).toBe('player')
  })

  it('attacks without moving when already adjacent', () => {
    const player = buildPlayerBattler(SAMPLE_SOURCE, { x: 2, y: 4 })
    const skeleton = buildEnemyBattler(SKELETON, 's1', { x: 3, y: 4 })
    const plan = planEnemyTurn(skeleton, [player, skeleton], testMap)
    expect(plan.moves.length).toBe(0)
    expect(plan.attack?.attack.range).toBe(1)
  })

  it('a ranged foe never fires through a wall', () => {
    const player = buildPlayerBattler(SAMPLE_SOURCE, { x: 1, y: 1 })
    const cultist = buildEnemyBattler(CULTIST, 'c1', { x: 8, y: 1 })
    expect(lineOfSight(testMap, { x: 8, y: 1 }, { x: 1, y: 1 })).toBe(false)
    const plan = planEnemyTurn(cultist, [player, cultist], testMap)
    if (plan.attack && plan.attack.attack.range > 1) expect(lineOfSight(testMap, plan.finalPos, player.pos)).toBe(true)
    else expect(plan.moves.length).toBeGreaterThan(0)
  })

  it('a kiting foe backs off when a player is adjacent', () => {
    const player = buildPlayerBattler(SAMPLE_SOURCE, { x: 4, y: 4 })
    const bandit = buildEnemyBattler(BANDIT, 'b1', { x: 5, y: 4 })
    const plan = planEnemyTurn(bandit, [player, bandit], testMap)
    expect(Math.max(Math.abs(plan.finalPos.x - 4), Math.abs(plan.finalPos.y - 4))).toBeGreaterThan(1)
  })

  it('a healer mends a wounded ally instead of attacking', () => {
    const player = buildPlayerBattler(SAMPLE_SOURCE, { x: 1, y: 4 })
    const acolyte = buildEnemyBattler(ACOLYTE, 'a1', { x: 6, y: 4 })
    const goblin = buildEnemyBattler(GOBLIN, 'g1', { x: 7, y: 4 })
    goblin.hp = 2
    const plan = planEnemyTurn(acolyte, [player, acolyte, goblin], testMap)
    expect(plan.heal?.targetId).toBe('g1')
  })

  it('does nothing with no living players; a restrained foe cannot move', () => {
    const goblin = buildEnemyBattler(GOBLIN, 'g1', { x: 5, y: 4 })
    expect(planEnemyTurn(goblin, [goblin], testMap).moves).toEqual([])
    const player = buildPlayerBattler(SAMPLE_SOURCE, { x: 1, y: 4 })
    goblin.conditions = ['restrained']
    expect(planEnemyTurn(goblin, [player, goblin], testMap).moves).toEqual([])
  })
})

describe('boss turns', () => {
  it('winds up, then bursts, then cools down', () => {
    const boss = buildEnemyBattler(ORC_WARLORD, 'b1', { x: 4, y: 4 })
    const p = buildPlayerBattler(SAMPLE_SOURCE, { x: 5, y: 4 })
    const rng = makeRng(3)
    const wind = bossTurn(rng, boss, [p, boss])
    expect(wind.consumed).toBe(true)
    expect(boss.telegraphCenter).toEqual({ x: 5, y: 4 })
    const burst = bossTurn(rng, boss, [p, boss])
    expect(burst.consumed).toBe(true)
    expect(boss.telegraphCenter).toBeUndefined()
    expect(boss.telegraphCd).toBe(3)
    expect(bossTurn(rng, boss, [p, boss]).consumed).toBe(false)
    expect(boss.telegraphCd).toBe(2)
  })

  it('is a no-op for ordinary foes and when no foe is left', () => {
    const g = buildEnemyBattler(GOBLIN, 'g1', { x: 0, y: 0 })
    expect(bossTurn(makeRng(1), g, [g]).consumed).toBe(false)
    const boss = buildEnemyBattler(ORC_WARLORD, 'b1', { x: 4, y: 4 })
    expect(bossTurn(makeRng(1), boss, [boss]).consumed).toBe(false)
  })
})

describe('class abilities', () => {
  it('are granted by class level and deduplicated', () => {
    expect(grantAbilities({ fighter: 1 })).toEqual(['second-wind'])
    expect(grantAbilities({ fighter: 5, rogue: 2, monk: 1 })).toEqual(['second-wind', 'action-surge', 'cunning-dash'])
    expect(grantAbilities({ wizard: 5 })).toEqual([])
  })
})
