import { Tile, type GameMap, type Vec2 } from './types'

// ---------------------------------------------------------------------------
// Tile-map helpers + one tiny hand-authored map used as a test fixture.
// Maps are authored as text for readability, then parsed into a Tile grid.
//   #  wall      .  floor      S  spawn      X  exit waypoint
// ---------------------------------------------------------------------------

const TEMPLATE: readonly string[] = [
  '############',
  '#S...#....X#',
  '#....#.....#',
  '#....#.###.#',
  '#..........#',
  '#.###.#....#',
  '#.....#....#',
  '#..........#',
  '############',
]

const CHAR_TO_TILE: Record<string, Tile> = {
  '#': Tile.Wall,
  '.': Tile.Floor,
  S: Tile.Spawn,
  X: Tile.Waypoint,
}

export function parseMap(template: readonly string[], id: string): GameMap {
  const height = template.length
  const width = Math.max(...template.map((row) => row.length))
  const tiles: Tile[][] = []
  let spawn: Vec2 | null = null
  let waypoint: Vec2 | null = null

  for (let y = 0; y < height; y++) {
    const row: Tile[] = []
    for (let x = 0; x < width; x++) {
      const ch = template[y][x] ?? '#'
      const tile = CHAR_TO_TILE[ch]
      if (tile === undefined) throw new Error(`Unknown map char "${ch}" at ${x},${y}`)
      if (tile === Tile.Spawn) spawn = { x, y }
      if (tile === Tile.Waypoint) waypoint = { x, y }
      row.push(tile)
    }
    tiles.push(row)
  }

  if (!spawn) throw new Error(`Map "${id}" has no spawn (S)`)
  if (!waypoint) throw new Error(`Map "${id}" has no waypoint (X)`)

  return { id, width, height, tiles, spawn, waypoint }
}

export const testMap: GameMap = parseMap(TEMPLATE, 'test-arena')

export function inBounds(map: GameMap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height
}

export function tileAt(map: GameMap, x: number, y: number): Tile | undefined {
  if (!inBounds(map, x, y)) return undefined
  return map.tiles[y][x]
}

/** Spawn and waypoint sit on walkable ground; only walls block. */
export function isWalkable(map: GameMap, x: number, y: number): boolean {
  const tile = tileAt(map, x, y)
  return tile !== undefined && tile !== Tile.Wall
}
