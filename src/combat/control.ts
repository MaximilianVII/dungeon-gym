import type { GameMap, Vec2 } from '../game/types'
import { isWalkable } from '../game/map'
import { tileDistance } from '../game/logic'
import { rollDamage, type DamageDice, type Rng } from './dice'
import { getMonster } from './monsters'
import { buildEnemyBattler } from './setup'
import { isHelpless, savingThrow, setTimedCondition } from './resolve'
import { spendSlot } from './slots'
import { addCondition, hasCondition, removeCondition, type Battler, type CombatAttack, type CombatEvent, type Condition } from './types'

// ---------------------------------------------------------------------------
// Control spells (SRD 5.1) and the conditions they impose:
//   • Hold Person — a humanoid makes a WIS save or is PARALYZED (1 minute,
//     concentration); it repeats the save at the end of each of its turns.
//     +1 target per slot level above 2nd.
//   • Sleep — 5d8 (+2d8 per slot level above 1st) HP of creatures in a 20-ft
//     burst fall UNCONSCIOUS, lowest current HP first; undead are immune.
//     Damage wakes a sleeper. Not selective: allies in the burst count too.
//   • Conjure Animals — two CR 1 beasts fight on the caster's side
//     (concentration); ×2 from a 5th-level slot, ×3 from 7th, ×4 from 9th.
//     Simplification: they act right after their summoner, run by the
//     monster AI, and leave when the fight ends.
//   • Hypnotic Pattern — creatures in a 30-ft cube make a WIS save or are
//     incapacitated (charmed, speed 0) until they take damage (concentration,
//     1 minute). Not selective either.
//   • Hunter's Mark — a bonus action: +1d6 on the caster's weapon hits against
//     the marked creature (concentration); when it drops, a later bonus action
//     moves the mark for free.
// Paralyzed / unconscious creatures lose their turns, fail STR/DEX saves, are
// attacked with advantage and take a crit from any melee hit within 5 ft
// (combat/resolve). Concentration ends on 0 HP, a failed CON save after damage
// (combat/resolve), incapacitation, or casting another concentration spell.
// Everything here mutates battlers + advances the RNG; plain JSON state only.
// ---------------------------------------------------------------------------

/** One minute of combat rounds (Hold Person, Sleep). */
export const MINUTE_ROUNDS = 10

/** Spell save DC from a spell's attack bonus (8 + proficiency + ability). */
export function spellSaveDc(attack: CombatAttack): number {
  return 8 + attack.toHit
}

/** A creature that cannot act this turn (SRD incapacitated). */
export function isIncapacitated(b: Battler): boolean {
  return isHelpless(b) || hasCondition(b, 'incapacitated')
}

/** Out of the fight until something wakes it: asleep or entranced (damage ends both). */
export function isDormant(b: Battler): boolean {
  return hasCondition(b, 'unconscious') || hasCondition(b, 'incapacitated')
}

/** The creatures a Hypnotic Pattern at `center` could catch (anyone who can
 *  still act, either side). */
export function patternTargets(center: Vec2, battlers: readonly Battler[], radius: number): Battler[] {
  return battlers.filter((b) => b.hp > 0 && !isIncapacitated(b) && tileDistance(center, b.pos) <= radius)
}

/** Hypnotic Pattern at `center`: each creature caught saves or is entranced. */
export function castPattern(rng: Rng, caster: Battler, attack: CombatAttack, center: Vec2, battlers: readonly Battler[]): CombatEvent[] {
  const c = attack.control
  const events: CombatEvent[] = [{ kind: 'ability', who: caster.name, ability: attack.name }]
  if (c?.kind !== 'pattern') return events
  endConcentration(caster, battlers)
  const dc = spellSaveDc(attack)
  let caught = 0
  for (const t of patternTargets(center, battlers, c.radius).filter((x) => x !== caster)) {
    if (savingThrow(rng, t, c.save) >= dc) continue
    setTimedCondition(t, 'incapacitated', MINUTE_ROUNDS)
    ;(t.condSource ??= {}).incapacitated = caster.id
    events.push({ kind: 'condition', who: t.name, condition: 'incapacitated' })
    caught++
  }
  if (caught > 0) caster.concentration = attack.name
  return events
}

