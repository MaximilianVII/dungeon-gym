import { rollD20, rollDamage, rollDie, type D20Mode, type Rng } from './dice'
import type { Vec2 } from '../game/types'
import { addCondition, hasCondition, removeCondition, type Ability, type Battler, type CombatAttack, type CombatEvent, type Condition } from './types'
import { effectsOf, findEffect } from './subclasses'
import { VAMPIRIC_LIFESTEAL } from './affixes'
import { bardicDie } from './abilities'

// ---------------------------------------------------------------------------
// 5e-lite resolution: attack rolls, damage, and player death saving throws.
// Pure logic with an injected RNG. Functions MUTATE the battlers' hp /
// deathSaves / conditions and return the events that happened.
//
// 5e-lite cuts: no reactions / opportunity attacks, no concentration.
// Crit = double the damage dice (not the modifier).
// ---------------------------------------------------------------------------

/** Fraction of max HP a single hit can take from a player at full HP. */
const MERCY_CAP_FRAC = 0.6

/** Barbarian rage damage bonus by barbarian level (SRD table). */
export function rageDamageBonus(barbarianLevel: number): number {
  return barbarianLevel >= 16 ? 4 : barbarianLevel >= 9 ? 3 : 2
}

function setTimedCondition(target: Battler, condition: Condition, rounds: number): void {
  addCondition(target, condition)
  ;(target.condTimers ??= {})[condition] = rounds
}

/** Apply `amount` damage to a target, handling enemy death and player death saves. */
export function applyDamage(target: Battler, amount: number, crit: boolean, events: CombatEvent[]): void {
  // Wild Shape: the beast form soaks damage first; at 0 HP the druid reverts
  // and any excess carries over (SRD).
  const ws = target.wildShape
  if (ws) {
    const soaked = Math.min(amount, ws.hp)
    ws.hp -= soaked
    amount -= soaked
    if (ws.hp <= 0) endWildShape(target)
    if (amount <= 0) {
      events.push({ kind: 'damage', target: target.name, amount: soaked, hpLeft: target.hp })
      return
    }
  }
  // Mercy rule (anti one-shot): a player at FULL HP can't lose more than 60 %
  // of max HP to a single hit. Only the first hit while at full is capped.
  if (target.team === 'player' && target.hp >= target.maxHp && target.maxHp > 1) {
    const cap = Math.max(1, Math.floor(target.maxHp * MERCY_CAP_FRAC))
    if (amount > cap) amount = cap
  }
  const wasDown = target.hp <= 0
  target.hp = Math.max(0, target.hp - amount)
  events.push({ kind: 'damage', target: target.name, amount, hpLeft: target.hp })

  if (target.hp > 0) return

  if (target.team === 'enemy') {
    events.push({ kind: 'dead', who: target.name })
    return
  }

  // Player at 0 HP.
  const ds = (target.deathSaves ??= { successes: 0, failures: 0, stable: false, dead: false })
  if (ds.dead) return

  if (amount >= target.maxHp) {
    // Massive damage → instant death (simplified).
    ds.dead = true
    events.push({ kind: 'dead', who: target.name })
  } else if (wasDown) {
    // Taking a hit while already down: 1 failure, or 2 on a crit.
    ds.failures += crit ? 2 : 1
    ds.stable = false
    events.push({
      kind: 'death-save',
      who: target.name,
      d20: 0,
      result: crit ? 'crit-fail' : 'failure',
      successes: ds.successes,
      failures: ds.failures,
    })
    if (ds.failures >= 3) {
      ds.dead = true
      events.push({ kind: 'dead', who: target.name })
    }
  } else {
    // First drop to 0: unconscious; death saves begin next turn.
    addCondition(target, 'unconscious')
    events.push({ kind: 'down', who: target.name })
  }
}

/** Drop a druid's beast form (its own AC comes back). */
export function endWildShape(b: Battler): void {
  if (!b.wildShape) return
  b.ac = b.wildShape.formerAc
  delete b.wildShape
}

