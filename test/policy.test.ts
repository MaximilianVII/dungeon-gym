import { describe, it, expect } from 'vitest'
import { botPlayerTurn, pathStep } from '../src/bot/policy'
import type { ClassResources } from '../src/combat/abilities'
import { buildEnemyBattler, buildPlayerBattler } from '../src/combat/setup'
import { CULTIST, GOBLIN } from '../src/combat/monsters'
import { hasCondition, type Battler } from '../src/combat/types'
import { starterCharacter, type ClassKey } from '../src/character/build'
import { tileDistance } from '../src/game/logic'
import { testMap } from '../src/game/map'
import type { Vec2 } from '../src/game/types'
import type { Genes } from '../src/bot/genome'
import type { UsageTally } from '../src/bot/usage'
import { makeRng } from '../src/rng'
import { genes } from './genes'

// testMap rows 4 and 7 are open floor from x=1 to x=10.

function bot(cls: ClassKey, pos: Vec2, id = 'p0'): Battler {
  return buildPlayerBattler({ ...starterCharacter(cls), id }, pos)
}

function foe(pos: Vec2, hp = 100, ac?: number, block = GOBLIN): Battler {
  const g = buildEnemyBattler(block, `e${pos.x}-${pos.y}`, pos)
  g.hp = hp
  g.maxHp = Math.max(hp, 1)
  if (ac !== undefined) g.ac = ac
  return g
}

function turn(b: Battler, battlers: Battler[], g: Genes, res: Partial<ClassResources> = {}, seed = 1): { tally: UsageTally } {
  const tally: UsageTally = {}
  if (b.resources) Object.assign(b.resources, res)
  botPlayerTurn(b, battlers, testMap, makeRng(seed), makeRng(seed + 1000), g, tally)
  return { tally }
}

describe('bonus actions', () => {
  it('openWithRage=false means the barbarian never rages', () => {
    const b1 = bot('barbarian', { x: 2, y: 4 })
    expect(turn(b1, [b1, foe({ x: 3, y: 4 })], genes({ openWithRage: true })).tally.Rage).toBe(1)
    expect(hasCondition(b1, 'raging')).toBe(true)
    const b2 = bot('barbarian', { x: 2, y: 4 })
    expect(turn(b2, [b2, foe({ x: 3, y: 4 })], genes({ openWithRage: false })).tally.Rage).toBeUndefined()
    expect(hasCondition(b2, 'raging')).toBe(false)
  })

  it('Berserker Frenzy adds a swing while raging, and an unspent swing is cleared', () => {
    const b = bot('barbarian', { x: 2, y: 4 })
    b.conditions = ['raging']
    const { tally } = turn(b, [b, foe({ x: 3, y: 4 }, 1000, -100)], genes())
    expect(tally.Frenzy).toBe(1)
    expect(tally.Greataxe).toBe(3)
    expect(b.frenzyAttackPending).toBe(false)
    const r = bot('barbarian', { x: 5, y: 4 })
    r.conditions = ['raging']
    r.hp = 2
    const t2 = turn(r, [r, foe({ x: 6, y: 4 })], genes({ retreatAtHpFrac: 0.6, aggression: 0, healAtHpFrac: 0 }))
    expect(t2.tally.Frenzy).toBe(1)
    expect(t2.tally.Retreat).toBe(1)
    expect(r.frenzyAttackPending).toBe(false)
  })

  it('Second Wind heals 1d10 + fighter level, once per fight', () => {
    const f = bot('fighter', { x: 2, y: 4 })
    f.hp = 5
    const { tally } = turn(f, [f, foe({ x: 3, y: 4 })], genes({ secondWindAtHpFrac: 0.9 }))
    expect(tally['Second Wind']).toBe(1)
    expect(f.resources?.secondWind).toBe(0)
    expect(f.hp).toBeGreaterThanOrEqual(5 + 1 + 5)
    expect(f.hp).toBeLessThanOrEqual(5 + 10 + 5)
    const again = turn(f, [f, foe({ x: 3, y: 4 })], genes({ secondWindAtHpFrac: 0.9 }), { secondWind: 0 })
    expect(again.tally['Second Wind']).toBeUndefined()
  })

  it('Patient Defense when enough foes are adjacent', () => {
    const m = bot('monk', { x: 8, y: 4 })
    turn(m, [m, foe({ x: 7, y: 4 }), foe({ x: 9, y: 4 })], genes({ patientDefenseAdj: 2, protectAllies: 0 }))
    expect(hasCondition(m, 'dodging')).toBe(true)
    const m2 = bot('monk', { x: 8, y: 4 })
    turn(m2, [m2, foe({ x: 7, y: 4 }), foe({ x: 9, y: 4 })], genes({ patientDefenseAdj: 4, protectAllies: 0 }))
    expect(hasCondition(m2, 'dodging')).toBe(false)
  })

  it('Bardic Inspiration (on an ally) is gated by its gene', () => {
    const b = bot('bard', { x: 2, y: 4 })
    expect(turn(b, [b, bot('fighter', { x: 2, y: 7 }, 'p1'), foe({ x: 3, y: 4 })], genes({ inspireBeforeAttack: true })).tally['Bardic Inspiration']).toBe(1)
    const b2 = bot('bard', { x: 2, y: 4 })
    expect(turn(b2, [b2, bot('fighter', { x: 2, y: 7 }, 'p1'), foe({ x: 3, y: 4 })], genes({ inspireBeforeAttack: false })).tally['Bardic Inspiration']).toBeUndefined()
  })

  it('Cunning Action doubles a rogue’s movement', () => {
    const r = bot('rogue', { x: 1, y: 4 })
    const { tally } = turn(r, [r, foe({ x: 10, y: 4 })], genes({ kite: 0, aggression: 1 }))
    expect(tally['Cunning Action']).toBe(1)
    expect(tally.Rapier).toBeGreaterThanOrEqual(1)
  })
})

