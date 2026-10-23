import { isWalkable } from './map'
import type { GameMap, Vec2 } from './types'

// Pure movement rules. Diagonal steps move one tile in each axis at once and
// count as a single tile (not the 5e 1-2-1 rule).

/**
 * Attempt one step from `from` by (dx, dy), each in {-1, 0, 1}. Returns the new
 * position if the destination tile is walkable, otherwise the original
 * position unchanged (you bump into the wall and stay put).
 */
export function tryStep(map: GameMap, from: Vec2, dx: number, dy: number): Vec2 {
  if (dx === 0 && dy === 0) return from
  const nx = from.x + dx
  const ny = from.y + dy
  return isWalkable(map, nx, ny) ? { x: nx, y: ny } : from
}

/** Chebyshev distance: the number of tiles between two points when diagonal = 1. */
export function tileDistance(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}
