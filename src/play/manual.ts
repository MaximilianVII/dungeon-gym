import type { GameMap, Vec2 } from '../game/types'
import { isWalkable } from '../game/map'
import { tileDistance } from '../game/logic'
import { lineOfSight } from '../game/los'
import { rollDamage, rollDie, type Rng } from '../combat/dice'
import { combatMode, resolveAreaAttack, resolveAttack } from '../combat/resolve'
import { addCondition, hasCondition, healBattler, makesDeathSaves, type Battler, type CombatAttack } from '../combat/types'
import { canHold, castControl, holdTargetCount, markedBy, placeMark } from '../combat/control'
import { castingLevel, slotAvailable, spendSlot, upcast } from '../combat/slots'
import { bardicDie, wildShapeForm } from '../combat/abilities'
import { findEffect } from '../combat/subclasses'
import { profBonus } from '../character/progression'
import { isRunDone, stepRun, cloneRunState } from '../bot/run'
import { BOT_WAND, type CombatState, type HumanTurn, type MemberState, type RunState } from '../run/types'
import { aliveMembers, combatBattlers, currentLevel, finishRun, isAwaitingInput, memberById } from '../run/state'
import { botMemberTurn, endHumanTurn, enemiesUp, sumHp, turnContext } from '../run/combat'
import { exploreStep, walkTo } from '../run/explore'
import { rngOf } from '../rng'

// ---------------------------------------------------------------------------
// Manual play: a human controls one or more party members (created with
// `control: 'human'`) on the SAME deterministic engine the bots use.
//
//   let s = advanceToInput(createRun({ seed, depth, party: [{ genome, control: 'human' }] }))
//   while (!isRunDone(s)) {
//     const options = legalActions(s)          // what the human may do now
//     s = applyPlayerAction(s, options[k])     // new state; the input is untouched
//   }
//
// Everything stays plain JSON with the RNG inside the state, so a client can
// save, send or replay a game; the same state + action always gives the same
// next state. After each action the bots and monsters play on until the next
// human decision (or the end). Exploration input is needed when the party's
// leader (its first living member) is human; combat input on every turn of a
// human member. A turn is built from actions — move one tile at a time, one
// action, one bonus action, extra weapon swings within the Attack action — and
// ends with `end-turn` (or `auto`: the member's genome plays the turn).
// ---------------------------------------------------------------------------

/** Class features a human can use from the turn menu. */
export type FeatureKey = 'rage' | 'second-wind' | 'action-surge' | 'patient-defense' | 'hide' | 'dash' | 'wild-shape' | 'inspire'

export type PlayerAction =
  /** Exploration: step the party to an adjacent tile. Combat: move one tile. */
  | { kind: 'move'; to: Vec2 }
  /** A weapon swing (part of the Attack action; `bonus` for a Frenzy or Martial
   *  Arts swing), a cantrip or a single-target damage spell. */
  | { kind: 'attack'; attack: string; target: string; bonus?: true }
  /** An area damage spell centred on a tile. */
  | { kind: 'area'; attack: string; center: Vec2 }
  /** A control spell: Hold Person (targets), Sleep / Hypnotic Pattern (center),
   *  Conjure Animals (none), Hunter's Mark (one target, a bonus action). */
  | { kind: 'cast'; spell: string; targets?: string[]; center?: Vec2 }
  /** A healing spell on a member (Healing Word is a bonus action). */
  | { kind: 'heal'; spell: string; target: string }
  /** Drink a Potion of Healing (an action). */
  | { kind: 'potion' }
  /** A class feature; `inspire` needs a target. */
  | { kind: 'feature'; feature: FeatureKey; target?: string }
  /** Fire the party's cast-wand (a bonus action, while it has charges). */
  | { kind: 'wand'; target: string }
  | { kind: 'end-turn' }
  /** Let the member's genome play this turn (or take one exploration step). */
  | { kind: 'auto' }

export interface PendingInput {
  kind: 'explore' | 'combat'
  memberId: number
  /** The turn in progress (combat only). */
  turn?: HumanTurn
}

/** What the run is waiting for, or null (done, or bots still to play). */
export function pendingInput(s: RunState): PendingInput | null {
  if (!isAwaitingInput(s)) return null
  const turn = s.combat?.humanTurn
  if (s.phase === 'combat' && turn) return { kind: 'combat', memberId: turn.memberId, turn: { ...turn } }
  return { kind: 'explore', memberId: aliveMembers(s)[0].memberId }
}

