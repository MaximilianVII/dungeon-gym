import type { GameMap, Vec2 } from '../game/types'
import { tileDistance } from '../game/logic'
import { lineOfSight } from '../game/los'
import type { DamageDice } from '../combat/dice'
import { canHold, conjureCount, holdTargetCount, isIncapacitated, patternTargets, sleepPool, sleepVictims } from '../combat/control'
import { castingSlotIndex } from '../combat/slots'
import type { Battler, CombatAttack } from '../combat/types'

// ---------------------------------------------------------------------------
// When a bot spends a slot on a control spell instead of damage. A control
// spell is worth it when it takes more enemy HP out of the fight than the
// bot's best action would deal in two turns (three for Conjure Animals,
// which lasts the whole fight):
//   • Conjure Animals — no beasts of its own yet, a big enough fight.
//   • Sleep — the burst whose likely pool (met ~70 % of the time) sleeps the
//     most enemy HP, and whose pool would reach no ally even on a high roll
//     (Sleep is not selective). If it would put every awake foe to sleep, the
//     one the bot wakes with its next hit does not count.
//   • Hypnotic Pattern — the burst whose foes' HP × fail chance is largest,
//     with no ally inside (it is not selective either).
//   • Hold Person — the toughest humanoid in range (+ extra targets within
//     30 ft of it from a higher slot); a WIS save negates, so its value is
//     discounted by the chance to fail.
// Concentration spells are skipped while the bot already concentrates.
// ---------------------------------------------------------------------------

/** Turns of the bot's best damage a control spell has to beat. */
const WORTH_TURNS = 2
const CONJURE_WORTH_TURNS = 3
/** Rough chance a monster fails a WIS save (DC 13–15 vs +0–2). */
const WIS_FAIL_CHANCE = 0.6
/** Hold Person's extra targets must be within 30 ft of each other. */
const HOLD_SPREAD = 6

export interface ControlPlan {
  attack: CombatAttack
  targets: Battler[]
  center?: Vec2
}

function avgOf(d: DamageDice): number {
  return d.count * (d.sides + 1) / 2 + d.bonus
}

/** The roll of `d` at `z` standard deviations from the mean (clamped to the
 *  possible range): +1.5 ≈ a high roll (93rd percentile), −0.5 ≈ a roll met
 *  about 70 % of the time. */
function rollAt(d: DamageDice, z: number): number {
  const sd = Math.sqrt(d.count * (d.sides * d.sides - 1) / 12)
  return Math.max(d.count + d.bonus, Math.min(d.count * d.sides + d.bonus, avgOf(d) + z * sd))
}

const sumHp = (list: readonly Battler[]): number => list.reduce((a, b) => a + b.hp, 0)

/**
 * Expected damage `bot` takes before its next turn: every awake foe that would
 * pick it (the monster AI goes for the nearest creature) and can reach it
 * with a move plus its best ready attack (hit chance from the bot's AC).
 */
export function incomingDamage(bot: Battler, battlers: readonly Battler[]): number {
  const side = battlers.filter((b) => b.team === bot.team && b.hp > 0 && b !== bot)
  let total = 0
  for (const f of battlers) {
    if (f.team === bot.team || f.hp <= 0 || isIncapacitated(f)) continue
    const d = tileDistance(f.pos, bot.pos)
    if (side.some((o) => tileDistance(f.pos, o.pos) < d)) continue
    let best = 0
    for (const a of f.attacks) {
      if ((a.recharge && f.spent?.includes(a.name)) || d > f.speedTiles + a.range) continue
      const hit = Math.min(0.95, Math.max(0.05, (21 - bot.ac + a.toHit) / 20))
      best = Math.max(best, hit * (a.recharge ? 1 : f.attacksPerAction) * avgOf(a.damage))
    }
    total += best
  }
  return total
}

export interface ControlOptions {
  /** Average damage of the bot's best attack action this turn. */
  bestDamage: number
  bossFight: boolean
  /** Hold leveled spells for the boss (the slotReserve gene fired). */
  reserveSlots: boolean
  /** Summons can join this fight (the run passed a turn context). */
  canSummon: boolean
}

