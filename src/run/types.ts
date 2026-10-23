import type { GameMap, Vec2 } from '../game/types'
import type { Battler, CombatAttack } from '../combat/types'
import type { Level } from '../dungeon/levels'
import type { CharacterSpec, ClassKey } from '../character/build'
import type { RngState } from '../rng'
import type { Genes, Genome } from '../bot/genome'
import type { UsageTally } from '../bot/usage'

// ---------------------------------------------------------------------------
// Run state types and tuning constants (see bot/run for the state machine).
// Plain JSON data only: a RunState round-trips through JSON at any step.
// ---------------------------------------------------------------------------

export const RUN_STATE_SCHEMA = 'dungeon-gym/run'

export const RUN_STATE_VERSION = 1

export const ENGAGE_RADIUS = 4

export const TRAP_DAMAGE = { count: 2, sides: 4, bonus: 0 }

export const SHRINE_FRAC = 0.4

/** Mid-level short rests allowed per dungeon level (see shortRestAfterFight). */
export const SHORT_RESTS_PER_LEVEL = 1

/** A long rest before every Nth floor (floors 4, 7, 10, …): about one 5e
 *  adventuring day of 6–8 encounters per long rest. */
export const LONG_REST_EVERY = 3

/** Step budget per dungeon level (the cap is depth × this); hitting it is a loss. */
export const STEPS_PER_LEVEL = 8000

/** Deepest allowed run. */
export const MAX_DEPTH = 50

/** A fight dragging past this many rounds is resolved by who's still standing. */
export const COMBAT_ROUND_CAP = 60

/** Exploration: how far the party sees while sweeping a level. */
export const VISION_RADIUS = 6

/** Potions of Healing each character starts a run with. */
export const STARTING_POTIONS = 2

/** Found-gear weapon numbers assume a +3 proficiency (level 5); higher levels add the difference. */
export const GEAR_BASE_PROF = 3

/** The held cast-wand a bot fires as a bonus action while it has charges. */
export const BOT_WAND: CombatAttack = { name: 'Wand', toHit: 6, damage: { count: 2, sides: 6, bonus: 0 }, damageType: 'fire', range: 24, source: 'spell' }

export type RunPhase = 'explore' | 'combat' | 'done'

/** won = cleared the last level · wiped = party dead · step-cap = budget spent · stuck = no path. */
export type EndReason = 'won' | 'wiped' | 'step-cap' | 'stuck'

/** stalled = the run ended by step cap / no path while the member was still up. */
export type DeathCause = 'combat' | 'trap' | 'stalled'

export interface PartyMemberInit {
  genome: Genome
  /** The character; defaults to the class's starting character. */
  spec?: CharacterSpec
  name?: string
}

export interface RunConfig {
  seed: number
  /** Number of dungeon levels (default 5). */
  depth?: number
  party: PartyMemberInit[]
}

export interface Spawn {
  id: number
  key: string
  pos: Vec2
  /** Encounter group (from the generator): a group is fought together. */
  group: number
}

/** Equipment slots for found gear (a ring fits either ring slot). */
export type GearSlot = 'mainHand' | 'offHand' | 'armor' | 'helmet' | 'legs' | 'boots' | 'ring1' | 'ring2' | 'amulet'

export interface MemberState {
  memberId: number
  name: string
  classKey: ClassKey
  genomeHash: string
  genes: Genes
  /** The character; its classLevels grow with level-ups. */
  spec: CharacterSpec
  startLevel: number
  /** Found gear by slot (keys of items/gear). One item per slot — no stacking. */
  equipped: Partial<Record<GearSlot, string>>
  battler: Battler
  usage: UsageTally
  /** Artifact keys picked so far (their bonuses stack — each is unique). */
  owned: string[]
  xp: number
  /** Hit Dice left to spend on short rests (one per character level at most). */
  hitDice: number
  /** Circle of the Land's Natural Recovery already used since the last long rest. */
  naturalRecoveryUsed?: boolean
  depthReached: number
  alive: boolean
  deathLevel?: number
  deathCause?: DeathCause
  damage: number
  healing: number
  kills: number
  stats: MemberStats
}