/** How many creatures one Hold Person can target from a slot of this level. */
export function holdTargetCount(slotLevel: number): number {
  return Math.max(1, slotLevel - 1)
}

/** Can Hold Person (or another hold effect) take this target? */
export function canHold(attack: CombatAttack, target: Battler): boolean {
  const c = attack.control
  return c?.kind === 'hold' && target.hp > 0 && target.creatureType === c.creatureType && !hasCondition(target, 'paralyzed')
}

/** The Sleep pool dice cast from a slot of this level. */
export function sleepPool(attack: CombatAttack, slotLevel: number): DamageDice {
  const c = attack.control
  if (c?.kind !== 'sleep') return { count: 0, sides: 8, bonus: 0 }
  const extra = Math.max(0, slotLevel - (attack.slotLevel ?? 1)) * 2
  return { count: c.pool.count + extra, sides: c.pool.sides, bonus: c.pool.bonus }
}

/** Beasts summoned by one Conjure Animals from a slot of this level. */
export function conjureCount(attack: CombatAttack, slotLevel: number): number {
  const c = attack.control
  if (c?.kind !== 'conjure') return 0
  const mult = slotLevel >= 9 ? 4 : slotLevel >= 7 ? 3 : slotLevel >= 5 ? 2 : 1
  return c.count * mult
}

/**
 * The creatures a Sleep burst at `center` would put down with a pool of
 * `pool` HP, in order (lowest current HP first; ties keep battler order).
 * Undead, the dead and those already unconscious are skipped.
 */
export function sleepVictims(center: Vec2, battlers: readonly Battler[], radius: number, pool: number): Battler[] {
  const eligible = battlers
    .filter((b) => b.hp > 0 && !hasCondition(b, 'unconscious') && b.creatureType !== 'undead' && tileDistance(center, b.pos) <= radius)
    .sort((a, b) => a.hp - b.hp)
  const out: Battler[] = []
  let left = pool
  for (const b of eligible) {
    if (b.hp > left) break
    left -= b.hp
    out.push(b)
  }
  return out
}

/** Remove a condition and all of its bookkeeping (timer, source, save). */
export function clearCondition(b: Battler, condition: Condition): void {
  removeCondition(b, condition)
  if (b.condTimers) delete b.condTimers[condition]
  if (b.condSource) delete b.condSource[condition]
  if (b.saveEnds) delete b.saveEnds[condition]
}

/** End `caster`'s concentration and everything it was holding up. */
export function endConcentration(caster: Battler, battlers: readonly Battler[]): void {
  delete caster.concentration
  for (const b of battlers) {
    for (const [cond, by] of Object.entries(b.condSource ?? {})) if (by === caster.id) clearCondition(b, cond as Condition)
    if (b.summoner === caster.id && b.hp > 0) b.hp = 0
  }
}

/** Is anything still hanging on `caster`'s concentration? A held / entranced
 * creature or a living summoned beast; Hunter's Mark lasts with no quarry (a
 * later bonus action moves it). */
function stillConcentrating(caster: Battler, battlers: readonly Battler[]): boolean {
  if (caster.attacks.some((a) => a.name === caster.concentration && a.control?.kind === 'mark')) return true
  return battlers.some((b) => b.hp > 0 && (b.summoner === caster.id || Object.values(b.condSource ?? {}).includes(caster.id)))
}

/**
 * Drop effects whose concentration has lapsed (the caster is down,
 * incapacitated, gone, or lost the spell to a failed save) and concentration
 * that no longer holds anything up (every target saved or died), so the
 * caster may cast again. Run before each combat turn; idempotent.
 */