/** Step bots and monsters (on a copy) until a human decision is needed or the run ends. */
export function advanceToInput(state: RunState): RunState {
  const s = cloneRunState(state)
  runUntilInput(s)
  return s
}

function runUntilInput(s: RunState): void {
  while (!isRunDone(s) && !isAwaitingInput(s)) stepRun(s)
}

// ---------------------------------------------------------------------------
// The turn context
// ---------------------------------------------------------------------------

interface Turn {
  s: RunState
  c: CombatState
  turn: HumanTurn
  member: MemberState
  bot: Battler
  battlers: Battler[]
  map: GameMap
}

function turnOf(s: RunState): Turn | null {
  const c = s.combat
  const turn = c?.humanTurn
  if (s.phase !== 'combat' || !c || !turn) return null
  const member = memberById(s, turn.memberId)
  return { s, c, turn, member, bot: member.battler, battlers: combatBattlers(s, c), map: currentLevel(s).map }
}

const isWeapon = (a: CombatAttack): boolean => (a.source ?? 'weapon') === 'weapon'
const kitOf = (b: Battler): CombatAttack[] => (b.wildShape ? [b.wildShape.form.attack] : b.attacks)
const perAction = (b: Battler): number => Math.max(1, b.wildShape?.form.attacksPerAction ?? b.attacksPerAction)
const has = (b: Battler, k: string): boolean => !!b.abilities?.includes(k)

function foeById(t: Turn, id: string): Battler | undefined {
  return t.battlers.find((b) => b.id === id && b.team !== t.bot.team && b.hp > 0)
}

function inSight(t: Turn, pos: Vec2, range: number): boolean {
  return tileDistance(t.bot.pos, pos) <= range && lineOfSight(t.map, t.bot.pos, pos)
}

/** Can the action slot pay for `a` now (a leveled spell needs a slot and no bonus-action spell this turn)? */
function actionSpellOk(t: Turn, a: CombatAttack): string | null {
  if (t.turn.actionUsed) return 'the action is used'
  if (a.source === 'spell' || a.source === 'heal') {
    if (t.bot.wildShape) return 'no spells in Wild Shape'
    if (t.turn.bonusSpell) return 'only a cantrip after a bonus-action spell'
    if (!slotAvailable(t.bot, a)) return 'no spell slot'
  }
  return null
}

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

/** Why `action` is not allowed now (null = it is legal). */
export function checkAction(s: RunState, action: PlayerAction): string | null {
  if (!isAwaitingInput(s)) return 'no input is pending'
  if (s.phase === 'explore') return checkExplore(s, action)
  const t = turnOf(s)
  return t ? checkCombat(t, action) : 'no turn in progress'
}

function checkExplore(s: RunState, a: PlayerAction): string | null {
  if (a.kind === 'auto') return null
  if (a.kind !== 'move') return 'only move or auto while exploring'
  if (tileDistance(s.pos, a.to) !== 1) return 'move one tile at a time'
  return isWalkable(currentLevel(s).map, a.to.x, a.to.y) ? null : 'a wall'
}

function checkCombat(t: Turn, a: PlayerAction): string | null {
  const { turn, bot } = t
  switch (a.kind) {
    case 'end-turn': return null
    case 'auto': return turn.actionUsed || turn.bonusUsed || turn.attacksLeft > 0 || turn.movementLeft < bot.speedTiles ? 'auto only at the start of a turn' : null
    case 'move': {
      if (turn.movementLeft <= 0) return 'no movement left'
      if (tileDistance(bot.pos, a.to) !== 1 || !isWalkable(t.map, a.to.x, a.to.y)) return 'not an adjacent floor tile'
      return t.battlers.some((b) => b.hp > 0 && b !== bot && b.pos.x === a.to.x && b.pos.y === a.to.y) ? 'occupied' : null
    }
    case 'attack': return checkAttack(t, a)
    case 'area': {
      const atk = kitOf(bot).find((x) => x.name === a.attack && x.area && x.source !== 'heal')
      if (!atk) return 'no such area attack'
      return actionSpellOk(t, atk) ?? (inSight(t, a.center, atk.range) ? null : 'out of range or sight')
    }
    case 'cast': return checkCast(t, a)
    case 'heal': return checkHeal(t, a)
    case 'potion': return turn.actionUsed ? 'the action is used' : (bot.potions ?? 0) > 0 ? null : 'no potions'
    case 'feature': return checkFeature(t, a.feature, a.target)
    case 'wand': {
      if (t.s.castCharges <= 0) return 'the wand is empty'
      if (turn.bonusUsed) return 'the bonus action is used'
      const foe = foeById(t, a.target)
      return foe && inSight(t, foe.pos, BOT_WAND.range) ? null : 'no target in range'
    }
  }
}