/** Pick the control spell worth casting this turn, or null. */
export function planControl(bot: Battler, battlers: readonly Battler[], map: GameMap, opts: ControlOptions): ControlPlan | null {
  if (bot.wildShape || (opts.reserveSlots && !opts.bossFight)) return null
  const foes = battlers.filter((b) => b.team !== bot.team && b.hp > 0)
  const awake = foes.filter((f) => !isIncapacitated(f))
  if (awake.length === 0) return null
  const spells = bot.attacks.filter((a) => a.control && a.control.kind !== 'mark' && castingSlotIndex(bot, a) >= 0)
  const slotOf = (a: CombatAttack): number => castingSlotIndex(bot, a) + 1
  const inReach = (a: CombatAttack, t: Battler): boolean => tileDistance(bot.pos, t.pos) <= a.range && lineOfSight(map, bot.pos, t.pos)
  const bar = Math.max(1, opts.bestDamage) * WORTH_TURNS

  const conjure = spells.find((a) => a.control?.kind === 'conjure')
  if (conjure && opts.canSummon && !bot.concentration && conjureCount(conjure, slotOf(conjure)) > 0) {
    const ownBeasts = battlers.some((b) => b.summoner === bot.id && b.hp > 0)
    if (!ownBeasts && (opts.bossFight || sumHp(awake) >= Math.max(1, opts.bestDamage) * CONJURE_WORTH_TURNS)) return { attack: conjure, targets: [] }
  }

  let best: ControlPlan | null = null
  let bestValue = bar
  const sleep = spells.find((a) => a.control?.kind === 'sleep')
  if (sleep?.control?.kind === 'sleep') {
    const pool = sleepPool(sleep, slotOf(sleep))
    const radius = sleep.control.radius
    for (const f of awake) {
      if (!inReach(sleep, f)) continue
      const worst = sleepVictims(f.pos, battlers, radius, rollAt(pool, 1.5))
      if (worst.some((b) => b.team === bot.team)) continue
      const slept = sleepVictims(f.pos, battlers, radius, rollAt(pool, -0.5)).filter((b) => b.team !== bot.team)
      const wakesOne = slept.length === awake.length
      const value = sumHp(slept) - (wakesOne ? Math.max(0, ...slept.map((b) => b.hp)) : 0)
      if (value > bestValue) {
        bestValue = value
        best = { attack: sleep, targets: [], center: { ...f.pos } }
      }
    }
  }
  const pattern = bot.concentration ? undefined : spells.find((a) => a.control?.kind === 'pattern')
  if (pattern?.control?.kind === 'pattern') {
    const radius = pattern.control.radius
    for (const f of awake) {
      if (!inReach(pattern, f)) continue
      const caught = patternTargets(f.pos, battlers, radius)
      if (caught.some((b) => b.team === bot.team)) continue
      const wakesOne = caught.length === awake.length
      const value = (sumHp(caught) - (wakesOne ? Math.max(0, ...caught.map((b) => b.hp)) : 0)) * WIS_FAIL_CHANCE
      if (value > bestValue) {
        bestValue = value
        best = { attack: pattern, targets: [], center: { ...f.pos } }
      }
    }
  }
  const hold = bot.concentration ? undefined : spells.find((a) => a.control?.kind === 'hold')
  if (hold) {
    const cands = awake.filter((f) => canHold(hold, f) && inReach(hold, f)).sort((a, b) => b.hp - a.hp)
    if (cands.length > 0) {
      const first = cands[0]
      const group = [first, ...cands.slice(1).filter((c) => tileDistance(c.pos, first.pos) <= HOLD_SPREAD)].slice(0, holdTargetCount(slotOf(hold)))
      const value = sumHp(group) * WIS_FAIL_CHANCE
      if (value > bestValue || (first.role === 'boss' && !best)) {
        bestValue = value
        best = { attack: hold, targets: group }
      }
    }
  }
  return best
}
