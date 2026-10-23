import type { Vec2 } from '../game/types'
import { tileDistance } from '../game/logic'
import type { Rng } from './dice'
import type { Battler, CombatEvent } from './types'
import { resolveAreaAttack } from './resolve'

// ---------------------------------------------------------------------------
// Boss mechanics — a telegraphed AoE that makes a boss more than a big HP bar.
// A boss whose stat block carries a `telegraph` spec gets a `bossAoe` attack
// built onto its battler (combat/setup). Its turn then runs in two beats:
//   1. WIND-UP: off cooldown and a foe in range -> it marks the densest target
//      cluster (battler.telegraphCenter) and channels (a 'telegraph' event); it
//      does nothing else that turn, so players see it coming and can scatter.
//   2. BURST: the next boss turn unleashes resolveAreaAttack at the marked tile
//      (a Dex save for half vs every foe in the radius), then goes on cooldown.
// The run loop (bot/run) calls bossTurn() before the normal enemy turn, so any
// future client playing the same core sees the same boss. Pure: mutates the boss + rng.
// ---------------------------------------------------------------------------

const DEFAULT_COOLDOWN = 3

function livingFoes(boss: Battler, battlers: Battler[]): Battler[] {
  return battlers.filter((b) => b.team !== boss.team && b.hp > 0)
}

/** The foe tile whose burst of `radius` catches the most foes (aim the blast). */
function clusterCenter(foes: Battler[], radius: number): Vec2 {
  let best = foes[0].pos
  let bestN = -1
  for (const f of foes) {
    const n = foes.filter((o) => tileDistance(f.pos, o.pos) <= radius).length
    if (n > bestN) {
      bestN = n
      best = f.pos
    }
  }
  return { ...best }
}

/** Run a boss's special action for its turn. Returns the events it produced and
 *  whether it consumed the boss's whole turn (wind-up or burst). A non-boss (no
 *  bossAoe) returns consumed=false so the caller runs the ordinary enemy turn. */
export function bossTurn(rng: Rng, boss: Battler, battlers: Battler[]): { events: CombatEvent[]; consumed: boolean } {
  const aoe = boss.bossAoe
  if (!aoe) return { events: [], consumed: false }
  const foes = livingFoes(boss, battlers)
  if (foes.length === 0) return { events: [], consumed: false }

  // Burst turn: a wind-up is pending -> unleash it at the marked tile.
  if (boss.telegraphCenter) {
    const center = boss.telegraphCenter
    boss.telegraphCenter = undefined
    boss.telegraphCd = boss.telegraphCdMax ?? DEFAULT_COOLDOWN
    const events = resolveAreaAttack(rng, boss, aoe, center, battlers, aoe.area ?? 2)
    return { events, consumed: true }
  }

  // Wind-up turn: off cooldown and a foe within range -> mark + channel.
  if ((boss.telegraphCd ?? 0) <= 0 && foes.some((f) => tileDistance(boss.pos, f.pos) <= aoe.range)) {
    boss.telegraphCenter = clusterCenter(foes, aoe.area ?? 2)
    return { events: [{ kind: 'telegraph', who: boss.name, attackName: aoe.name }], consumed: true }
  }

  // Otherwise tick the cooldown and let the ordinary enemy turn run.
  if ((boss.telegraphCd ?? 0) > 0) boss.telegraphCd = (boss.telegraphCd ?? 0) - 1
  return { events: [], consumed: false }
}