export function enforceConcentration(battlers: readonly Battler[]): void {
  for (const b of battlers) {
    if (b.concentration && (b.hp <= 0 || isIncapacitated(b) || !stillConcentrating(b, battlers))) delete b.concentration
  }
  const concentrating = (id: string): boolean => battlers.some((c) => c.id === id && c.concentration !== undefined)
  for (const b of battlers) {
    for (const [cond, by] of Object.entries(b.condSource ?? {})) if (!concentrating(by)) clearCondition(b, cond as Condition)
    if (b.summoner !== undefined && b.hp > 0 && !concentrating(b.summoner)) b.hp = 0
  }
}

/** End-of-turn saves (Hold Person): each succeeds → the condition ends. */
export function endOfTurnSaves(rng: Rng, b: Battler, events: CombatEvent[] = []): CombatEvent[] {
  for (const [cond, save] of Object.entries(b.saveEnds ?? {})) {
    if (!hasCondition(b, cond as Condition)) {
      clearCondition(b, cond as Condition)
      continue
    }
    if (savingThrow(rng, b, save.ability) >= save.dc) {
      clearCondition(b, cond as Condition)
      events.push({ kind: 'condition', who: b.name, condition: `${cond} ended` })
    }
  }
  return events
}

/** Hold Person on up to holdTargetCount(slotLevel) of `targets` (invalid ones
 *  are skipped). Starts concentration if anyone is held. */
export function castHold(rng: Rng, caster: Battler, attack: CombatAttack, targets: readonly Battler[], battlers: readonly Battler[], slotLevel: number): CombatEvent[] {
  const c = attack.control
  const events: CombatEvent[] = [{ kind: 'ability', who: caster.name, ability: attack.name }]
  if (c?.kind !== 'hold') return events
  endConcentration(caster, battlers)
  const dc = spellSaveDc(attack)
  let held = 0
  for (const t of targets.filter((x) => canHold(attack, x)).slice(0, holdTargetCount(slotLevel))) {
    if (savingThrow(rng, t, c.save) >= dc) continue
    setTimedCondition(t, 'paralyzed', MINUTE_ROUNDS)
    ;(t.condSource ??= {}).paralyzed = caster.id
    ;(t.saveEnds ??= {}).paralyzed = { ability: c.save, dc }
    events.push({ kind: 'condition', who: t.name, condition: 'paralyzed' })
    held++
  }
  if (held > 0) caster.concentration = attack.name
  return events
}

/** Sleep centred on `center`: rolls the pool, then puts the victims to sleep. */
export function castSleep(rng: Rng, caster: Battler, attack: CombatAttack, center: Vec2, battlers: readonly Battler[], slotLevel: number): CombatEvent[] {
  const c = attack.control
  const events: CombatEvent[] = [{ kind: 'ability', who: caster.name, ability: attack.name }]
  if (c?.kind !== 'sleep') return events
  const pool = rollDamage(rng, sleepPool(attack, slotLevel)).total
  for (const t of sleepVictims(center, battlers, c.radius, pool)) {
    setTimedCondition(t, 'unconscious', MINUTE_ROUNDS)
    events.push({ kind: 'condition', who: t.name, condition: 'unconscious' })
  }
  return events
}

/** Free tiles nearest `from` (BFS over walkable floor; occupied tiles are
 *  passed through but never chosen). */
function freeTilesNear(map: GameMap, from: Vec2, n: number, battlers: readonly Battler[], maxDist: number): Vec2[] {
  const occupied = new Set(battlers.filter((b) => b.hp > 0).map((b) => `${b.pos.x},${b.pos.y}`))
  const seen = new Set<string>([`${from.x},${from.y}`])
  const q: Vec2[] = [from]
  const out: Vec2[] = []
  for (let head = 0; head < q.length && out.length < n; head++) {
    const p = q[head]
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const t = { x: p.x + dx, y: p.y + dy }
        const k = `${t.x},${t.y}`
        if (seen.has(k) || !isWalkable(map, t.x, t.y) || tileDistance(from, t) > maxDist) continue
        seen.add(k)
        q.push(t)
        if (!occupied.has(k) && out.length < n) out.push(t)
      }
    }
  }
  return out
}

