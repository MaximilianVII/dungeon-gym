// Core spatial + map types for the tile grid.
//
// The world is a 2D grid of SQUARE tiles seen top-down. Diagonal movement
// costs 1 tile — not the 5e 1-2-1 rule. 1 tile = 5 ft, so a 30-ft speed is 6
// tiles. Everything here is plain JSON data.

export interface Vec2 {
  x: number
  y: number
}

/** Tile codes (numbers, so maps serialize as plain JSON). */
export const Tile = {
  Floor: 0,
  Wall: 1,
  Spawn: 2,
  Waypoint: 3,
} as const
export type Tile = (typeof Tile)[keyof typeof Tile]

export interface GameMap {
  id: string
  width: number
  height: number
  /** Row-major grid: tiles[y][x]. */
  tiles: Tile[][]
  spawn: Vec2
  waypoint: Vec2
  /** Theme of a generated level (picks its boss); absent = crypt. */
  biome?: string
}
