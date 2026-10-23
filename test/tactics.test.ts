import { describe, it, expect } from 'vitest'
import { incomingDamage, planControl } from '../src/bot/tactics'
import { botPlayerTurn, type TurnContext } from '../src/bot/policy'
import { buildEnemyBattler, buildPlayerBattler } from '../src/combat/setup'
import { getMonster } from '../src/combat/monsters'
import { hasCondition, type Battler } from '../src/combat/types'
import { starterCharacter, type ClassKey } from '../src/character/build'
import { testMap } from '../src/game/map'
import type { Vec2 } from '../src/game/types'
import type { Genes } from '../src/bot/genome'
import type { UsageTally } from '../src/bot/usage'
import { makeRng } from '../src/rng'
import { genes } from './genes'

// testMap rows 4 and 7 are open floor from x=1 to x=10.

function player(cls: ClassKey, pos: Vec2, id = 'p0'): Battler {
  return buildPlayerBattler({ ...starterCharacter(cls), id }, pos)
}

function monster(key: string, pos: Vec2, hp?: number): Battler {
  const b = buildEnemyBattler(getMonster(key)!, `${key}-${pos.x}-${pos.y}`, pos)
  if (hp !== undefined) b.hp = b.maxHp = hp
  return b
}

const OPTS = { bestDamage: 5, bossFight: false, reserveSlots: false, canSummon: false }

function turn(b: Battler, battlers: Battler[], g: Genes, ctx?: TurnContext, seed = 1): UsageTally {
  const tally: UsageTally = {}
  botPlayerTurn(b, battlers, testMap, makeRng(seed), makeRng(seed + 1000), g, tally, ctx)
  return tally
}

describe('planControl', () => {
  it('sleeps a pack whose HP the likely pool covers', () => {
    const bard = player('bard', { x: 1, y: 4 })
    const pack = [monster('goblin', { x: 7, y: 4 }, 7), monster('goblin', { x: 8, y: 4 }, 7), monster('goblin', { x: 9, y: 4 }, 7)]
    const plan = planControl(bard, [bard, ...pack], testMap, OPTS)
    expect(plan?.attack.name).toBe('Sleep')
    expect(plan?.center).toBeDefined()
  })

  it('never sleeps a burst an ally could be caught in, and not a lone foe it would wake at once', () => {
    const bard = player('bard', { x: 1, y: 4 })
    const ally = player('fighter', { x: 8, y: 5 }, 'p1')
    ally.hp = 3
    const pack = [monster('goblin', { x: 7, y: 4 }, 7), monster('goblin', { x: 8, y: 4 }, 7)]
    expect(planControl(bard, [bard, ally, ...pack], testMap, OPTS)?.attack.name).not.toBe('Sleep')
    const lone = monster('goblin', { x: 7, y: 4 }, 7)
    expect(planControl(bard, [bard, lone], testMap, OPTS)).toBeNull()
  })

  it('holds the toughest humanoid; never while concentrating, saving slots or with every foe out', () => {
    const bard = player('bard', { x: 1, y: 4 })
    const ogreSized = monster('orc', { x: 5, y: 4 }, 50)
    expect(planControl(bard, [bard, ogreSized], testMap, OPTS)?.attack.name).toBe('Hold Person')
    expect(planControl(bard, [bard, ogreSized], testMap, { ...OPTS, reserveSlots: true })).toBeNull()
    bard.concentration = 'Hold Person'
    expect(planControl(bard, [bard, ogreSized], testMap, OPTS)).toBeNull()
    delete bard.concentration
    ogreSized.conditions.push('paralyzed')
    expect(planControl(bard, [bard, ogreSized], testMap, OPTS)).toBeNull()
  })

  it('prefers a Hypnotic Pattern over two big foes, and conjures beasts when it can', () => {
    const bard = player('bard', { x: 1, y: 4 })
    bard.spellSlots = [0, 0, 2]
    const pair = [monster('ogre', { x: 7, y: 4 }, 60), monster('ogre', { x: 8, y: 4 }, 60), monster('ogre', { x: 8, y: 7 }, 60)]
    expect(planControl(bard, [bard, ...pair], testMap, OPTS)?.attack.name).toBe('Hypnotic Pattern')
    const druid = player('druid', { x: 1, y: 4 })
    expect(planControl(druid, [druid, ...pair], testMap, { ...OPTS, canSummon: true })?.attack.name).toBe('Conjure Animals')
    expect(planControl(druid, [druid, ...pair], testMap, OPTS)?.attack.name).not.toBe('Conjure Animals')
  })

  it('incomingDamage counts only foes that would pick this bot and can reach it', () => {
    const me = player('wizard', { x: 2, y: 4 })
    const pal = player('paladin', { x: 9, y: 4 }, 'p1')
    const nearMe = monster('orc', { x: 3, y: 4 })
    const nearPal = monster('orc', { x: 10, y: 4 })
    const one = incomingDamage(me, [me, pal, nearMe, nearPal])
    expect(one).toBeGreaterThan(0)
    expect(incomingDamage(me, [me, pal, nearMe])).toBeCloseTo(one)
    nearMe.conditions.push('paralyzed')
    expect(incomingDamage(me, [me, pal, nearMe, nearPal])).toBe(0)
  })
})