/** A saving throw: d20 + the creature's save bonus (DEX falls back to its
 *  initiative modifier, other abilities to +0). */
export function savingThrow(rng: Rng, b: Battler, ability: Ability): number {
  const bonus = b.saves?.[ability] ?? (ability === 'dex' ? b.initiativeMod : 0)
  return rollD20(rng).value + bonus
}

/** Sneak Attack dice by rogue level (SRD: 1d6 per two levels, rounded up). */
export function sneakAttackDice(rogueLevel: number): number {
  return Math.ceil(rogueLevel / 2)
}

/**
 * Resolve one attack from `attacker` against `target`. Returns the events.
 * `battlers` (optional) lets Sneak Attack see whether an ally of the attacker
 * stands next to the target.
 */
export function resolveAttack(
  rng: Rng,
  attacker: Battler,
  attack: CombatAttack,
  target: Battler,
  mode: D20Mode = 'normal',
  battlers: readonly Battler[] = [],
): CombatEvent[] {
  const events: CombatEvent[] = []
  // A hidden attacker gives its position away with the attack.
  removeCondition(attacker, 'hidden')
  if (attack.autoHit) {
    const dealt = rollDamage(rng, attack.damage, false).total
    events.push({ kind: 'attack', attacker: attacker.name, target: target.name, attackName: attack.name, d20: 0, total: 0, ac: target.ac, hit: true, crit: false })
    applyDamage(target, dealt, false, events)
    return events
  }
  const roll = rollD20(rng, mode)
  // Champion: crit on a lower face (lowest range across stacked effects).
  let critOn = 20
  for (const e of effectsOf(attacker)) if (e.kind === 'critRange') critOn = Math.min(critOn, e.range)
  const crit = roll.value >= critOn
  let total = roll.value + attack.toHit
  // Bardic Inspiration: an inspired attacker who would miss adds the die
  // (spent only when it is needed; a natural 1 still misses).
  if (hasCondition(attacker, 'inspired') && !roll.nat1 && !roll.nat20 && !crit && total < target.ac) {
    total += rollDie(rng, attacker.inspirationDie ?? 6)
    removeCondition(attacker, 'inspired')
    delete attacker.inspirationDie
  }
  // Bard Lore — Cutting Words (reaction, spends a Bardic Inspiration use):
  // subtract the bard's die from a hit against the bard, which can turn it
  // into a miss (a natural 20 still hits).
  const res = target.resources
  if (findEffect(target, 'cuttingWords') && res && res.inspiration > 0 && target.team !== attacker.team) {
    const provisionalHit = roll.nat20 || (!roll.nat1 && total >= target.ac)
    if (provisionalHit) {
      total -= rollDie(rng, bardicDie(target.classLevels?.bard ?? target.charLevel ?? 1))
      res.inspiration -= 1
    }
  }
  const hit = roll.nat20 || (!roll.nat1 && (total >= target.ac || crit))

  events.push({
    kind: 'attack',
    attacker: attacker.name,
    target: target.name,
    attackName: attack.name,
    d20: roll.value,
    total,
    ac: target.ac,
    hit,
    crit,
  })

  if (!hit) {
    // Evoker Potent Cantrip (simplified): a missed cantrip still deals half.
    if (attack.source === 'cantrip' && findEffect(attacker, 'potentCantrip')) {
      const half = Math.floor(rollDamage(rng, attack.damage, false).total / 2)
      if (half > 0) applyDamage(target, half, false, events)
    }
    return events
  }
  let amount = rollDamage(rng, attack.damage, crit).total
  // Rage: bonus on the rager's melee hits; a raging target halves physical damage.
  if (hasCondition(attacker, 'raging') && attack.range <= 1) {
    amount += rageDamageBonus(attacker.classLevels?.barbarian ?? attacker.charLevel ?? 1)
  }
  const physical = attack.damageType === 'bludgeoning' || attack.damageType === 'piercing' || attack.damageType === 'slashing'
  // Rogue Sneak Attack: once per turn with a weapon, when the attack has
  // advantage or another of the rogue's allies is next to the target.
  const rogue = attacker.classLevels?.rogue ?? 0
  if (rogue > 0 && !attacker.sneakAttackUsed && (attack.source ?? 'weapon') === 'weapon' && mode !== 'disadvantage') {
    const flanked = battlers.some((a) => a.team === attacker.team && a.id !== attacker.id && a.hp > 0 && chebyshev(a.pos, target.pos) <= 1)
    if (mode === 'advantage' || flanked) {
      amount += rollDamage(rng, { count: sneakAttackDice(rogue), sides: 6, bonus: 0 }, crit).total
      attacker.sneakAttackUsed = true
    }
  }
  // Hunter's Colossus Slayer: once per turn, +1d8 on a weapon hit vs a wounded target.
  if ((attack.source ?? 'weapon') === 'weapon' && !attacker.colossusSlayerUsed && target.hp < target.maxHp && findEffect(attacker, 'colossusSlayer')) {
    amount += rollDamage(rng, { count: 1, sides: 8, bonus: 0 }, crit).total
    attacker.colossusSlayerUsed = true
  }
  if (hasCondition(target, 'raging') && physical) amount = Math.floor(amount / 2)
  applyDamage(target, amount, crit, events)
  // Vampiric Touch: the caster regains half the damage dealt.
  if (attack.drain && amount > 0 && attacker.hp > 0) attacker.hp = Math.min(attacker.maxHp, attacker.hp + Math.floor(amount / 2))
  // Rider damage the target may save against for half (e.g. poison).
  if (attack.rider && target.hp > 0) {
    const r = attack.rider
    const extra = rollDamage(rng, r.damage, false).total
    const saved = savingThrow(rng, target, r.save) >= r.dc
    applyDamage(target, saved ? Math.floor(extra / 2) : extra, false, events)
  }
  // Vampiric elite: the attacker heals for part of the damage it dealt.
  if (attacker.affix === 'vampiric' && amount > 0 && attacker.hp > 0) {
    const healed = Math.min(attacker.maxHp - attacker.hp, Math.floor(amount * VAMPIRIC_LIFESTEAL))
    if (healed > 0) {
      attacker.hp += healed
      events.push({ kind: 'heal', who: attacker.name, amount: healed, spell: 'Vampiric' })
    }
  }
  // On a hit, inflict any rider condition (poison / web / fear) on a living target.
  if (attack.applies && target.hp > 0) {
    setTimedCondition(target, attack.applies.condition, attack.applies.rounds)
    events.push({ kind: 'condition', who: target.name, condition: attack.applies.condition })
  }
  // Monk Open Hand Technique (simplified): on a melee hit, 50/50 knock prone.
  if (target.hp > 0 && attack.range <= 1 && findEffect(attacker, 'openHandTechnique') && rng() < 0.5) {
    setTimedCondition(target, 'prone', 1)
    events.push({ kind: 'condition', who: target.name, condition: 'prone' })
  }
  return events
}