function checkAttack(t: Turn, a: { attack: string; target: string; bonus?: true }): string | null {
  const { turn, bot } = t
  const atk = kitOf(bot).find((x) => x.name === a.attack && !x.area && !x.control && x.source !== 'heal' && (x.damage.count > 0 || x.damage.bonus > 0))
  if (!atk) return 'no such attack'
  const foe = foeById(t, a.target)
  if (!foe || !inSight(t, foe.pos, atk.range)) return 'no target in range'
  if (a.bonus) {
    if (!isWeapon(atk)) return 'a bonus swing must be a weapon attack'
    if (turn.bonusUsed) return 'the bonus action is used'
    const frenzy = !!findEffect(bot, 'frenzyHaste') && hasCondition(bot, 'raging')
    const martialArts = (bot.classLevels?.monk ?? 0) > 0 && turn.actionUsed
    return frenzy || martialArts ? null : 'no bonus attack available'
  }
  if (isWeapon(atk)) return turn.attacksLeft > 0 || !turn.actionUsed ? null : 'the action is used'
  return actionSpellOk(t, atk)
}

function checkCast(t: Turn, a: { spell: string; targets?: string[]; center?: Vec2 }): string | null {
  const { turn, bot } = t
  const atk = bot.attacks.find((x) => x.name === a.spell && x.control)
  const c = atk?.control
  if (!atk || !c) return 'no such spell'
  if (bot.wildShape) return 'no spells in Wild Shape'
  if (c.kind === 'mark') {
    if (turn.bonusUsed) return 'the bonus action is used'
    const foe = foeById(t, a.targets?.[0] ?? '')
    if (!foe || !inSight(t, foe.pos, atk.range)) return 'no target in range'
    const moving = bot.concentration === atk.name && !markedBy(bot, t.battlers)
    return moving || slotAvailable(bot, atk) ? null : 'no spell slot'
  }
  const pay = actionSpellOk(t, atk)
  if (pay) return pay
  if (c.kind === 'conjure') return null
  if (c.kind === 'hold') {
    const ids = a.targets ?? []
    const targets = ids.map((id) => foeById(t, id))
    if (ids.length === 0 || ids.length > holdTargetCount(castingLevel(bot, atk)) || new Set(ids).size !== ids.length) return 'pick 1 to N different targets'
    if (targets.some((x) => !x || !canHold(atk, x) || !inSight(t, x.pos, atk.range))) return 'a target cannot be held'
    return targets.every((x) => tileDistance(x!.pos, targets[0]!.pos) <= 6) ? null : 'targets must be within 30 ft of each other'
  }
  return a.center && inSight(t, a.center, atk.range) ? null : 'out of range or sight'
}

function checkHeal(t: Turn, a: { spell: string; target: string }): string | null {
  const { turn, bot } = t
  const h = bot.attacks.find((x) => x.name === a.spell && x.source === 'heal' && x.heal)
  if (!h) return 'no such heal'
  const target = t.battlers.find((b) => b.id === a.target && b.team === bot.team && makesDeathSaves(b) && !b.deathSaves?.dead)
  if (!target || tileDistance(bot.pos, target.pos) > h.range) return 'no one to heal in range'
  if (h.bonusAction) {
    if (bot.wildShape) return 'no spells in Wild Shape'
    if (turn.bonusUsed) return 'the bonus action is used'
    return slotAvailable(bot, h) ? null : 'no spell slot'
  }
  return actionSpellOk(t, h)
}