describe('bot turns with the new options', () => {
  it('Healing Word is a bonus action: the bot still attacks, but casts no leveled spell', () => {
    const c = player('cleric', { x: 8, y: 4 })
    c.hp = 8
    const slots = [...c.spellSlots!]
    const tally = turn(c, [c, monster('goblin', { x: 9, y: 4 }, 100)], genes({ healAtHpFrac: 0.5 }))
    expect(tally['Healing Word']).toBe(1)
    expect(c.hp).toBeGreaterThan(8)
    const attacks = Object.keys(tally).filter((k) => k !== 'Healing Word')
    expect(attacks.length).toBe(1)
    expect(['Mace', 'Sacred Flame']).toContain(attacks[0])
    expect(c.spellSlots).toEqual([slots[0] - 1, ...slots.slice(1)])
  })

  it('a support bot picks a downed party-mate back up', () => {
    const c = player('cleric', { x: 1, y: 7 })
    const down = player('fighter', { x: 4, y: 7 }, 'p1')
    down.hp = 0
    down.conditions.push('unconscious')
    const tally = turn(c, [c, down, monster('goblin', { x: 10, y: 4 }, 100)], genes({ healAllies: 0.9 }))
    expect(tally['Healing Word (ally)']).toBe(1)
    expect(down.hp).toBeGreaterThan(0)
    expect(hasCondition(down, 'unconscious')).toBe(false)
  })

  it("a ranger marks its quarry as a bonus action, and moves the mark for free", () => {
    const r = player('ranger', { x: 1, y: 4 })
    const a = monster('orc', { x: 6, y: 4 }, 100)
    const t1 = turn(r, [r, a], genes({ slotReserve: 0 }))
    expect(t1["Hunter's Mark"]).toBe(1)
    expect(a.condSource?.marked).toBe(r.id)
    const slots = [...r.spellSlots!]
    a.hp = 0
    const b = monster('orc', { x: 9, y: 4 }, 100)
    turn(r, [r, a, b], genes({ slotReserve: 0 }), undefined, 2)
    expect(b.condSource?.marked).toBe(r.id)
    expect(r.spellSlots).toEqual(slots)
  })

  it('Conjure Animals hands the beasts to the turn context', () => {
    const d = player('druid', { x: 1, y: 4 })
    const added: Battler[] = []
    const ctx: TurnContext = { summonId: (i) => `ally-${i}`, addSummons: (beasts) => added.push(...beasts) }
    const foes = [monster('ogre', { x: 8, y: 4 }, 60), monster('ogre', { x: 9, y: 4 }, 60)]
    const tally = turn(d, [d, ...foes], genes({ slotReserve: 0 }), ctx)
    expect(tally['Conjure Animals']).toBe(1)
    expect(added.length).toBe(2)
    expect(added.every((b) => b.summoner === d.id)).toBe(true)
  })

  it('leaves a sleeping foe alone while another is awake, and crits a paralyzed one in melee', () => {
    const f = player('fighter', { x: 5, y: 4 })
    const asleep = monster('orc', { x: 6, y: 4 }, 100)
    asleep.conditions.push('unconscious')
    const awake = monster('orc', { x: 4, y: 4 }, 100)
    turn(f, [f, asleep, awake], genes({ focusWeakest: false, actionSurgeEarly: false }))
    expect(asleep.hp).toBe(100)
    expect(awake.hp).toBeLessThan(100)
    const held = monster('orc', { x: 6, y: 4 }, 100)
    held.conditions.push('paralyzed')
    const f2 = player('fighter', { x: 5, y: 4 })
    turn(f2, [f2, held, monster('orc', { x: 4, y: 4 }, 100)], genes({ focusWeakest: false, actionSurgeEarly: false }))
    expect(held.hp).toBeLessThan(100)
  })

  it('a guard (protectAllies) goes for the foe on a badly hurt party-mate', () => {
    const run = (protectAllies: number): { near: Battler; onMate: Battler } => {
      const f = player('fighter', { x: 5, y: 4 })
      const mate = player('wizard', { x: 2, y: 4 }, 'p1')
      mate.hp = 3
      const near = monster('orc', { x: 6, y: 4 }, 100)
      const onMate = monster('orc', { x: 3, y: 4 }, 100)
      turn(f, [f, mate, near, onMate], genes({ protectAllies, focusWeakest: false, focusCasters: 0, actionSurgeEarly: false }))
      return { near, onMate }
    }
    const guard = run(1)
    expect(guard.onMate.hp).toBeLessThan(100)
    expect(guard.near.hp).toBe(100)
    const plain = run(0)
    expect(plain.near.hp).toBeLessThan(100)
  })

  it('does not heal when the heal cannot outpace the damage coming in', () => {
    const b = player('bard', { x: 5, y: 4 })
    b.attacks = b.attacks.filter((a) => a.name !== 'Healing Word')
    b.hp = 10
    b.potions = 0
    const brutes = [monster('ogre', { x: 4, y: 4 }), monster('ogre', { x: 6, y: 4 }), monster('ogre', { x: 5, y: 5 })]
    const tally = turn(b, [b, ...brutes], genes({ healAtHpFrac: 0.9, slotReserve: 1 }))
    expect(tally['Cure Wounds']).toBeUndefined()
  })
})
