import type { Vec2 } from '../game/types'
import { rollD20, type Rng } from './dice'
import type { Battler, CombatAttack, CombatEvent } from './types'
import type { MonsterBlock } from './monsters'
import { rollAffix, applyAffix } from './affixes'
import { effectsOf, getSubclass } from './subclasses'
import { maxResources } from './abilities'

// ---------------------------------------------------------------------------
// Turning sources into Battlers + rolling initiative.
//
// The player side comes in as a PlayerSource — a plain, fully-resolved
// character sheet (see character/build for the SRD-table constructor). It is
// JSON data and is never mutated: battlers get deep copies of its attacks.
// ---------------------------------------------------------------------------

/** Ability scores keyed by short name. */
export interface AbilityScores {
  str: number
  dex: number
  con: number
  int: number
  wis: number
  cha: number
}

export interface PlayerSource {
  id?: string
  name: string
  /** The class the character started in (lowercase key). */
  classKey: string
  /** Per-class level breakdown, e.g. `{ fighter: 4, wizard: 1 }`. */
  classLevels: Record<string, number>
  abilityScores: AbilityScores
  maxHp: number
  ac: number
  /** Walking speed in feet. */
  speed: number
  dexModifier: number
  /** Resolved weapon attacks (first = main hand). */
  attacks: CombatAttack[]
  /** Attacks per Attack action (Extra Attack → 2). */
  attacksPerAction: number
  /** Granted spell actions (cantrips + leveled spells + heals). */
  spells: CombatAttack[]
  /** Spell slots by level (index 0 = level 1); [] for non-casters. */
  spellSlots: number[]
  /** Signature class ability keys (see combat/abilities). */
  abilities: string[]
  /** Subclass key, once chosen. */
  subclass?: string
  /** Healing potions carried. */
  potions?: number
  /** Current HP when mid-run (defaults to maxHp). */
  hp?: number
}

/** Deep copy of an attack (battlers must never share objects with a source). */
export function cloneAttack(a: CombatAttack): CombatAttack {
  const out: CombatAttack = { ...a, damage: { ...a.damage } }
  if (a.heal) out.heal = { ...a.heal }
  if (a.applies) out.applies = { ...a.applies }
  return out
}

function tiles(speedFt: number): number {
  return Math.max(1, Math.floor(speedFt / 5))
}

/** Total character level of a build. */
export function charLevelOf(classLevels: Record<string, number>): number {
  let n = 0
  for (const v of Object.values(classLevels)) n += Math.max(0, Math.floor(v))
  return n
}

export function buildPlayerBattler(src: PlayerSource, pos: Vec2): Battler {
  const weapons: CombatAttack[] =
    src.attacks.length > 0
      ? src.attacks.map(cloneAttack)
      : [{ name: 'Unarmed strike', toHit: src.dexModifier, damage: { count: 1, sides: 1, bonus: Math.max(0, src.dexModifier) }, damageType: 'bludgeoning', range: 1, source: 'weapon' }]
  const charLevel = charLevelOf(src.classLevels)
  // Subclass HP bonus (Draconic Resilience: +1 HP per sorcerer level).
  let maxHp = src.maxHp
  for (const e of effectsOf({ subclass: src.subclass, classLevels: src.classLevels, charLevel })) {
    if (e.kind === 'extraHpPerLevel') {
      const sc = src.subclass ? getSubclass(src.subclass) : undefined
      maxHp += e.n * (sc ? (src.classLevels[sc.classKey] ?? 0) : 0)
    }
  }
  const battler: Battler = {
    id: src.id ?? 'player',
    name: src.name,
    team: 'player',
    glyph: '@',
    pos: { ...pos },
    maxHp,
    hp: Math.min(src.hp ?? maxHp, maxHp),
    ac: src.ac,
    speedTiles: tiles(src.speed),
    initiativeMod: src.dexModifier,
    initiative: 0,
    attacks: [...weapons, ...src.spells.map(cloneAttack)],
    attacksPerAction: Math.max(1, src.attacksPerAction),
    conditions: [],
    deathSaves: { successes: 0, failures: 0, stable: false, dead: false },
    potions: src.potions ?? 0,
    spellSlots: [...src.spellSlots],
    abilities: [...src.abilities],
    resources: maxResources(src.classLevels, src.abilityScores.cha),
    classLevels: { ...src.classLevels },
    charLevel,
  }
  if (src.subclass) battler.subclass = src.subclass
  return battler
}

/**
 * Depth scaling: deeper dungeon levels make every monster TOUGHER (not more
 * numerous). `depthIndex` is the 0-based dungeon level (0 = floor 1). At floor
 * 1 the multipliers are all neutral.
 */
export function monsterDepthScale(depthIndex: number): { hpMult: number; acBonus: number; hitBonus: number; dmgBonus: number } {
  const t = Math.max(0, depthIndex)
  return {
    hpMult: 1 + 0.07 * t, // ×1 at floor 1 … ≈×2.7 at floor 25
    acBonus: Math.floor(t / 10),
    hitBonus: Math.floor(t / 8),
    dmgBonus: Math.floor(t / 6),
  }
}

export function buildEnemyBattler(monster: MonsterBlock, id: string, pos: Vec2, depthIndex = 0): Battler {
  const s = monsterDepthScale(depthIndex)
  // Copy each attack (never mutate the shared MonsterBlock) and apply the depth
  // bonuses to to-hit + flat damage.
  const attacks: CombatAttack[] = monster.attacks.map((a) => {
    const c = cloneAttack(a)
    c.toHit += s.hitBonus
    c.damage.bonus += s.dmgBonus
    return c
  })
  const maxHp = Math.max(1, Math.round(monster.maxHp * s.hpMult))
  const battler: Battler = {
    id,
    name: monster.name,
    team: 'enemy',
    glyph: monster.glyph,
    pos: { ...pos },
    maxHp,
    hp: maxHp,
    ac: monster.ac + s.acBonus,
    speedTiles: tiles(monster.speed),
    initiativeMod: monster.initiativeMod,
    initiative: 0,
    attacks,
    attacksPerAction: Math.max(1, monster.attacksPerAction ?? 1),
    conditions: [],
  }
  if (monster.role) battler.role = monster.role
  // Boss telegraph: build the depth-scaled AoE this boss winds up + bursts.
  if (monster.telegraph) {
    const aoe = cloneAttack(monster.telegraph.attack)
    aoe.toHit += s.hitBonus
    aoe.damage.bonus += s.dmgBonus
    battler.bossAoe = aoe
    battler.telegraphCd = 0
    battler.telegraphCdMax = monster.telegraph.cooldown
  }
  // Elites: deeper foes (and every boss) may carry an affix.
  const affix = rollAffix(id, depthIndex, monster.role === 'boss')
  if (affix) applyAffix(battler, affix)
  return battler
}

/**
 * Roll initiative for every battler (d20 + mod), set it, and return the turn
 * order (highest first; ties broken in the player's favour, then by mod).
 */
export function rollInitiative(rng: Rng, battlers: Battler[]): { order: Battler[]; events: CombatEvent[] } {
  const events: CombatEvent[] = []
  for (const b of battlers) {
    const r = rollD20(rng)
    b.initiative = r.value + b.initiativeMod
    events.push({ kind: 'roll-initiative', who: b.name, value: b.initiative })
  }
  const order = [...battlers].sort((a, b) => {
    if (b.initiative !== a.initiative) return b.initiative - a.initiative
    if (a.team !== b.team) return a.team === 'player' ? -1 : 1
    return b.initiativeMod - a.initiativeMod
  })
  return { order, events }
}
