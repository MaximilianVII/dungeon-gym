import type { GameMap, Vec2 } from '../game/types'
import { isWalkable } from '../game/map'
import { tileDistance } from '../game/logic'
import { lineOfSight } from '../game/los'
import { hasCondition, type Battler, type CombatAttack } from './types'
import type { DamageDice } from './dice'

// ---------------------------------------------------------------------------
// Enemy AI (deliberately simple). On its turn an enemy: picks the nearest living
// player, steps toward it (greedy, diagonal = 1, up to its movement budget,
// avoiding walls and occupied tiles), and attacks if a target is in range —
// melee when adjacent, otherwise a ranged attack if it has one.
//
// Greedy stepping (not full pathfinding); A* can replace `bestStep` later
// without touching the rest of the turn logic.
// ---------------------------------------------------------------------------

export interface EnemyPlan {
  /** Tiles to move through this turn, in order (excludes the start tile). */
  moves: Vec2[]
  finalPos: Vec2
  /** The attack to make after moving, and whom to make it against. */
  attack?: { attack: CombatAttack; targetId: string }
  /** A healer's choice: mend a wounded ally instead of attacking. */
  heal?: { targetId: string; dice: DamageDice }
}

function key(p: Vec2): string {
  return `${p.x},${p.y}`
}

function bestStep(from: Vec2, target: Vec2, map: GameMap, occupied: Set<string>): Vec2 | null {
  const dx = Math.sign(target.x - from.x)
  const dy = Math.sign(target.y - from.y)
  const candidates: Vec2[] = [
    { x: from.x + dx, y: from.y + dy }, // straight toward (diagonal if both)
    { x: from.x + dx, y: from.y },
    { x: from.x, y: from.y + dy },
  ].filter((c) => c.x !== from.x || c.y !== from.y)
  for (const c of candidates) {
    if (isWalkable(map, c.x, c.y) && !occupied.has(key(c))) return c
  }
  return null
}

/** A step that increases distance from `target` (used by kiting ranged foes). */
function bestStepAway(from: Vec2, target: Vec2, map: GameMap, occupied: Set<string>): Vec2 | null {
  const dx = Math.sign(from.x - target.x)
  const dy = Math.sign(from.y - target.y)
  const candidates: Vec2[] = [
    { x: from.x + dx, y: from.y + dy },
    { x: from.x + dx, y: from.y },
    { x: from.x, y: from.y + dy },
  ].filter((c) => c.x !== from.x || c.y !== from.y)
  for (const c of candidates) {
    if (isWalkable(map, c.x, c.y) && !occupied.has(key(c))) return c
  }
  return null
}

function chooseAttack(enemy: Battler, dist: number, hasLos: boolean): CombatAttack | undefined {
  // Attacks with a Recharge that are spent this fight are unavailable.
  const ready = enemy.attacks.filter((a) => !(a.recharge && enemy.spent?.includes(a.name)))
  const melee = ready.find((a) => a.range <= 1)
  const ranged = ready.find((a) => a.range > 1)
  if (dist <= 1 && melee) return melee
  // A ranged attack needs a clear line of sight (no firing through walls).
  if (ranged && dist <= ranged.range && hasLos) return ranged
  if (melee && dist <= melee.range) return melee
  return undefined
}

export function planEnemyTurn(enemy: Battler, battlers: Battler[], map: GameMap): EnemyPlan {
  const targets = battlers.filter((b) => b.team === 'player' && b.hp > 0)
  if (targets.length === 0) return { moves: [], finalPos: { ...enemy.pos } }

  // HEALER: if a wounded ally (its own team, itself included) is within reach,
  // mend the most-hurt one instead of attacking.
  if (enemy.role === 'healer') {
    let ally: Battler | undefined
    let worstFrac = 1
    for (const a of battlers) {
      if (a.team !== 'enemy' || a.hp <= 0 || a.hp >= a.maxHp) continue
      if (tileDistance(enemy.pos, a.pos) > 6) continue
      const frac = a.hp / a.maxHp
      if (frac < worstFrac) {
        worstFrac = frac
        ally = a
      }
    }
    if (ally) {
      return { moves: [], finalPos: { ...enemy.pos }, heal: { targetId: ally.id, dice: { count: 1, sides: 8, bonus: 2 } } }
    }
    // No one to heal → fall through and attack like anyone else.
  }

  // Nearest living player.
  let target = targets[0]
  let best = tileDistance(enemy.pos, target.pos)
  for (const tcand of targets) {
    const d = tileDistance(enemy.pos, tcand.pos)
    if (d < best) {
      best = d
      target = tcand
    }
  }

  // Tiles blocked by other living battlers (the target's own tile included, so
  // the enemy stops adjacent rather than walking onto it).
  const occupied = new Set(
    battlers.filter((b) => b.id !== enemy.id && b.hp > 0).map((b) => key(b.pos)),
  )

  const ranged = enemy.attacks.find((a) => a.range > 1)
  const kite = (enemy.role === 'ranged' || enemy.role === 'caster') && !!ranged

  const moves: Vec2[] = []
  let cur: Vec2 = { ...enemy.pos }
  // Restrained (webbed) → speed 0: it can still attack, but it can't reposition.
  let budget = hasCondition(enemy, 'restrained') ? 0 : enemy.speedTiles

  if (kite) {
    // Keep distance: back off if a player is adjacent, close in only if out of
    // shooting range, otherwise hold position and fire.
    while (budget > 0) {
      const d = tileDistance(cur, target.pos)
      let step: Vec2 | null = null
      if (d <= 1) step = bestStepAway(cur, target.pos, map, occupied)
      // Out of range OR no clear shot → close in (also to round a wall for LoS).
      else if (d > ranged!.range || !lineOfSight(map, cur, target.pos)) step = bestStep(cur, target.pos, map, occupied)
      else break
      if (!step) break
      cur = step
      moves.push({ ...cur })
      budget--
    }
  } else {
    // Brute / skirmisher / default: march in until adjacent.
    while (tileDistance(cur, target.pos) > 1 && budget > 0) {
      const next = bestStep(cur, target.pos, map, occupied)
      if (!next) break
      cur = next
      moves.push({ ...cur })
      budget--
    }
  }

  const dist = tileDistance(cur, target.pos)
  const hasLos = lineOfSight(map, cur, target.pos)
  const attack = chooseAttack(enemy, dist, hasLos)
  return {
    moves,
    finalPos: cur,
    attack: attack ? { attack, targetId: target.id } : undefined,
  }
}
