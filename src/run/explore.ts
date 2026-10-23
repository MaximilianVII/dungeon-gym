import type { GameMap, Vec2 } from '../game/types'
import { isWalkable } from '../game/map'
import { tileDistance } from '../game/logic'
import { lineOfSight, visibleTiles } from '../game/los'
import { rollDamage, type Rng } from '../combat/dice'
import { getMonster } from '../combat/monsters'
import { generateLevelForRun } from '../dungeon/generate'
import { TRAP_DAMAGE, SHRINE_FRAC, LONG_REST_EVERY, VISION_RADIUS, type Spawn, type RunState } from './types'
import { DIRS, bfsNextStep, reachableFrom } from './grid'
import { aliveMembers, currentLevel, killMember, finishRun } from './state'
import { restParty, grantReward } from './members'
import { startCombat } from './combat'

// ---------------------------------------------------------------------------
// Exploration: loading a level, sweeping it toward unseen tiles, traps,
// shrines, spotting foes, and moving on to the next level.
// ---------------------------------------------------------------------------

/** Reveal the field of view around a point (only reachable floor counts). */
export function reveal(s: RunState, map: GameMap, at: Vec2): void {
  for (const t of visibleTiles(map, at, VISION_RADIUS)) {
    const i = t.x + t.y * map.width
    if (s.reachable[i] && !s.seen[i]) {
      s.seen[i] = 1
      s.seenCount++
    }
  }
}

/** The nearest UNSEEN reachable tile (BFS frontier), or null. */
export function nearestUnseen(s: RunState, map: GameMap): Vec2 | null {
  const W = map.width
  const H = map.height
  const visited = new Uint8Array(W * H)
  const q: Vec2[] = [s.pos]
  visited[s.pos.x + s.pos.y * W] = 1
  let head = 0
  while (head < q.length) {
    const p = q[head++]
    if (!s.seen[p.x + p.y * W] && !(p.x === s.pos.x && p.y === s.pos.y)) return p
    for (const [dx, dy] of DIRS) {
      const nx = p.x + dx
      const ny = p.y + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const ni = nx + ny * W
      if (visited[ni] || !isWalkable(map, nx, ny)) continue
      visited[ni] = 1
      q.push({ x: nx, y: ny })
    }
  }
  return null
}

export function loadLevel(s: RunState): void {
  const lvl = generateLevelForRun(s.seed, s.levelIndex, s.levelIndex === s.depth - 1, { enemyScale: s.enemyScale })
  s.level = lvl
  s.pos = { ...lvl.map.spawn }
  s.remaining = lvl.enemies.map((e) => ({ id: s.nextSpawnId++, key: e.key, pos: { ...e.pos }, group: e.group }))
  s.traps = lvl.traps.map((p) => ({ pos: { ...p }, armed: true }))
  s.shrines = lvl.shrines.map((p) => ({ pos: { ...p }, used: false }))
  for (const m of s.members) {
    if (!m.alive) continue
    m.battler.pos = { ...s.pos }
    m.depthReached = Math.max(m.depthReached, s.levelIndex + 1)
  }
  const reach = reachableFrom(lvl.map, s.pos)
  s.reachable = reach.flags
  s.reachableFloor = reach.count
  s.seen = new Array<number>(reach.flags.length).fill(0)
  s.seenCount = 0
  s.exploreSteps = 0
  s.shortRestsThisLevel = 0
  s.exploreBudget = Math.min(3000, Math.max(200, s.reachableFloor * 2))
  reveal(s, lvl.map, s.pos)
}

export function nextLevel(s: RunState): void {
  s.levelIndex++
  if (s.levelIndex >= s.depth) {
    finishRun(s, true, 'won')
    return
  }
  let longRest = s.levelIndex % LONG_REST_EVERY === 0
  if (!longRest && s.longRestKits > 0) {
    s.longRestKits--
    longRest = true
  }
  restParty(s, longRest)
  s.level = null
}

export function spotted(s: RunState, map: GameMap): Spawn | null {
  for (const e of s.remaining) {
    const mon = getMonster(e.key)
    if (!mon) continue
    if (tileDistance(s.pos, e.pos) > mon.visionRadius) continue
    if (!lineOfSight(map, e.pos, s.pos)) continue
    return e
  }
  return null
}

export function exploreStep(s: RunState, rng: Rng): void {
  if (!s.level) {
    loadLevel(s)
    return
  }
  const map = s.level.map
  if (s.pos.x === map.waypoint.x && s.pos.y === map.waypoint.y) {
    grantReward(s, rng)
    nextLevel(s)
    return
  }
  // Sweep toward the nearest unseen tile until the leader's coverage target is
  // met or the per-level budget is spent, then head for the exit.
  const leader = aliveMembers(s)[0]
  const coverage = leader ? leader.genes.exploreCoverage : 0
  const covered = s.reachableFloor > 0 && s.seenCount / s.reachableFloor >= coverage
  const budgetSpent = s.exploreSteps >= s.exploreBudget
  let target: Vec2 = map.waypoint
  let toExit = true
  if (!covered && !budgetSpent) {
    const frontier = nearestUnseen(s, map)
    if (frontier) {
      target = frontier
      toExit = false
    }
  }
  let next = bfsNextStep(map, s.pos, target)
  if (!next && !toExit) next = bfsNextStep(map, s.pos, map.waypoint)
  if (!next) {
    finishRun(s, false, 'stuck')
    return
  }
  walkTo(s, next, rng)
}

/** Move the party one step to `next` (adjacent, walkable) and resolve what is
 *  there: vision, a trap, a shrine, foes that spot the party. */
export function walkTo(s: RunState, next: Vec2, rng: Rng): void {
  const map = currentLevel(s).map
  s.pos = next
  s.exploreSteps++
  for (const m of aliveMembers(s)) m.battler.pos = { ...next }
  reveal(s, map, s.pos)
  // Trap underfoot — hits the member leading the march.
  const trap = s.traps.find((t) => t.armed && t.pos.x === next.x && t.pos.y === next.y)
  if (trap) {
    trap.armed = false
    const victim = aliveMembers(s)[0]
    if (victim) {
      victim.battler.hp = Math.max(0, victim.battler.hp - rollDamage(rng, TRAP_DAMAGE).total)
      if (victim.battler.hp <= 0) killMember(s, victim, 'trap')
    }
    if (aliveMembers(s).length === 0) {
      finishRun(s, false, 'wiped')
      return
    }
  }
  // Healing shrine underfoot — mend the whole party once.
  const shrine = s.shrines.find((sh) => !sh.used && sh.pos.x === next.x && sh.pos.y === next.y)
  if (shrine) {
    shrine.used = true
    for (const m of aliveMembers(s)) m.battler.hp = Math.min(m.battler.maxHp, m.battler.hp + Math.round(m.battler.maxHp * SHRINE_FRAC))
  }
  const spotter = spotted(s, map)
  if (spotter) startCombat(s, spotter, rng)
}