function checkFeature(t: Turn, f: FeatureKey, target?: string): string | null {
  const { turn, bot } = t
  const res = bot.resources
  const bonusFree = !turn.bonusUsed
  switch (f) {
    case 'rage': return has(bot, 'rage') && (res?.rage ?? 0) > 0 && !hasCondition(bot, 'raging') && bonusFree ? null : 'cannot rage now'
    case 'second-wind': return has(bot, 'second-wind') && (res?.secondWind ?? 0) > 0 && bonusFree ? null : 'no Second Wind'
    case 'action-surge': return has(bot, 'action-surge') && (res?.actionSurge ?? 0) > 0 && turn.actionUsed && !turn.surged ? null : 'no Action Surge now'
    case 'patient-defense': return has(bot, 'patient-defense') && bonusFree ? null : 'no Patient Defense'
    case 'hide': return has(bot, 'cunning-dash') && bonusFree ? null : 'no Cunning Action'
    case 'dash': return (has(bot, 'cunning-dash') ? bonusFree : !turn.actionUsed) ? null : 'cannot dash now'
    case 'wild-shape': {
      const lvl = bot.classLevels?.druid ?? 0
      return lvl >= 2 && (res?.wildShape ?? 0) > 0 && !bot.wildShape && !turn.actionUsed && wildShapeForm(lvl) ? null : 'no Wild Shape now'
    }
    case 'inspire': {
      if (!has(bot, 'inspire') || (res?.inspiration ?? 0) <= 0 || !bonusFree) return 'no Bardic Inspiration now'
      const ally = t.battlers.find((b) => b.id === target && b.team === bot.team && b !== bot && b.hp > 0)
      return ally && !hasCondition(ally, 'inspired') && tileDistance(bot.pos, ally.pos) <= 12 ? null : 'no ally to inspire in range'
    }
  }
}

/** Every action the human may take now (empty when no input is pending). */
export function legalActions(s: RunState): PlayerAction[] {
  if (!isAwaitingInput(s)) return []
  const around = (p: Vec2): Vec2[] => {
    const out: Vec2[] = []
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) out.push({ x: p.x + dx, y: p.y + dy })
    return out
  }
  if (s.phase === 'explore') return [...around(s.pos).map((to): PlayerAction => ({ kind: 'move', to })), { kind: 'auto' } as PlayerAction].filter((a) => checkAction(s, a) === null)
  const t = turnOf(s)
  if (!t) return []
  const foes = t.battlers.filter((b) => b.team !== t.bot.team && b.hp > 0)
  const mates = t.battlers.filter((b) => b.team === t.bot.team && makesDeathSaves(b))
  const cands: PlayerAction[] = around(t.bot.pos).map((to) => ({ kind: 'move', to }))
  for (const a of kitOf(t.bot)) {
    for (const f of foes) {
      if (a.area) cands.push({ kind: 'area', attack: a.name, center: { ...f.pos } })
      else cands.push({ kind: 'attack', attack: a.name, target: f.id }, { kind: 'attack', attack: a.name, target: f.id, bonus: true })
      if (a.control?.kind === 'sleep' || a.control?.kind === 'pattern') cands.push({ kind: 'cast', spell: a.name, center: { ...f.pos } })
      if (a.control?.kind === 'hold' || a.control?.kind === 'mark') cands.push({ kind: 'cast', spell: a.name, targets: [f.id] })
    }
    if (a.control?.kind === 'conjure') cands.push({ kind: 'cast', spell: a.name })
    if (a.source === 'heal') for (const m of mates) cands.push({ kind: 'heal', spell: a.name, target: m.id })
  }
  cands.push({ kind: 'potion' })
  for (const feature of ['rage', 'second-wind', 'action-surge', 'patient-defense', 'hide', 'dash', 'wild-shape'] as const) cands.push({ kind: 'feature', feature })
  for (const m of mates) cands.push({ kind: 'feature', feature: 'inspire', target: m.id })
  for (const f of foes) cands.push({ kind: 'wand', target: f.id })
  cands.push({ kind: 'end-turn' }, { kind: 'auto' })
  return cands.filter((a) => checkAction(s, a) === null)
}

// ---------------------------------------------------------------------------
// Applying an action
// ---------------------------------------------------------------------------

/**
 * Apply a legal action to a COPY of the state, then let the bots and monsters
 * play until the next human decision or the end of the run. Throws on an
 * illegal action (see checkAction for the reason).
 */
