import type { GameMap, Vec2 } from '../game/types'

// ---------------------------------------------------------------------------
// A dungeon level as produced by the generator: a tile map with a spawn and an
// exit waypoint, the enemy spawns, hidden traps and healing shrines.
// Plain JSON data.
// ---------------------------------------------------------------------------

export interface EnemySpawn {
  /** Monster key (see combat/monsters). */
  key: string
  pos: Vec2
  /** Encounter group: spawns sharing it are met (and fought) together. */
  group: number
}

export interface Level {
  id: string
  name: string
  map: GameMap
  enemies: EnemySpawn[]
  traps: Vec2[]
  /** Healing shrines on this level; step on one to mend, once. */
  shrines: Vec2[]
}
