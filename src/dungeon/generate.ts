import { Tile, type GameMap, type Vec2 } from '../game/types'
import { BIOMES, BIOME_NAMES } from '../game/biomes'
import { bossForBiome } from '../combat/monsters'
import { makeRng } from '../rng'
import type { EnemySpawn, Level } from './levels'

// ---------------------------------------------------------------------------
// Procedural dungeon generator. A run is a chain of rooms-and-corridors levels,
// each derived from a single run seed so the whole dungeon is reproducible, and
// any single level can be regenerated on its own from (seed, index).
//
// Algorithm, per level:
//   1. Fill the grid with Wall.
//   2. Scatter non-overlapping rectangular rooms (more + larger as depth grows).
//   3. Carve each room to Floor, then connect consecutive room centres with
//      L-shaped corridors so every room is reachable. A couple of extra links
//      add loops so the layout is not a single line.
//   4. Spawn = first room's centre; exit waypoint = the farthest room's centre.
//   5. Place enemies (in rooms past the first), traps (on the travelled floor),
//      cover pillars and healing shrines.
// Everything is driven by a seeded RNG so a given seed always yields the same
// dungeon — essential for server-side re-scoring and for unit tests.
// ---------------------------------------------------------------------------

// Base (floor-1) map. Deeper floors grow from here — see mapDimsForDepth — so a
// level-25 dungeon is ~10× the AREA of level 1.
const BASE_W = 40
const BASE_H = 28
/** Default number of levels in a run. */
export const RUN_LENGTH = 5

/**
 * Map dimensions for a given dungeon depth (0-based level index). The AREA grows
 * linearly from ×1 at floor 1 to ×10 at floor 25 (then caps), so each side
 * scales by √(areaScale). `t` is the 0..1 depth fraction (re-used to enlarge
 * rooms deeper); `dim` is the per-side multiplier.
 */
function mapDimsForDepth(levelIndex: number): { w: number; h: number; t: number; dim: number } {
  const t = Math.max(0, Math.min(1, levelIndex / 24))
  const dim = Math.sqrt(1 + 9 * t)
  return { w: Math.round(BASE_W * dim), h: Math.round(BASE_H * dim), t, dim }
}

interface Room {
  x: number
  y: number
  w: number
  h: number
}

function roomCenter(r: Room): Vec2 {
  return { x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) }
}

/** Rooms overlap if their 1-tile-padded bounds intersect (keeps walls between). */
function roomsOverlap(a: Room, b: Room): boolean {
  return a.x - 1 < b.x + b.w && a.x + a.w + 1 > b.x && a.y - 1 < b.y + b.h && a.y + a.h + 1 > b.y
}

function carveRoom(tiles: Tile[][], r: Room): void {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) tiles[y][x] = Tile.Floor
  }
}

function carveH(tiles: Tile[][], x1: number, x2: number, y: number): void {
  for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
    if (tiles[y][x] === Tile.Wall) tiles[y][x] = Tile.Floor
  }
}

function carveV(tiles: Tile[][], y1: number, y2: number, x: number): void {
  for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
    if (tiles[y][x] === Tile.Wall) tiles[y][x] = Tile.Floor
  }
}

/** L-shaped corridor between two points, with a random elbow orientation. */
function carveCorridor(tiles: Tile[][], a: Vec2, b: Vec2, horizontalFirst: boolean): void {
  if (horizontalFirst) {
    carveH(tiles, a.x, b.x, a.y)
    carveV(tiles, a.y, b.y, b.x)
  } else {
    carveV(tiles, a.y, b.y, a.x)
    carveH(tiles, a.x, b.x, b.y)
  }
}

/** Orthogonal BFS over non-wall tiles — is `b` reachable from `a`? Used to
 *  verify cover pillars never seal the route from the spawn to the exit. */
function pathExists(tiles: Tile[][], a: Vec2, b: Vec2): boolean {
  const H = tiles.length
  const W = tiles[0].length
  const seen = new Uint8Array(W * H)
  const q: Vec2[] = [a]
  seen[a.x + a.y * W] = 1
  let head = 0
  while (head < q.length) {
    const p = q[head++]
    if (p.x === b.x && p.y === b.y) return true
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = p.x + dx
      const ny = p.y + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const i = nx + ny * W
      if (seen[i] || tiles[ny][nx] === Tile.Wall) continue
      seen[i] = 1
      q.push({ x: nx, y: ny })
    }
  }
  return false
}