describe('healing', () => {
  it('heals self below the threshold, spell or potion first per gene', () => {
    const c = bot('cleric', { x: 1, y: 7 })
    c.hp = 5
    c.potions = 1
    expect(turn(c, [c, foe({ x: 10, y: 4 })], genes({ healAtHpFrac: 0.5, potionFirst: false })).tally['Healing Word']).toBe(1)
    expect(c.spellSlots?.[0]).toBe(3)
    expect(c.potions).toBe(1)
    const c2 = bot('cleric', { x: 1, y: 7 })
    c2.hp = 5
    c2.potions = 1
    expect(turn(c2, [c2, foe({ x: 10, y: 4 })], genes({ healAtHpFrac: 0.5, potionFirst: true })).tally['Healing Potion']).toBe(1)
    expect(c2.potions).toBe(0)
    expect(c2.spellSlots?.[0]).toBe(4)
  })

  it('Life domain adds 2 + slot level to heals', () => {
    const c = bot('cleric', { x: 1, y: 7 })
    c.attacks = c.attacks.filter((a) => a.name !== 'Healing Word')
    c.hp = 1
    turn(c, [c, foe({ x: 10, y: 4 })], genes({ healAtHpFrac: 0.5 }))
    expect(c.hp).toBeGreaterThanOrEqual(1 + 1 + 2 + 3) // 1d8+2 (WIS) +2+1
  })

  it('heals a wounded ally only within the spell’s range', () => {
    const allyAt = (pos: Vec2): Battler => {
      const a = bot('fighter', pos, 'p1')
      a.hp = 5
      return a
    }
    const c = bot('cleric', { x: 1, y: 7 })
    const far = allyAt({ x: 5, y: 7 })
    expect(turn(c, [c, far, foe({ x: 10, y: 4 })], genes({ healAllies: 0.9 })).tally['Healing Word (ally)']).toBe(1)
    expect(far.hp).toBeGreaterThan(5)
    const touchOnly = bot('cleric', { x: 1, y: 7 })
    touchOnly.attacks = touchOnly.attacks.filter((a) => a.name !== 'Healing Word')
    const far2 = allyAt({ x: 5, y: 7 })
    expect(turn(touchOnly, [touchOnly, far2, foe({ x: 10, y: 4 })], genes({ healAllies: 0.9 })).tally['Cure Wounds (ally)']).toBeUndefined()
    expect(far2.hp).toBe(5)
    const toucher = bot('cleric', { x: 1, y: 7 })
    toucher.attacks = toucher.attacks.filter((a) => a.name !== 'Healing Word')
    const near = allyAt({ x: 2, y: 7 })
    expect(turn(toucher, [toucher, near, foe({ x: 10, y: 4 })], genes({ healAllies: 0.9 })).tally['Cure Wounds (ally)']).toBe(1)
    const lazy = bot('cleric', { x: 1, y: 7 })
    expect(turn(lazy, [lazy, allyAt({ x: 2, y: 7 }), foe({ x: 10, y: 4 })], genes({ healAllies: 0.2 })).tally['Healing Word (ally)']).toBeUndefined()
  })
})

