import type { GameMap, Vec2 } from './types'
import { inBounds, tileAt } from './map'
import { Tile } from './types'

// ---------------------------------------------------------------------------
// Line of sight + visibility — used by exploration (what the party has seen)
// and enemy detection (can a foe see the party). Pure + testable.
//
// A wall blocks sight. LoS is checked along the integer line between two tiles
// (Bresenham); the endpoints themselves don't block (you can see the wall/foe
// you're looking at, and your own tile is always visible).
// ---------------------------------------------------------------------------

function isWall(map: GameMap, x: number, y: number): boolean {
  return tileAt(map, x, y) === Tile.Wall
}

/**
 * Clear line of sight from `from` to `to`? Walks the Bresenham line and returns
 * false if any tile strictly between the two endpoints is a wall.
 */
export function lineOfSight(map: GameMap, from: Vec2, to: Vec2): boolean {
  let x0 = from.x
  let y0 = from.y
  const x1 = to.x
  const y1 = to.y
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy

  // Step along the line; stop before the destination so endpoints never block.
  for (;;) {
    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      x0 += sx
    }
    if (e2 < dx) {
      err += dy
      y0 += sy
    }
    if (x0 === x1 && y0 === y1) break
    if (isWall(map, x0, y0)) return false
  }
  return true
}

// Per-octant transform multipliers (xx, xy, yx, yy) for recursive shadowcasting.
const FOV_MULT: readonly (readonly number[])[] = [
  [1, 0, 0, -1, -1, 0, 0, 1],
  [0, 1, -1, 0, 0, -1, 1, 0],
  [0, 1, 1, 0, 0, -1, -1, 0],
  [1, 0, 0, 1, -1, 0, 0, -1],
]

/**
 * Recursive shadowcasting (Björn Bergström's algorithm) for ONE octant. Walls
 * cast shadows the way light does, so the lit area hugs corners and properly
 * occludes everything behind a wall — the Cataclysm: DDA look — instead of the
 * artifacts a per-tile ray scan can leave. A wall tile is itself lit (you see
 * its near face) but blocks the cells beyond it.
 */
function castLight(
  map: GameMap, cx: number, cy: number, radius: number, r2: number,
  row: number, startSlope: number, endSlope: number,
  xx: number, xy: number, yx: number, yy: number,
  visit: (x: number, y: number) => void,
): void {
  if (startSlope < endSlope) return
  let start = startSlope
  let newStart = 0
  for (let i = row; i <= radius; i++) {
    let blocked = false
    let dx = -i - 1
    const dy = -i
    while (dx <= 0) {
      dx += 1
      const mx = cx + dx * xx + dy * xy
      const my = cy + dx * yx + dy * yy
      const lSlope = (dx - 0.5) / (dy + 0.5)
      const rSlope = (dx + 0.5) / (dy - 0.5)
      if (rSlope > start) continue
      if (lSlope < endSlope) break
      if (dx * dx + dy * dy <= r2) visit(mx, my)
      const wall = !inBounds(map, mx, my) || tileAt(map, mx, my) === Tile.Wall
      if (blocked) {
        if (wall) {
          newStart = rSlope
        } else {
          blocked = false
          start = newStart
        }
      } else if (wall && i < radius) {
        // A wall begins a shadow: recurse for the lit strip beside it, then keep
        // scanning this row as "blocked" until the wall ends.
        blocked = true
        castLight(map, cx, cy, radius, r2, i + 1, start, lSlope, xx, xy, yx, yy, visit)
        newStart = rSlope
      }
    }
    if (blocked) break
  }
}

/**
 * Tiles the hero can see from `from` within `radius`, via recursive
 * shadowcasting across the eight octants (walls occlude naturally — see
 * `castLight`). The origin is always included; the lit region is a round,
 * corner-hugging glow rather than a hard circle of independent rays.
 */
export function visibleTiles(map: GameMap, from: Vec2, radius: number): Vec2[] {
  const out: Vec2[] = []
  const seen = new Set<string>()
  const r2 = (radius + 0.5) * (radius + 0.5)
  const visit = (x: number, y: number): void => {
    if (!inBounds(map, x, y)) return
    const k = `${x},${y}`
    if (seen.has(k)) return
    seen.add(k)
    out.push({ x, y })
  }
  visit(from.x, from.y) // your own tile is always visible
  for (let oct = 0; oct < 8; oct++) {
    castLight(map, from.x, from.y, radius, r2, 1, 1.0, 0.0, FOV_MULT[0][oct], FOV_MULT[1][oct], FOV_MULT[2][oct], FOV_MULT[3][oct], visit)
  }
  return out
}
