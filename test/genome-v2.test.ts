import { describe, it, expect } from 'vitest'
import {
  DEFAULT_GENES, GENOME_VERSION, baselineGenome, lootWeights, makeGenome, migrateGenesV1, parseGenome, relevantGenes, serializeGenome,
  validateGenome, type Genes,
} from '../src/bot/genome'
import { botPlayerTurn } from '../src/bot/policy'
import { createRun, equipFoundGear, isRunDone, runResult, stepRun } from '../src/bot/run'
import { bardicDie, maxResources, rageUses, restoreResources } from '../src/combat/abilities'
import { combatMode, resolveAttack } from '../src/combat/resolve'
import { buildEnemyBattler, buildPlayerBattler } from '../src/combat/setup'
import { GOBLIN, ORC_WARLORD } from '../src/combat/monsters'
import { hasCondition, type Battler, type CombatAttack } from '../src/combat/types'
import { starterCharacter, type ClassKey } from '../src/character/build'
import { ARTIFACTS, DEFAULT_LOOT_WEIGHTS, effectScore, pickArtifact } from '../src/items/artifacts'
import { GEAR } from '../src/items/gear'
import { testMap } from '../src/game/map'
import type { Vec2 } from '../src/game/types'
import type { UsageTally } from '../src/bot/usage'
import { makeRng } from '../src/rng'
import { genes } from './genes'
import { mkBattler, scriptRng } from './helpers'

/** A v1 genome payload (no loot genes, threshold kite). */
function v1Payload(classKey: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'dungeon-gym/genome',
    version: 1,
    classKey,
    genes: {
      healAtHpFrac: 0.45, secondWindAtHpFrac: 0.5, retreatAtHpFrac: 0.25, kite: 0.9, patientDefenseAdj: 2,
      openWithRage: true, inspireBeforeAttack: true, actionSurgeEarly: true, focusWeakest: true, potionFirst: false,
      focusCasters: 0.4, slotReserve: 0.4, regroup: 0.5, healAllies: 0.5, protectAllies: 0.5, aggression: 0.5,
      exploreCoverage: 0.65, levelUpOrder: [], ...over,
    },
  }
}

function bot(cls: ClassKey, pos: Vec2, id = 'p0'): Battler {
  return buildPlayerBattler({ ...starterCharacter(cls), id }, pos)
}

function foe(pos: Vec2, hp = 100, block = GOBLIN): Battler {
  const g = buildEnemyBattler(block, `e${pos.x}-${pos.y}`, pos)
  g.hp = hp
  g.maxHp = hp
  g.telegraphCd = 99
  return g
}

function turn(b: Battler, battlers: Battler[], g: Genes, seed = 1): UsageTally {
  const tally: UsageTally = {}
  botPlayerTurn(b, battlers, testMap, makeRng(seed), makeRng(seed + 1000), g, tally)
  return tally
}

describe('genome v2 and the v1 → v2 migration', () => {
  it('is version 2 and adds loot genes with defaults that reproduce v1 loot choice', () => {
    expect(GENOME_VERSION).toBe(2)
    const g = baselineGenome('wizard')
    expect(g.version).toBe(2)
    expect(g.genes).toMatchObject({ lootHp: 0.5, lootAc: 0.5, lootToHit: 0.5, lootDamage: 0.5, lootSpeed: 0.5 })
    expect(lootWeights(g.genes)).toEqual(DEFAULT_LOOT_WEIGHTS)
    expect(relevantGenes(g)).toEqual(expect.arrayContaining(['lootHp', 'lootAc', 'lootToHit', 'lootDamage', 'lootSpeed']))
  })

  it('parses v1 payloads and migrates them; the v1 kite stance is preserved', () => {
    const wiz = parseGenome(JSON.stringify(v1Payload('wizard')))
    expect(wiz.ok).toBe(true)
    if (!wiz.ok) return
    expect(wiz.genome.version).toBe(2)
    expect(wiz.genome.genes.kite).toBe(1) // v1: 0.9 − 0.2 − 0.15 = 0.55 ≥ 0.5 → always keep range
    expect(wiz.genome.genes.lootAc).toBe(0.5)
    const rogue = parseGenome(JSON.stringify(v1Payload('rogue', { kite: 0.4 })))
    expect(rogue.ok && rogue.genome.genes.kite).toBe(0) // v1: 0.05 → always close in
    // v2 serialization round-trips and is canonical.
    const text = serializeGenome(wiz.genome)
    const back = parseGenome(text)
    expect(back.ok && serializeGenome(back.genome)).toBe(text)
    // Baselines are their migrated v1 selves.
    expect(baselineGenome('wizard').genes.kite).toBe(1)
    expect(baselineGenome('rogue').genes.kite).toBe(0)
    expect(migrateGenesV1({ ...DEFAULT_GENES, kite: 0.9, aggression: 0, protectAllies: 0 } as Genes).kite).toBe(1)
  })

  it('is strict per version', () => {
    expect(validateGenome(v1Payload('wizard', { lootHp: 0.5 })).ok).toBe(false) // v1 has no loot genes
    const v2 = JSON.parse(serializeGenome(baselineGenome('wizard'))) as { genes: Record<string, unknown> }
    delete v2.genes.lootSpeed
    expect(validateGenome(v2).ok).toBe(false)
    expect(validateGenome({ ...v1Payload('wizard'), version: 3 }).ok).toBe(false)
  })
})