/** Chebyshev tile distance (diagonals count as one step), for burst radii. */
function chebyshev(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

/**
 * Resolve an AREA attack — a burst centred on `center`. Every LIVING foe of the
 * attacker within `radius` tiles is caught. The damage is rolled ONCE for the
 * whole blast; each target then makes a Dexterity saving throw (save bonus,
 * else DEX via initiative) vs DC (8 + the spell's attack bonus) — taking HALF on a
 * success and FULL on a failure. No friendly fire.
 */
export function resolveAreaAttack(
  rng: Rng,
  attacker: Battler,
  attack: CombatAttack,
  center: Vec2,
  battlers: Battler[],
  radius: number,
): CombatEvent[] {
  const events: CombatEvent[] = [{ kind: 'ability', who: attacker.name, ability: attack.name }]
  const dc = 8 + attack.toHit
  const full = rollDamage(rng, attack.damage, false).total
  const sculpt = !!findEffect(attacker, 'sculptSpells')
  for (const t of battlers) {
    if (t.hp <= 0) continue
    if (chebyshev(center, t.pos) > radius) continue
    if (t.team === attacker.team) {
      if (sculpt) events.push({ kind: 'ability', who: t.name, ability: 'Sculpted (0 damage)' })
      continue
    }
    let saved = savingThrow(rng, t, 'dex') >= dc
    // Warlock Fiend — Dark One's Own Luck (simplified): reroll one failed save per fight.
    if (!saved && !t.darkOneLuckUsed && findEffect(t, 'darkOneLuck')) {
      saved = savingThrow(rng, t, 'dex') >= dc
      t.darkOneLuckUsed = true
    }
    applyDamage(t, saved ? Math.floor(full / 2) : full, false, events)
    if (!saved && attack.applies && t.hp > 0) {
      setTimedCondition(t, attack.applies.condition, attack.applies.rounds)
      events.push({ kind: 'condition', who: t.name, condition: attack.applies.condition })
    }
  }
  return events
}

/**
 * Net advantage / disadvantage on an attack from conditions (they cancel out,
 * per 5e). A restrained or prone target grants advantage; a
 * frightened/poisoned/restrained attacker or a dodging target imposes
 * disadvantage. Prone gives advantage in melee, disadvantage at range.
 */
export function combatMode(attacker: Battler, target: Battler, attack: CombatAttack): D20Mode {
  let adv = 0
  let dis = 0
  if (hasCondition(attacker, 'hidden')) adv++
  if (hasCondition(attacker, 'frightened')) dis++
  if (hasCondition(attacker, 'poisoned')) dis++
  if (hasCondition(attacker, 'restrained')) dis++
  if (hasCondition(target, 'dodging')) dis++
  if (hasCondition(target, 'restrained')) adv++
  if (hasCondition(target, 'prone')) {
    if (attack.range <= 1) adv++
    else dis++
  }
  if (adv > dis) return 'advantage'
  if (dis > adv) return 'disadvantage'
  return 'normal'
}

/** Count down timed conditions at the start of a battler's turn; drop expired ones. */
export function tickConditions(b: Battler): void {
  if (!b.condTimers) return
  for (const c of Object.keys(b.condTimers)) {
    const left = (b.condTimers[c] ?? 0) - 1
    if (left <= 0) {
      removeCondition(b, c as Condition)
      delete b.condTimers[c]
    } else {
      b.condTimers[c] = left
    }
  }
}

/** A downed player's death saving throw (made on their turn). */
export function rollDeathSave(rng: Rng, player: Battler): CombatEvent[] {
  const events: CombatEvent[] = []
  const ds = (player.deathSaves ??= { successes: 0, failures: 0, stable: false, dead: false })
  if (ds.dead || ds.stable || player.hp > 0) return events

  const roll = rollD20(rng)
  let result: 'success' | 'failure' | 'revive' | 'crit-fail'
  if (roll.value === 20) {
    ds.successes = 0
    ds.failures = 0
    ds.stable = false
    player.hp = 1
    removeCondition(player, 'unconscious')
    result = 'revive'
  } else if (roll.value === 1) {
    ds.failures += 2
    result = 'crit-fail'
  } else if (roll.value >= 10) {
    ds.successes += 1
    result = 'success'
  } else {
    ds.failures += 1
    result = 'failure'
  }

  events.push({
    kind: 'death-save',
    who: player.name,
    d20: roll.value,
    result,
    successes: ds.successes,
    failures: ds.failures,
  })

  if (ds.failures >= 3) {
    ds.dead = true
    events.push({ kind: 'dead', who: player.name })
  } else if (ds.successes >= 3) {
    ds.stable = true
    events.push({ kind: 'stable', who: player.name })
  }
  return events
}