/** The living creature `caster` keeps marked, if any. */
export function markedBy(caster: Battler, battlers: readonly Battler[]): Battler | undefined {
  return battlers.find((b) => b.hp > 0 && b.condSource?.marked === caster.id)
}

/** Hunter's Mark on `target`: starts concentration (a fresh cast) or, while the
 *  caster still concentrates on the mark, just moves it (no slot). */
export function placeMark(caster: Battler, attack: CombatAttack, target: Battler, battlers: readonly Battler[], fresh: boolean): CombatEvent[] {
  if (attack.control?.kind !== 'mark') return []
  if (fresh) endConcentration(caster, battlers)
  for (const b of battlers) if (b.condSource?.marked === caster.id) clearCondition(b, 'marked')
  caster.concentration = attack.name
  addCondition(target, 'marked')
  ;(target.condSource ??= {}).marked = caster.id
  return [{ kind: 'condition', who: target.name, condition: 'marked' }]
}

/** Where a control spell is aimed: the creatures (Hold Person) or the burst
 *  centre (Sleep); Conjure Animals needs neither. */
export interface ControlAim {
  targets?: readonly Battler[]
  center?: Vec2
}

/**
 * Cast a control spell: spend the lowest slot that fits (none left → nothing
 * happens) and apply its effect. Summoned beasts are returned for the caller to
 * add to the fight.
 */
export function castControl(
  rng: Rng,
  caster: Battler,
  attack: CombatAttack,
  aim: ControlAim,
  battlers: readonly Battler[],
  map: GameMap,
  idOf: (i: number) => string,
): { events: CombatEvent[]; summons: Battler[] } {
  const c = attack.control
  if (!c) return { events: [], summons: [] }
  const slotLevel = spendSlot(caster, attack)
  if (slotLevel === 0) return { events: [], summons: [] }
  if (c.kind === 'hold') return { events: castHold(rng, caster, attack, aim.targets ?? [], battlers, slotLevel), summons: [] }
  if (c.kind === 'sleep') return { events: castSleep(rng, caster, attack, aim.center ?? caster.pos, battlers, slotLevel), summons: [] }
  if (c.kind === 'pattern') return { events: castPattern(rng, caster, attack, aim.center ?? caster.pos, battlers), summons: [] }
  if (c.kind === 'mark') {
    const target = aim.targets?.find((t) => t.hp > 0)
    return { events: target ? placeMark(caster, attack, target, battlers, true) : [], summons: [] }
  }
  const summons = conjureBeasts(caster, attack, battlers, map, slotLevel, idOf)
  return { events: [{ kind: 'ability', who: caster.name, ability: attack.name }], summons }
}

/**
 * Conjure Animals: build the summoned beasts next to the caster (as many as
 * there is room for) and start concentration. The caller adds them to the
 * fight; `idOf(i)` names the i-th beast (ids must be unique in the fight).
 */
export function conjureBeasts(caster: Battler, attack: CombatAttack, battlers: readonly Battler[], map: GameMap, slotLevel: number, idOf: (i: number) => string): Battler[] {
  const c = attack.control
  const mon = c?.kind === 'conjure' ? getMonster(c.beast) : undefined
  if (!mon) return []
  endConcentration(caster, battlers)
  const spots = freeTilesNear(map, caster.pos, conjureCount(attack, slotLevel), battlers, attack.range)
  const beasts = spots.map((pos, i) => {
    const b = buildEnemyBattler(mon, idOf(i), pos, 0)
    b.team = caster.team
    b.summoner = caster.id
    b.initiative = caster.initiative
    delete b.passivePerception
    return b
  })
  if (beasts.length > 0) caster.concentration = attack.name
  return beasts
}