describe('kite is a per-turn probability (A-9)', () => {
  it('ranges smoothly from always-close-in to always-keep-range', () => {
    const rangedTurns = (kite: number): number => {
      let n = 0
      for (let seed = 1; seed <= 40; seed++) {
        const r = bot('rogue', { x: 2, y: 4 })
        if (turn(r, [r, foe({ x: 9, y: 4 })], genes({ kite }), seed).Shortbow) n++
      }
      return n
    }
    expect(rangedTurns(0)).toBe(0)
    expect(rangedTurns(1)).toBe(40)
    const half = rangedTurns(0.5)
    expect(half).toBeGreaterThan(8)
    expect(half).toBeLessThan(32)
  })
})

describe('class resources recharge on rests (A-12)', () => {
  it('follow the SRD 5.1 tables', () => {
    expect([1, 2, 3, 6, 12, 17, 20].map(rageUses)).toEqual([2, 2, 3, 4, 5, 6, 99])
    expect(maxResources({ fighter: 5 }, 10)).toEqual({ rage: 0, secondWind: 1, actionSurge: 1, inspiration: 0 })
    expect(maxResources({ fighter: 17 }, 10).actionSurge).toBe(2)
    expect(maxResources({ fighter: 1 }, 10).actionSurge).toBe(0)
    expect(maxResources({ barbarian: 5 }, 10).rage).toBe(3)
    expect(maxResources({ bard: 5 }, 15).inspiration).toBe(2)
    expect(maxResources({ bard: 1 }, 8).inspiration).toBe(1)
    expect([1, 5, 10, 15].map(bardicDie)).toEqual([6, 8, 10, 12])
  })

  it('short rests restore Second Wind / Action Surge (and inspiration from bard 5); long rests restore all', () => {
    const empty = { rage: 0, secondWind: 0, actionSurge: 0, inspiration: 0 }
    expect(restoreResources(empty, { barbarian: 3, fighter: 2 }, 10, false)).toEqual({ rage: 0, secondWind: 1, actionSurge: 1, inspiration: 0 })
    expect(restoreResources(empty, { barbarian: 3 }, 10, true).rage).toBe(3)
    expect(restoreResources(empty, { bard: 4 }, 16, false).inspiration).toBe(0)
    expect(restoreResources(empty, { bard: 5 }, 16, false).inspiration).toBe(3)
  })

  it('Rage spends a use; with none left (or holding it outside boss fights) the barbarian does not rage', () => {
    const b = bot('barbarian', { x: 2, y: 4 })
    expect(b.resources?.rage).toBe(3)
    expect(turn(b, [b, foe({ x: 3, y: 4 })], genes({ openWithRage: true })).Rage).toBe(1)
    expect(b.resources?.rage).toBe(2)
    const spent = bot('barbarian', { x: 2, y: 4 })
    spent.resources!.rage = 0
    expect(turn(spent, [spent, foe({ x: 3, y: 4 })], genes({ openWithRage: true })).Rage).toBeUndefined()
    const holder = bot('barbarian', { x: 2, y: 4 })
    expect(turn(holder, [holder, foe({ x: 3, y: 4 })], genes({ openWithRage: false })).Rage).toBeUndefined()
    const bossy = bot('barbarian', { x: 2, y: 4 })
    expect(turn(bossy, [bossy, foe({ x: 3, y: 4 }, 300, ORC_WARLORD)], genes({ openWithRage: false })).Rage).toBe(1)
  })

  it('Second Wind and Action Surge spend their per-rest uses', () => {
    const f = bot('fighter', { x: 8, y: 4 })
    f.hp = 5
    expect(turn(f, [f, foe({ x: 9, y: 4 })], genes({ secondWindAtHpFrac: 0.9 }))['Second Wind']).toBe(1)
    expect(f.resources?.secondWind).toBe(0)
    f.hp = 5
    expect(turn(f, [f, foe({ x: 9, y: 4 })], genes({ secondWindAtHpFrac: 0.9 }))['Second Wind']).toBeUndefined()
    const s = bot('fighter', { x: 8, y: 4 })
    expect(turn(s, [s, foe({ x: 9, y: 4 }, 1000)], genes({ actionSurgeEarly: true }))['Action Surge']).toBe(1)
    expect(s.resources?.actionSurge).toBe(0)
    expect(turn(s, [s, foe({ x: 9, y: 4 }, 1000)], genes({ actionSurgeEarly: true }))['Action Surge']).toBeUndefined()
  })

  it('in a run, each per-rest feature is used at most once per level and survives a JSON round-trip', () => {
    for (let seed = 1; seed <= 6; seed++) {
      let s = createRun({ seed, depth: 4, party: [{ genome: baselineGenome('fighter') }] })
      let k = 0
      while (!isRunDone(s)) {
        stepRun(s)
        if (++k === 50) s = JSON.parse(JSON.stringify(s)) as typeof s
      }
      const r = runResult(s)
      const m = r.members[0]
      expect(m.usage['Second Wind'] ?? 0).toBeLessThanOrEqual(m.depthReached)
      expect(m.usage['Action Surge'] ?? 0).toBeLessThanOrEqual(m.depthReached)
    }
  })
})