// Depth-appropriate monster pools (keys must exist in combat/monsters). Deeper
// tiers swap in TOUGHER monster TYPES; on top of that, every monster's stats are
// scaled up with depth (buildEnemyBattler), so difficulty keeps climbing past
// the last tier even though the roster caps out.
const MONSTER_POOLS: string[][] = [
  ['goblin', 'kobold', 'bandit'],
  ['goblin', 'skeleton', 'bandit', 'dire-wolf', 'giant-spider'],
  ['skeleton', 'orc', 'cultist', 'dire-wolf', 'giant-spider', 'hobgoblin'],
  ['skeleton', 'orc', 'zombie', 'cultist', 'acolyte', 'giant-spider', 'gnoll'],
  ['orc', 'zombie', 'ogre', 'cultist', 'acolyte', 'hobgoblin', 'gnoll'],
  ['ogre', 'bugbear', 'gnoll', 'wight', 'cultist', 'dire-wolf'],
  ['ogre', 'bugbear', 'wight', 'troll', 'acolyte'],
  ['wight', 'troll', 'wraith', 'hill-giant', 'ogre'],
  ['troll', 'wraith', 'hill-giant'],
]

export interface GenerateOptions {
  /** Multiplies the enemy count (party size). Defaults to 1. */
  enemyScale?: number
}

