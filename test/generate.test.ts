import { describe, it, expect } from 'vitest'
import { generateRun, generateLevel } from '../src/dungeon/generate'
import { Tile, type GameMap, type Vec2 } from '../src/game/types'

function countTile(map: GameMap, t: Tile): number {
  let n = 0
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if (map.tiles[y][x] === t) n++
  return n
}
function walkable(map: GameMap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height && map.tiles[y][x] !== Tile.Wall
}
// BFS over non-wall tiles: is `to` reachable from `from`?
function reachable(map: GameMap, from: Vec2, to: Vec2): boolean {
  const seen = new Set<string>([`${from.x},${from.y}`])
  const q: Vec2[] = [from]
  while (q.length) {
    const p = q.shift()!
    if (p.x === to.x && p.y === to.y) return true
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = p.x + dx, ny = p.y + dy, k = `${nx},${ny}`
      if (!seen.has(k) && walkable(map, nx, ny)) { seen.add(k); q.push({ x: nx, y: ny }) }
    }
  }
  return false
}

describe('procedural dungeon generator', () => {
  it('produces a run of the requested length; floor 1 is base size, deep NON-boss floors grow, the boss level is a tight base-size arena', () => {
    const run = generateRun(12345, 25)
    expect(run.length).toBe(25)
    // Floor 1 is the base map.
    expect(run[0].map.width).toBe(40)
    expect(run[0].map.height).toBe(28)
    // A DEEP NON-LAST floor (index 23) grows to ≈10× the base AREA. We compare
    // against this instead of the final floor because the LAST level is now a
    // boss arena pinned back to base size (see below).
    expect(run[23].map.width).toBeGreaterThan(run[0].map.width)
    expect(run[23].map.height).toBeGreaterThan(run[0].map.height)
    const baseArea = run[0].map.width * run[0].map.height
    const deepArea = run[23].map.width * run[23].map.height
    expect(deepArea).toBeGreaterThan(baseArea * 8)
    // The boss level (the last one) uses a TIGHT base-size arena regardless of
    // how deep the run is — a contained showdown, not a 10× sprawl.
    expect(run[24].map.width).toBe(40)
    expect(run[24].map.height).toBe(28)
  })

  it('every level has exactly one spawn and one exit, both walkable and distinct', () => {
    for (const lvl of generateRun(777, 5)) {
      expect(countTile(lvl.map, Tile.Spawn)).toBe(1)
      expect(countTile(lvl.map, Tile.Waypoint)).toBe(1)
      expect(lvl.map.spawn).not.toEqual(lvl.map.waypoint)
      expect(walkable(lvl.map, lvl.map.spawn.x, lvl.map.spawn.y)).toBe(true)
      expect(walkable(lvl.map, lvl.map.waypoint.x, lvl.map.waypoint.y)).toBe(true)
    }
  })

  it('the exit is always reachable from the spawn (connectivity)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const lvl of generateRun((seed * 2654435761) >>> 0, 5)) {
        expect(reachable(lvl.map, lvl.map.spawn, lvl.map.waypoint)).toBe(true)
      }
    }
  })

  it('enemies and traps sit on walkable floor, never on the spawn or exit', () => {
    for (const lvl of generateRun(99, 5)) {
      const sp = `${lvl.map.spawn.x},${lvl.map.spawn.y}`
      const wp = `${lvl.map.waypoint.x},${lvl.map.waypoint.y}`
      for (const e of lvl.enemies) {
        expect(walkable(lvl.map, e.pos.x, e.pos.y)).toBe(true)
        expect(`${e.pos.x},${e.pos.y}`).not.toBe(sp)
        expect(`${e.pos.x},${e.pos.y}`).not.toBe(wp)
      }
      for (const tr of lvl.traps) expect(walkable(lvl.map, tr.x, tr.y)).toBe(true)
    }
  })

  it('enemy count scales with map size (room count); the last level is guarded by a boss', () => {
    const run = generateRun(2024, 5)
    // Balance v2: the non-last count scales with the room count (~one foe per
    // ~3-4 rooms). Floor 1 (~9 rooms) lands a light 3.
    expect(run[0].enemies.length).toBe(3)
    expect(run[0].traps.length).toBe(1)
    expect(run[4].traps.length).toBe(3)
    // The final level fields a small fixed minion count + a boss (the orc-warlord).
    expect(run[4].enemies.length).toBe(3)
    expect(run[4].enemies.some((e) => e.key === 'orc-warlord')).toBe(true)
    // No earlier level carries the boss.
    for (let i = 0; i < 4; i++) expect(run[i].enemies.some((e) => e.key === 'orc-warlord')).toBe(false)
    // A deep non-last floor has many more rooms, so it is far more populated than
    // floor 1 — but the count is capped at 18 and the foes stay spread (ENEMY_GAP).
    const deep = generateRun(2024, 25)
    expect(deep[20].enemies.length).toBeGreaterThan(run[0].enemies.length)
    expect(deep[20].enemies.length).toBeGreaterThanOrEqual(8)
    expect(deep[20].enemies.length).toBeLessThanOrEqual(18)
  })

  it('themes each level with a biome and seeds shrines past the first level', () => {
    const run = generateRun(909, 5)
    const biomes = ['crypt', 'cave', 'sewer', 'warren', 'vault']
    run.forEach((lvl, i) => expect(lvl.map.biome).toBe(biomes[i]))
    expect(run[0].shrines).toEqual([]) // no shrine on the first level
    // One shrine from level 2 (index 1) on; two on the deeper levels (index ≥ 2)
    // so casters have somewhere to recover.
    expect(run[1].shrines.length).toBeLessThanOrEqual(1)
    for (let i = 2; i < 5; i++) expect(run[i].shrines.length).toBeLessThanOrEqual(2)
  })

  it('is deterministic: the same seed yields an identical run', () => {
    expect(generateRun(42, 4)).toEqual(generateRun(42, 4))
    expect(generateLevel(123, 'x', 'X', 2, false, 'crypt')).toEqual(generateLevel(123, 'x', 'X', 2, false, 'crypt'))
  })

  it('different seeds yield different layouts', () => {
    const a = generateRun(1, 3)
    const b = generateRun(2, 3)
    expect(JSON.stringify(a.map((l) => l.map.tiles))).not.toBe(JSON.stringify(b.map((l) => l.map.tiles)))
  })
})