describe('Bardic Inspiration goes to an ally (A-20)', () => {
  it('inspires the nearest ally in range, spending a use; never the bard itself', () => {
    const b = bot('bard', { x: 2, y: 4 })
    const ally = bot('fighter', { x: 4, y: 4 }, 'p1')
    const tally = turn(b, [b, ally, foe({ x: 9, y: 7 })], genes({ inspireBeforeAttack: true }))
    expect(tally['Bardic Inspiration']).toBe(1)
    expect(hasCondition(ally, 'inspired')).toBe(true)
    expect(ally.inspirationDie).toBe(8)
    expect(hasCondition(b, 'inspired')).toBe(false)
    expect(b.resources?.inspiration).toBe(1)
  })

  it('solo (no ally in range) there is nobody to inspire; the gene can also keep the dice', () => {
    const solo = bot('bard', { x: 2, y: 4 })
    expect(turn(solo, [solo, foe({ x: 3, y: 4 })], genes({ inspireBeforeAttack: true }))['Bardic Inspiration']).toBeUndefined()
    expect(solo.resources?.inspiration).toBe(2)
    const far = bot('bard', { x: 1, y: 1 })
    const distant = bot('fighter', { x: 10, y: 7 }, 'p1')
    distant.pos = { x: 30, y: 30 }
    expect(turn(far, [far, distant, foe({ x: 3, y: 4 })], genes({ inspireBeforeAttack: true }))['Bardic Inspiration']).toBeUndefined()
    const keeper = bot('bard', { x: 2, y: 4 })
    const ally = bot('fighter', { x: 4, y: 4 }, 'p1')
    expect(turn(keeper, [keeper, ally, foe({ x: 9, y: 7 })], genes({ inspireBeforeAttack: false }))['Bardic Inspiration']).toBeUndefined()
  })

  it('an inspired attacker adds the die to a miss (and keeps it on a hit); no blanket advantage', () => {
    const sword: CombatAttack = { name: 'Sword', toHit: 5, damage: { count: 1, sides: 6, bonus: 0 }, damageType: 'slashing', range: 1, source: 'weapon' }
    expect(combatMode(mkBattler({ conditions: ['inspired'] }), mkBattler(), sword)).toBe('normal')
    const a = mkBattler({ team: 'player', conditions: ['inspired'], inspirationDie: 8 })
    const t = mkBattler({ hp: 30, maxHp: 30, ac: 18 })
    resolveAttack(scriptRng([[10, 20], [5, 8], [3, 6]]), a, sword, t) // 15 + 5 = 20 ≥ 18
    expect(t.hp).toBe(27)
    expect(hasCondition(a, 'inspired')).toBe(false)
    const h = mkBattler({ team: 'player', conditions: ['inspired'], inspirationDie: 8 })
    resolveAttack(scriptRng([[15, 20], [3, 6]]), h, sword, mkBattler({ hp: 30, maxHp: 30, ac: 18 }))
    expect(hasCondition(h, 'inspired')).toBe(true)
  })

  it('Cutting Words spends a Bardic Inspiration use', () => {
    const bard = mkBattler({ team: 'player', subclass: 'lore', classLevels: { bard: 5 }, ac: 20, hp: 30, maxHp: 30, resources: { rage: 0, secondWind: 0, actionSurge: 0, inspiration: 1 } })
    const sword: CombatAttack = { name: 'Sword', toHit: 6, damage: { count: 1, sides: 6, bonus: 2 }, damageType: 'slashing', range: 1 }
    resolveAttack(scriptRng([[14, 20], [3, 8]]), mkBattler(), sword, bard) // 20 − 3 = 17 → miss
    expect(bard.hp).toBe(30)
    expect(bard.resources?.inspiration).toBe(0)
    resolveAttack(scriptRng([[14, 20], [2, 6]]), mkBattler(), sword, bard)
    expect(bard.hp).toBe(26)
  })
})