export function applyPlayerAction(state: RunState, action: PlayerAction): RunState {
  const why = checkAction(state, action)
  if (why) throw new Error(`applyPlayerAction: illegal action (${why})`)
  const s = cloneRunState(state)
  const rng = rngOf(s.rng)
  if (s.phase === 'explore') applyExplore(s, action, rng)
  else applyCombat(turnOf(s)!, action, rng)
  runUntilInput(s)
  return s
}

function applyExplore(s: RunState, a: PlayerAction, rng: Rng): void {
  if (s.steps >= s.maxSteps) {
    finishRun(s, false, 'step-cap')
    return
  }
  s.steps++
  if (a.kind === 'auto') {
    exploreStep(s, rng)
    return
  }
  if (a.kind !== 'move') return
  s.exploreSteps++
  walkTo(s, { ...a.to }, rng)
}

/** Apply one combat action, keeping the member's telemetry like a bot turn's. */
function applyCombat(t: Turn, a: PlayerAction, rng: Rng): void {
  const { s, c, member, bot, battlers } = t
  if (a.kind === 'end-turn') {
    endHumanTurn(s, c, rng)
    return
  }
  if (a.kind === 'auto') {
    // Exactly the bot's turn (the same dice and telemetry as an all-bot run).
    delete c.humanTurn
    botMemberTurn(s, c, bot, member, battlers, rng, rngOf(s.policyRng))
    return
  }
  const enemyHp = sumHp(battlers, 'enemy')
  const partyHp = sumHp(battlers, 'player')
  const up = enemiesUp(battlers)
  const slots = (bot.spellSlots ?? []).reduce((x, y) => x + y, 0)
  const potions = bot.potions ?? 0
  const label = act(t, a, rng)
  if (label) member.usage[label] = (member.usage[label] ?? 0) + 1
  member.stats.slotsSpent += Math.max(0, slots - (bot.spellSlots ?? []).reduce((x, y) => x + y, 0))
  member.stats.potionsUsed += Math.max(0, potions - (bot.potions ?? 0))
  member.damage += Math.max(0, enemyHp - sumHp(battlers, 'enemy'))
  member.healing += Math.max(0, sumHp(battlers, 'player') - partyHp)
  member.kills += Math.max(0, up - enemiesUp(battlers))
  // With no foe left the fight is over: close the turn so the run moves on.
  if (enemiesUp(battlers) === 0) endHumanTurn(s, c, rng)
}

/** Resolve the action's effect; returns the usage label. */
function act(t: Turn, a: PlayerAction, rng: Rng): string | null {
  const { turn, bot, battlers, map } = t
  switch (a.kind) {
    case 'move':
      bot.pos = { ...a.to }
      turn.movementLeft--
      return null
    case 'attack': {
      const atk = kitOf(bot).find((x) => x.name === a.attack)!
      const foe = foeById(t, a.target)!
      if (a.bonus) turn.bonusUsed = true
      else if (isWeapon(atk) && turn.attacksLeft > 0) turn.attacksLeft--
      else {
        turn.actionUsed = true
        turn.attacksLeft = isWeapon(atk) ? perAction(bot) - 1 : 0
      }
      const cast = atk.source === 'spell' ? upcast(atk, spendSlot(bot, atk)) : atk
      resolveAttack(rng, bot, cast, foe, combatMode(bot, foe, cast), battlers, map)
      return atk.name
    }
    case 'area': {
      const atk = kitOf(bot).find((x) => x.name === a.attack)!
      turn.actionUsed = true
      turn.attacksLeft = 0
      const cast = atk.source === 'spell' ? upcast(atk, spendSlot(bot, atk)) : atk
      resolveAreaAttack(rng, bot, cast, a.center, battlers, cast.area ?? 1)
      return atk.name
    }
    case 'cast': return castSpell(t, a, rng)
    case 'heal': {
      const h = bot.attacks.find((x) => x.name === a.spell)!
      const target = battlers.find((b) => b.id === a.target)!
      if (h.bonusAction) {
        turn.bonusUsed = true
        turn.bonusSpell = true
      } else {
        turn.actionUsed = true
        turn.attacksLeft = 0
      }
      const cast = upcast(h, spendSlot(bot, h))
      const hb = findEffect(bot, 'healingBonus')
      healBattler(target, rollDamage(rng, cast.heal!).total + (hb ? hb.n + (cast.slotLevel ?? 1) : 0))
      return target === bot ? h.name : `${h.name} (ally)`
    }
    case 'potion':
      turn.actionUsed = true
      turn.attacksLeft = 0
      bot.potions = (bot.potions ?? 0) - 1
      healBattler(bot, rollDamage(rng, { count: 2, sides: 4, bonus: 2 }).total)
      return 'Healing Potion'
    case 'feature': return useFeature(t, a.feature, a.target, rng)
    case 'wand': {
      const foe = foeById(t, a.target)!
      turn.bonusUsed = true
      t.s.castCharges--
      resolveAttack(rng, bot, BOT_WAND, foe, combatMode(bot, foe, BOT_WAND), battlers, map)
      return 'Wand (item)'
    }
    default: return null
  }
}