export function generateLevel(seed: number, id: string, name: string, levelIndex: number, isLast: boolean, biome: string, opts?: GenerateOptions): Level {
  const rand = makeRng(seed)
  const ri = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1))

  // Map grows with depth (≈10× area by floor 25). MAP_W/MAP_H are LOCAL to this
  // level so the rest of the body keeps using them unchanged. EXCEPTION: a boss
  // level (isLast) uses the TIGHT base-size arena (40×28) regardless of depth —
  // a contained showdown, not a sprawling 10× map you can lose the boss in. Only
  // the NON-boss levels keep the depth-scaled growth.
  const dims = isLast ? mapDimsForDepth(0) : mapDimsForDepth(levelIndex)
  const MAP_W = dims.w
  const MAP_H = dims.h
  const depthT = dims.t

  const tiles: Tile[][] = Array.from({ length: MAP_H }, () => Array<Tile>(MAP_W).fill(Tile.Wall))

  // 1-2. Scatter rooms — more (∝ side length) and larger the deeper you go, so a
  // big floor stays filled with space to fight in (bigger rooms also let foes
  // cluster, which makes AoE spells pay off).
  const targetRooms = Math.round((9 + Math.min(levelIndex, 6)) * dims.dim)
  const rooms: Room[] = []
  let attempts = 0
  const maxAttempts = Math.max(400, targetRooms * 40)
  while (rooms.length < targetRooms && attempts < maxAttempts) {
    attempts++
    const w = ri(4, 6 + Math.floor(depthT * 5))
    const h = ri(3, 5 + Math.floor(depthT * 4))
    const x = ri(1, MAP_W - w - 1)
    const y = ri(1, MAP_H - h - 1)
    const room: Room = { x, y, w, h }
    if (rooms.some((other) => roomsOverlap(room, other))) continue
    rooms.push(room)
  }

  // 3. Carve rooms and connect consecutive centres; add a couple of extra links.
  for (const r of rooms) carveRoom(tiles, r)
  for (let i = 1; i < rooms.length; i++) {
    carveCorridor(tiles, roomCenter(rooms[i - 1]), roomCenter(rooms[i]), rand() < 0.5)
  }
  const extraLinks = Math.min(2 + Math.floor(rooms.length / 10), Math.max(0, rooms.length - 2))
  for (let i = 0; i < extraLinks; i++) {
    const a = rooms[ri(0, rooms.length - 1)]
    const b = rooms[ri(0, rooms.length - 1)]
    if (a !== b) carveCorridor(tiles, roomCenter(a), roomCenter(b), rand() < 0.5)
  }

  // 4. Spawn in the first room; exit in the room farthest from it.
  const spawn = roomCenter(rooms[0])
  let exitRoom = rooms[rooms.length - 1]
  let bestDist = -1
  for (let i = 1; i < rooms.length; i++) {
    const c = roomCenter(rooms[i])
    const d = Math.abs(c.x - spawn.x) + Math.abs(c.y - spawn.y)
    if (d > bestDist) {
      bestDist = d
      exitRoom = rooms[i]
    }
  }
  const waypoint = roomCenter(exitRoom)
  tiles[spawn.y][spawn.x] = Tile.Spawn
  tiles[waypoint.y][waypoint.x] = Tile.Waypoint

  // Free floor tiles available for placement, excluding spawn/exit + any taken.
  const taken = new Set<string>([`${spawn.x},${spawn.y}`, `${waypoint.x},${waypoint.y}`])
  const farFromSpawn = (p: Vec2) => Math.abs(p.x - spawn.x) + Math.abs(p.y - spawn.y) >= 4
  const pickFloor = (candidates: Vec2[]): Vec2 | null => {
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
    }
    for (const p of candidates) {
      const k = `${p.x},${p.y}`
      if (!taken.has(k)) {
        taken.add(k)
        return p
      }
    }
    return null
  }

  const roomFloors = (r: Room, far: boolean): Vec2[] => {
    const out: Vec2[] = []
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const p = { x, y }
        if (tiles[y][x] === Tile.Floor && (!far || farFromSpawn(p))) out.push(p)
      }
    }
    return out
  }

  // 5·cover. Scatter single-tile pillars inside the larger rooms so a ranged
  // caster has something to break line of sight against and duck behind — the
  // terrain that makes kiting actually work (solo 5e casters live and die by
  // cover; an open box gives them nowhere to use their range). Never on the
  // spawn/exit, a room centre (corridors land there) or a room edge, and never
  // two adjacent (no accidental 2-wide walls). We re-check spawn→exit
  // connectivity and revert every pillar on the rare chance one seals the route.
  const pillarBlocked = new Set<string>([`${spawn.x},${spawn.y}`, `${waypoint.x},${waypoint.y}`])
  for (const r of rooms) {
    const c = roomCenter(r)
    pillarBlocked.add(`${c.x},${c.y}`)
  }
  const pillars: Vec2[] = []
  for (const r of rooms) {
    if (r.w < 5 || r.h < 4) continue
    const want = r.w >= 6 && r.h >= 5 ? 2 : 1
    let placed = 0
    let pt = 0
    while (placed < want && pt++ < 24) {
      const px = ri(r.x + 1, r.x + r.w - 2)
      const py = ri(r.y + 1, r.y + r.h - 2)
      const k = `${px},${py}`
      if (pillarBlocked.has(k) || tiles[py][px] !== Tile.Floor) continue
      if (pillars.some((p) => Math.abs(p.x - px) <= 1 && Math.abs(p.y - py) <= 1)) continue
      pillars.push({ x: px, y: py })
      pillarBlocked.add(k)
      placed++
    }
  }
  for (const p of pillars) tiles[p.y][p.x] = Tile.Wall
  if (!pathExists(tiles, spawn, waypoint)) {
    for (const p of pillars) tiles[p.y][p.x] = Tile.Floor
  }

  // 5a. Enemies — drawn from the depth pool, scattered through the rooms past
  // the first. The final level fields fewer minions but adds a boss.
  const pool = MONSTER_POOLS[Math.min(levelIndex, MONSTER_POOLS.length - 1)]
  // Balance v2: the non-last enemy count now scales with the ROOM count (rooms
  // already grow with the map), aiming for roughly ONE foe per ~3-4 rooms — so a
  // big deep map feels populated WITHOUT becoming a horde, and the foes stay
  // SPREAD (the ENEMY_GAP spacing below keeps them apart, not dogpiled on one
  // cluster). Floor 1 (~9 rooms) lands ~2-3; depth-25 (~47 rooms) lands ~12-14,
  // capped at 18. The last level keeps a small fixed minion count alongside its
  // biome boss. Party play multiplies the body count by the group size (×1 solo
  // = unchanged, so the generator unit tests stay intact).
  const scale = Math.max(1, Math.round(opts?.enemyScale ?? 1))
  const minions = isLast ? 2 : Math.min(18, Math.max(2, Math.round(rooms.length * 0.28)))
  const enemyCount = minions * scale
  const enemies: EnemySpawn[] = []
  const enemyRooms = rooms.slice(1)
  // Distance + spread: gather the far-from-spawn floor across the enemy rooms,
  // bias to the DEEPER half of the level (so you meet foes after a corridor — a
  // natural chokepoint — and a ranged caster gets a free shot or two while
  // closing), then place them SPACED OUT so a solo caster is never dogpiled by
  // the whole pack landing on one tile-cluster.
  const enemyCandidates: Vec2[] = []
  for (const r of enemyRooms) enemyCandidates.push(...roomFloors(r, true))
  enemyCandidates.sort(
    (a, b) =>
      Math.abs(b.x - spawn.x) + Math.abs(b.y - spawn.y) - (Math.abs(a.x - spawn.x) + Math.abs(a.y - spawn.y)),
  )
  const farCut = Math.max(enemyCount * 4, Math.floor(enemyCandidates.length * 0.6))
  const farPool = enemyCandidates.slice(0, Math.max(farCut, enemyCount))
  for (let i = farPool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[farPool[i], farPool[j]] = [farPool[j], farPool[i]]
  }
  const ENEMY_GAP = 3
  const placeEnemies = (cands: Vec2[], requireGap: boolean): void => {
    for (const p of cands) {
      if (enemies.length >= enemyCount) break
      const k = `${p.x},${p.y}`
      if (taken.has(k)) continue
      if (requireGap && enemies.some((e) => Math.max(Math.abs(e.pos.x - p.x), Math.abs(e.pos.y - p.y)) < ENEMY_GAP)) continue
      taken.add(k)
      enemies.push({ key: pool[ri(0, pool.length - 1)], pos: p })
    }
  }
  placeEnemies(farPool, true) // deep + spaced first
  placeEnemies(enemyCandidates, true) // then anywhere far, still spaced
  placeEnemies(enemyCandidates, false) // finally fill the count without the gap rule
  // The deepest level is guarded by a boss, planted in the exit room.
  if (isLast) {
    const spot = pickFloor(roomFloors(exitRoom, false))
    if (spot) enemies.unshift({ key: bossForBiome(biome), pos: spot })
  }

  // 5b. Traps — on the travelled floor, away from the spawn.
  const trapCount = 1 + Math.min(levelIndex, 2)
  const allFar: Vec2[] = []
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const p = { x, y }
      if (tiles[y][x] === Tile.Floor && farFromSpawn(p)) allFar.push(p)
    }
  }
  const traps: Vec2[] = []
  for (let i = 0; i < trapCount; i++) {
    const spot = pickFloor(allFar)
    if (spot) traps.push(spot)
  }

  // 5c. Healing shrines — step on one to mend (once each, saved). None on the
  // first floor (you start fresh); one from level 2 (index 1) on; and TWO on the
  // deeper levels (index ≥ 2) so slot- and HP-hungry casters have somewhere to
  // recover between fights instead of bleeding out the whole run.
  const shrines: Vec2[] = []
  if (levelIndex >= 1) {
    const shrineCount = levelIndex >= 2 ? 2 : 1
    let sg = 0
    while (shrines.length < shrineCount && sg++ < shrineCount * 8) {
      const shrineRoom = enemyRooms[ri(0, enemyRooms.length - 1)] ?? rooms[rooms.length - 1]
      const spot = pickFloor(roomFloors(shrineRoom, true))
      if (spot) shrines.push(spot)
    }
  }

  const map: GameMap = { id, width: MAP_W, height: MAP_H, tiles, spawn, waypoint, biome }
  return { id, name, map, enemies, traps, shrines }
}

/** Generate a full run of `count` levels from a single seed. Each level gets a
 * biome (cycling crypt → cave → sewer → warren → vault) that themes its name
 * and tile palette. */
export function generateRun(seed: number, count: number = RUN_LENGTH, opts?: GenerateOptions): Level[] {
  const levels: Level[] = []
  for (let i = 0; i < count; i++) levels.push(generateLevelForRun(seed, i, i === count - 1, opts))
  return levels
}

/**
 * Generate ONE run level by its index (the seed is decorrelated per level so the
 * whole run is reproducible from a single run seed; the biome cycles). `isLast`
 * plants the boss. The run loop calls this lazily, one level at a time.
 */
export function generateLevelForRun(seed: number, index: number, isLast: boolean, opts?: GenerateOptions): Level {
  const levelSeed = (seed + index * 0x9e3779b1) >>> 0
  const biome = BIOMES[index % BIOMES.length]
  const name = BIOME_NAMES[biome]
  return generateLevel(levelSeed, `gen-${index + 1}`, name, index, isLast, biome, opts)
}