describe('movement decisions', () => {
  it('retreats away from the foe, or toward an ally when regrouping', () => {
    const low = (): Battler => {
      const f = bot('fighter', { x: 5, y: 4 })
      f.hp = 10
      return f
    }
    const g = genes({ retreatAtHpFrac: 0.6, aggression: 0, healAtHpFrac: 0, secondWindAtHpFrac: 0 })
    const a = low()
    const enemy = foe({ x: 6, y: 4 })
    expect(turn(a, [a, enemy], { ...g, regroup: 0 }).tally.Retreat).toBe(1)
    expect(tileDistance(a.pos, enemy.pos)).toBeGreaterThan(1)
    const b = low()
    const ally = bot('cleric', { x: 5, y: 7 }, 'p1')
    turn(b, [b, ally, foe({ x: 6, y: 4 })], { ...g, regroup: 1 })
    expect(b.pos.y).toBeGreaterThan(4)
  })

  it('kites with a ranged attack when the stance prefers range, else closes to melee', () => {
    const r = bot('rogue', { x: 2, y: 4 })
    expect(turn(r, [r, foe({ x: 9, y: 4 })], genes({ kite: 1, aggression: 0, protectAllies: 0 })).tally.Shortbow).toBe(1)
    expect(r.pos).toEqual({ x: 2, y: 4 })
    const m = bot('rogue', { x: 2, y: 4 })
    expect(turn(m, [m, foe({ x: 9, y: 4 })], genes({ kite: 0, aggression: 1 })).tally.Shortbow).toBeUndefined()
    expect(m.pos.x).toBeGreaterThan(2)
  })

  it('a restrained bot cannot move', () => {
    const r = bot('fighter', { x: 1, y: 4 })
    r.conditions = ['restrained']
    turn(r, [r, foe({ x: 9, y: 4 })], genes())
    expect(r.pos).toEqual({ x: 1, y: 4 })
  })

  it('pathStep routes around walls and returns null when blocked or already there', () => {
    expect(pathStep(testMap, { x: 1, y: 1 }, { x: 1, y: 1 }, new Set())).toBeNull()
    const step = pathStep(testMap, { x: 4, y: 1 }, { x: 6, y: 1 }, new Set())
    expect(step).not.toBeNull()
    expect(pathStep(testMap, { x: 1, y: 1 }, { x: 0, y: 0 }, new Set())).toBeNull()
  })
})

describe('targeting', () => {
  it('focusWeakest picks the lowest-HP foe, otherwise the nearest', () => {
    const run = (focusWeakest: boolean): Battler => {
      const f = bot('fighter', { x: 8, y: 4 })
      const strong = foe({ x: 9, y: 4 }, 100, -100)
      const weak = foe({ x: 7, y: 4 }, 1, -100)
      turn(f, [f, strong, weak], genes({ focusWeakest, focusCasters: 0 }), { actionSurge: 0 })
      return weak
    }
    expect(run(true).hp).toBe(0)
    expect(run(false).hp).toBe(1)
  })

  it('focusCasters is the probability of going for the back line first', () => {
    const run = (focusCasters: number): { cultist: Battler; goblin: Battler } => {
      const f = bot('fighter', { x: 8, y: 4 })
      const cultist = foe({ x: 9, y: 4 }, 100, -100, CULTIST)
      const goblin = foe({ x: 7, y: 4 }, 1, -100)
      turn(f, [f, cultist, goblin], genes({ focusWeakest: true, focusCasters }), { actionSurge: 0 })
      return { cultist, goblin }
    }
    const always = run(1)
    expect(always.goblin.hp).toBe(1)
    expect(always.cultist.hp).toBeLessThan(100)
    expect(run(0).goblin.hp).toBe(0)
  })

  it('slotReserve holds leveled spells away from boss fights', () => {
    const w = bot('wizard', { x: 1, y: 4 })
    const t1 = turn(w, [w, foe({ x: 10, y: 4 }, 1000)], genes({ slotReserve: 1 }))
    expect(t1.tally['Fire Bolt']).toBe(1)
    expect(w.spellSlots).toEqual([4, 3, 2])
    const w2 = bot('wizard', { x: 1, y: 4 })
    const t2 = turn(w2, [w2, foe({ x: 10, y: 4 }, 1000)], genes({ slotReserve: 0 }))
    expect(t2.tally.Fireball).toBe(1)
    expect(w2.spellSlots).toEqual([4, 3, 1])
  })

  it('Action Surge early, or only to finish a low foe', () => {
    const f = bot('fighter', { x: 8, y: 4 })
    expect(turn(f, [f, foe({ x: 9, y: 4 }, 1000, -100)], genes({ actionSurgeEarly: true })).tally['Action Surge']).toBe(1)
    const f2 = bot('fighter', { x: 8, y: 4 })
    expect(turn(f2, [f2, foe({ x: 9, y: 4 }, 1000, -100)], genes({ actionSurgeEarly: false })).tally['Action Surge']).toBeUndefined()
  })
})

describe('no-op turns', () => {
  it('does nothing when downed or when no foe is left', () => {
    const f = bot('fighter', { x: 8, y: 4 })
    f.hp = 0
    expect(turn(f, [f, foe({ x: 9, y: 4 })], genes()).tally).toEqual({})
    const g = bot('fighter', { x: 8, y: 4 })
    expect(turn(g, [g, foe({ x: 9, y: 4 }, 0)], genes()).tally).toEqual({})
  })

  it('a leveled spell without a slot is never cast', () => {
    const w = bot('wizard', { x: 1, y: 4 })
    w.spellSlots = [0, 0, 0]
    const { tally } = turn(w, [w, foe({ x: 10, y: 4 }, 1000)], genes({ slotReserve: 0 }))
    expect(tally.Fireball).toBeUndefined()
    expect(tally['Fire Bolt']).toBe(1)
  })
})