function castSpell(t: Turn, a: { spell: string; targets?: string[]; center?: Vec2 }, rng: Rng): string {
  const { turn, bot, battlers, map, c } = t
  const atk = bot.attacks.find((x) => x.name === a.spell)!
  const targets = (a.targets ?? []).map((id) => foeById(t, id)).filter((x): x is Battler => !!x)
  if (atk.control?.kind === 'mark') {
    turn.bonusUsed = true
    const moving = bot.concentration === atk.name && !markedBy(bot, battlers)
    if (moving) placeMark(bot, atk, targets[0], battlers, false)
    else {
      turn.bonusSpell = true
      castControl(rng, bot, atk, { targets }, battlers, map, (i) => `ally-${c.nextAllyId + i}`)
    }
    return atk.name
  }
  turn.actionUsed = true
  turn.attacksLeft = 0
  const ctx = turnContext(c)
  const res = castControl(rng, bot, atk, { targets, center: a.center }, battlers, map, ctx.summonId)
  if (res.summons.length > 0) ctx.addSummons(res.summons)
  return atk.name
}

function useFeature(t: Turn, f: FeatureKey, target: string | undefined, rng: Rng): string {
  const { turn, bot, battlers } = t
  const res = bot.resources!
  switch (f) {
    case 'rage':
      turn.bonusUsed = true
      addCondition(bot, 'raging')
      res.rage -= 1
      return 'Rage'
    case 'second-wind':
      turn.bonusUsed = true
      healBattler(bot, rollDamage(rng, { count: 1, sides: 10, bonus: bot.classLevels?.fighter ?? 1 }).total)
      res.secondWind -= 1
      return 'Second Wind'
    case 'action-surge':
      turn.actionUsed = false
      turn.attacksLeft = 0
      turn.surged = true
      res.actionSurge -= 1
      return 'Action Surge'
    case 'patient-defense':
      turn.bonusUsed = true
      addCondition(bot, 'dodging')
      return 'Patient Defense'
    case 'hide': {
      turn.bonusUsed = true
      const perception = Math.max(10, ...battlers.filter((b) => b.team !== bot.team && b.hp > 0).map((b) => b.passivePerception ?? 10))
      if (rollDie(rng, 20) + bot.initiativeMod + 2 * profBonus(bot.charLevel ?? 1) > perception) addCondition(bot, 'hidden')
      return 'Hide'
    }
    case 'dash':
      if (has(bot, 'cunning-dash')) turn.bonusUsed = true
      else {
        turn.actionUsed = true
        turn.attacksLeft = 0
      }
      turn.movementLeft += bot.speedTiles
      return has(bot, 'cunning-dash') ? 'Cunning Action' : 'Dash'
    case 'wild-shape': {
      const form = wildShapeForm(bot.classLevels?.druid ?? 0)!
      turn.actionUsed = true
      turn.attacksLeft = 0
      bot.wildShape = { form, hp: form.hp, formerAc: bot.ac }
      bot.ac = form.ac
      res.wildShape -= 1
      return `Wild Shape (${form.name})`
    }
    case 'inspire': {
      turn.bonusUsed = true
      const ally = battlers.find((b) => b.id === target)!
      addCondition(ally, 'inspired')
      ally.inspirationDie = bardicDie(bot.classLevels?.bard ?? 1)
      res.inspiration -= 1
      return 'Bardic Inspiration'
    }
  }
}