/** Per-member telemetry (balance analysis); plain JSON. */
export interface MemberStats {
  /** Turns the bot acted (not surprised, not downed). */
  turns: number
  /** Acting turns whose action was no attack, heal or retreat (it only moved or waited). */
  idleTurns: number
  /** Acting turns spent retreating. */
  retreatTurns: number
  fights: number
  /** Enemies met, summed over fights. */
  foesFaced: number
  /** Most enemies in a single fight. */
  maxFoes: number
  /** Turns lost to a surprise round. */
  surprisedTurns: number
  slotsSpent: number
  potionsUsed: number
  damageTaken: number
  /** Monster key that last damaged the member. */
  lastHitBy?: string
  /** Monster key (or 'trap') whose damage killed the member. */
  killedBy?: string
}

export interface CombatState {
  /** Members that started this fight (dead ones stay listed). */
  memberIds: number[]
  /** Creatures fighting on the party's side that are not members (conjured
   *  beasts); they leave when the fight ends. */
  allies: Battler[]
  /** Counter for unique ally ids within the fight. */
  nextAllyId: number
  enemies: Battler[]
  /** Battler ids in initiative order. */
  order: string[]
  turn: number
  round: number
  /** Explore-triggered fights surprise the party: it loses round 1. */
  surprised: boolean
  /** Spawn ids taking part in this fight. */
  engaged: number[]
}

export interface RunState {
  schema: typeof RUN_STATE_SCHEMA
  version: typeof RUN_STATE_VERSION
  seed: number
  depth: number
  enemyScale: number
  /** Dice / loot / initiative stream. */
  rng: RngState
  /** The bots' own policy coin-flips (see bot/policy). */
  policyRng: RngState
  levelIndex: number
  /** The current level (null between levels). */
  level: Level | null
  phase: RunPhase
  endReason: EndReason | null
  won: boolean
  steps: number
  maxSteps: number
  /** The party's lead position during exploration. */
  pos: Vec2
  remaining: Spawn[]
  nextSpawnId: number
  traps: { pos: Vec2; armed: boolean }[]
  shrines: { pos: Vec2; used: boolean }[]
  /** Per-tile flags (index x + y·width) for the current level. */
  seen: number[]
  reachable: number[]
  reachableFloor: number
  seenCount: number
  exploreSteps: number
  exploreBudget: number
  combat: CombatState | null
  /** Scrolls of Resurrection held (auto-used to revive the fallen). */
  scrolls: number
  /** Long-rest kits held (a short rest becomes a long one). */
  longRestKits: number
  /** Charges on a found cast-wand. */
  castCharges: number
  /** Short rests already taken on the current level. */
  shortRestsThisLevel: number
  members: MemberState[]
}

/** One party member's outcome. */
export interface MemberResult {
  memberId: number
  name: string
  classKey: ClassKey
  genomeHash: string
  classLevels: Record<string, number>
  depthReached: number
  charLevel: number
  won: boolean
  alive: boolean
  deathLevel?: number
  deathCause?: DeathCause
  usage: UsageTally
  damage: number
  healing: number
  kills: number
  stats: MemberStats
}

export interface RunResult {
  seed: number
  depth: number
  won: boolean
  endReason: EndReason | null
  depthReached: number
  partySize: number
  steps: number
  members: MemberResult[]
}

export interface RunSnapshot {
  level: number
  /** Conjured beasts fighting for the party (combat only). */
  allies: { pos: Vec2; glyph: string; hp: number; maxHp: number }[]
  charLevel: number
  partySize: number
  phase: RunPhase
  alive: boolean
  won: boolean
  map: GameMap | null
  players: { pos: Vec2; classKey: string; name: string; hp: number; maxHp: number; alive: boolean }[]
  enemies: { pos: Vec2; glyph: string; hp: number; maxHp: number }[]
}
