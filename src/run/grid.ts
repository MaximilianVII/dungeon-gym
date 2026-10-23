import type { GameMap, Vec2 } from '../game/types'
import { isWalkable } from '../game/map'

// ---------------------------------------------------------------------------
// Pure map helpers for a run: BFS steps, reachability, spreading a party out.
// ---------------------------------------------------------------------------

export const DIRS: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
]

export function bfsNextStep(map: GameMap, from: Vec2, goal: Vec2): Vec2 | null {
  if (from.x === goal.x && from.y === goal.y) return null
  const W = map.width
  const H = map.height
  const startIdx = from.x + from.y * W
  const goalIdx = goal.x + goal.y * W
  const visited = new Uint8Array(W * H)
  const prev = new Int32Array(W * H).fill(-1)
  const q: number[] = [startIdx]
  visited[startIdx] = 1
  let head = 0
  while (head < q.length) {
    const idx = q[head++]
    if (idx === goalIdx) break
    const cx = idx % W
    const cy = (idx / W) | 0
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const ni = nx + ny * W
      if (visited[ni] || !isWalkable(map, nx, ny)) continue
      visited[ni] = 1
      prev[ni] = idx
      q.push(ni)
    }
  }
  if (!visited[goalIdx]) return null
  let cur = goalIdx
  while (prev[cur] !== -1 && prev[cur] !== startIdx) cur = prev[cur]
  if (prev[cur] === -1) return null
  return { x: cur % W, y: (cur / W) | 0 }
}

/** Free tiles fanning out from the party's tile (BFS through walkable floor
 *  only, never through walls or onto a foe), to spread the party for a fight. */
export function spreadPositions(map: GameMap, center: Vec2, n: number, blocked: Set<string>): Vec2[] {
  const out: Vec2[] = []
  const seen = new Set<string>([`${center.x},${center.y}`])
  const q: Vec2[] = [center]
  let head = 0
  while (head < q.length && out.length < n) {
    const p = q[head++]
    out.push(p)
    for (const [dx, dy] of DIRS) {
      const nx = p.x + dx
      const ny = p.y + dy
      const k = `${nx},${ny}`
      if (seen.has(k) || blocked.has(k) || !isWalkable(map, nx, ny)) continue
      seen.add(k)
      q.push({ x: nx, y: ny })
    }
  }
  while (out.length < n) out.push({ ...center })
  return out
}

/** 8-connected reachable floor from a start, as a 0/1 flag array. */
export function reachableFrom(map: GameMap, from: Vec2): { flags: number[]; count: number } {
  const W = map.width
  const flags = new Array<number>(W * map.height).fill(0)
  flags[from.x + from.y * W] = 1
  let count = 1
  const q: Vec2[] = [from]
  let head = 0
  while (head < q.length) {
    const p = q[head++]
    for (const [dx, dy] of DIRS) {
      const nx = p.x + dx
      const ny = p.y + dy
      if (!isWalkable(map, nx, ny)) continue
      const i = nx + ny * W
      if (flags[i]) continue
      flags[i] = 1
      count++
      q.push({ x: nx, y: ny })
    }
  }
  return { flags, count }
}
