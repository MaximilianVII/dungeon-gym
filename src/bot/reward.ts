import { roleOf, type Genes } from './genome'
import type { UsageTally } from './usage'
import { deepFreeze } from '../freeze'

// ---------------------------------------------------------------------------
// REWARD (fitness) — how a finished member-run is scored. A trainer fixes one
// RewardConfig for its whole lifetime (see train/trainer), so fitness values
// from different weightings are never mixed.
//
// BENCHMARK_REWARD is the one used for official scores (uploads, hall of
// fame): outcome-only — depth, winning, survival, character level — so a
// genome cannot farm points from damage dealt or HP healed.
// ---------------------------------------------------------------------------

export interface RewardConfig {
  /** Per dungeon level reached. */
  depth: number
  /** Flat bonus on a won run. */
  win: number
  /** Bonus for ending the run alive. */
  survive: number
  /** Penalty (subtracted) for dying. */
  die: number
  /** Per character level. */
  charLevel: number
  /** Per point of effective damage dealt. */
  damage: number
  /** Per HP healed (self + allies). */
  healing: number
  /** Per distinct EXTRA party role (party-composition bonus). */
  diversity: number
  /** +reward per use of a named action (keys match the usage-tally labels). */
  abilityRewards: Record<string, number>
}

/** The legacy defaults (local training). */
export const DEFAULT_REWARD: RewardConfig = deepFreeze({
  depth: 12,
  win: 40,
  survive: 15,
  die: 30,
  charLevel: 1,
  damage: 0.6,
  healing: 0.4,
  diversity: 15,
  abilityRewards: {},
})

/** Outcome-only reward used for official benchmark scores. */
export const BENCHMARK_REWARD: RewardConfig = deepFreeze({
  depth: 12,
  win: 40,
  survive: 15,
  die: 30,
  charLevel: 1,
  damage: 0,
  healing: 0,
  diversity: 0,
  abilityRewards: {},
})

/** One-click weight sets. */
export const REWARD_PRESETS: Record<string, RewardConfig> = deepFreeze({
  balanced: { ...DEFAULT_REWARD },
  damage: { ...DEFAULT_REWARD, damage: 1.4, win: 30, survive: 8, depth: 8 },
  survival: { ...DEFAULT_REWARD, survive: 30, die: 60, damage: 0.3, depth: 14 },
  depth: { ...DEFAULT_REWARD, depth: 26, win: 60, damage: 0.4, survive: 10 },
  benchmark: { ...BENCHMARK_REWARD },
})

function num(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0
}

/** Clamp every field to a sane range; drop zero/invalid ability rewards. */
export function clampReward(c: Partial<RewardConfig>): RewardConfig {
  // An explicit `undefined` means "not set", same as a missing key.
  const given = Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) as Partial<RewardConfig>
  const base = { ...DEFAULT_REWARD, ...given }
  const abilityRewards: Record<string, number> = {}
  for (const [k, v] of Object.entries(base.abilityRewards ?? {})) {
    if (Number.isFinite(v) && v !== 0) abilityRewards[k] = num(v, -50, 200)
  }
  return {
    depth: num(base.depth, 0, 100),
    win: num(base.win, 0, 500),
    survive: num(base.survive, 0, 200),
    die: num(base.die, 0, 200),
    charLevel: num(base.charLevel, 0, 50),
    damage: num(base.damage, 0, 10),
    healing: num(base.healing, 0, 10),
    diversity: num(base.diversity, 0, 100),
    abilityRewards,
  }
}

/** What fitness reads from a finished member-run. */
export interface FitnessInput {
  depthReached: number
  alive: boolean
  won: boolean
  charLevel: number
  damage: number
  healing: number
  usage: UsageTally
}

/** Base fitness + per-ability bonuses for one member-run (no party bonus). */
export function memberFitness(r: FitnessInput, c: RewardConfig): number {
  let ability = 0
  for (const [name, count] of Object.entries(r.usage)) ability += (c.abilityRewards[name] ?? 0) * count
  return (
    r.depthReached * c.depth +
    (r.won ? c.win : 0) +
    (r.alive ? c.survive : -c.die) +
    r.charLevel * c.charLevel +
    r.healing * c.healing +
    r.damage * c.damage +
    ability
  )
}

/** Party-composition bonus: `diversity` per distinct role beyond the first,
 *  computed from the genes that actually PLAYED (not a live population). */
export function diversityBonus(played: readonly Genes[], c: RewardConfig): number {
  const roles = new Set(played.map(roleOf))
  return Math.max(0, roles.size - 1) * c.diversity
}