describe('loot choice is genome-driven (A-16)', () => {
  it('default weights reproduce the legacy heuristic; other weights change the pick', () => {
    expect(effectScore({ maxHp: 4, ac: 1, toHit: 2, damageBonus: 1, speed: 10 })).toBe(4 + 6 + 4 + 2 + 2)
    const choices = ARTIFACTS.filter((a) => ['iron-charm', 'whetstone', 'warded-ring'].includes(a.key))
    expect(pickArtifact(choices, DEFAULT_LOOT_WEIGHTS).key).toBe('warded-ring')
    expect(pickArtifact(choices, lootWeights(genes({ lootHp: 1, lootAc: 0, lootToHit: 0, lootDamage: 0, lootSpeed: 0 }))).key).toBe('iron-charm')
    expect(pickArtifact(choices, lootWeights(genes({ lootHp: 0, lootAc: 0, lootToHit: 0, lootDamage: 1, lootSpeed: 0 }))).key).toBe('whetstone')
  })

  it('trinket swaps follow the member’s own loot genes', () => {
    const ring = (k: string) => GEAR.find((g) => g.key === k)!
    const hpLover = makeGenome('wizard', { ...baselineGenome('wizard').genes, lootHp: 1, lootToHit: 0, lootDamage: 0 })
    const m = createRun({ seed: 1, party: [{ genome: hpLover }] }).members[0]
    equipFoundGear(m, ring('vigor-band'))
    equipFoundGear(m, ring('vigor-band'))
    equipFoundGear(m, ring('ring-precision'))
    expect([m.equipped.ring1, m.equipped.ring2]).toEqual(['vigor-band', 'vigor-band'])
    const sharp = makeGenome('wizard', { ...baselineGenome('wizard').genes, lootHp: 0, lootToHit: 1 })
    const n = createRun({ seed: 1, party: [{ genome: sharp }] }).members[0]
    equipFoundGear(n, ring('vigor-band'))
    equipFoundGear(n, ring('vigor-band'))
    equipFoundGear(n, ring('ring-precision'))
    expect([n.equipped.ring1, n.equipped.ring2]).toContain('ring-precision')
  })
})
