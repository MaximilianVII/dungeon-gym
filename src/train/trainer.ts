import { isClassKey, type ClassKey } from '../character/build'
import { baselineGenome, crossoverGenomes, genomeHash, mutateGenome, validateGenome, type Genome } from '../bot/genome'
import { clampReward, DEFAULT_REWARD, type RewardConfig } from '../bot/reward'
import { rngOf, seedRng, type Rng, type RngState } from '../rng'
import { evaluateGenome, mean } from './evaluate'

// ---------------------------------------------------------------------------
// Generational trainer for one class's genome — a (μ+λ)-style GA with uniform
// crossover, built so its results mean something:
//
//   • Common random numbers: every individual of a generation is scored on the
//     SAME dungeon seeds, so comparisons are paired, not luck-of-the-draw.
//   • Elites are re-evaluated on fresh seeds every generation — no stale,
//     optimistically-selected means survive.
//   • Fixed config: reward, depth and seed counts are frozen at creation, so
//     fitness from different weightings is never mixed.
//   • Every task carries (generation, individualId); late or unknown
//     submissions are REJECTED with a reason, never credited to someone else.
//   • Fully deterministic: the trainer RNG lives in the state.
//
// All functions are pure: they return a new state and never mutate the input.
// Evaluation can run anywhere (workers, other machines): take `pendingTasks`,
// run `evaluateTask` on each, feed results back with `submitScores`, then
// `advanceGeneration`. `trainGenerations` does all of that synchronously.
// ---------------------------------------------------------------------------

export const TRAINER_SCHEMA = 'dungeon-gym/trainer'
export const TRAINER_VERSION = 1

export interface TrainerConfig {
  classKey: ClassKey
  /** Seed of the trainer's own RNG (seeds per generation, selection, mutation). */
  seed: number
  populationSize: number
  /** Individuals copied unchanged into the next generation (then re-evaluated). */
  eliteCount: number
  /** Dungeon seeds every individual plays per generation. */
  seedsPerGeneration: number
  /** Dungeon depth per evaluation run. */
  depth: number
  reward: RewardConfig
  tournamentSize: number
  /** Probability a child comes from crossover of two parents (else one parent). */
  crossoverRate: number
}

export interface Individual {
  id: number
  genome: Genome
  parentIds: number[]
  bornGeneration: number
  /** Fitness per seed for the current generation's seeds; null until evaluated. */
  scores: number[] | null
}

export interface GenerationSummary {
  generation: number
  bestId: number
  bestGenomeHash: string
  bestMean: number
  populationMean: number
}

export interface TrainerState {
  schema: typeof TRAINER_SCHEMA
  version: typeof TRAINER_VERSION
  config: TrainerConfig
  rng: RngState
  generation: number
  nextId: number
  /** The dungeon seeds of the current generation (shared by all individuals). */
  seeds: number[]
  population: Individual[]
  history: GenerationSummary[]
}

export interface EvalTask {
  generation: number
  individualId: number
  genome: Genome
  seeds: number[]
  depth: number
  reward: RewardConfig
}

export interface ScoreSubmission {
  generation: number
  individualId: number
  scores: number[]
}

export type SubmitError = 'stale-generation' | 'unknown-individual' | 'already-scored' | 'bad-scores'

export interface SubmitOutcome {
  state: TrainerState
  /** Set when the submission was rejected (state is then unchanged). */
  error?: SubmitError
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function clampInt(v: number | undefined, lo: number, hi: number, dflt: number): number {
  if (v === undefined || !Number.isFinite(v)) return dflt
  return Math.max(lo, Math.min(hi, Math.round(v)))
}

/** Fill defaults and clamp a partial config. */
export function makeTrainerConfig(opts: Partial<TrainerConfig> & { classKey: ClassKey; seed: number }): TrainerConfig {
  if (!isClassKey(opts.classKey)) throw new Error(`trainer: unknown class "${String(opts.classKey)}"`)
  const populationSize = clampInt(opts.populationSize, 2, 128, 8)
  return {
    classKey: opts.classKey,
    seed: opts.seed >>> 0,
    populationSize,
    eliteCount: clampInt(opts.eliteCount, 1, populationSize - 1, Math.min(2, populationSize - 1)),
    seedsPerGeneration: clampInt(opts.seedsPerGeneration, 1, 256, 6),
    depth: clampInt(opts.depth, 1, 50, 5),
    reward: clampReward(opts.reward ?? DEFAULT_REWARD),
    tournamentSize: clampInt(opts.tournamentSize, 1, populationSize, Math.min(3, populationSize)),
    crossoverRate: opts.crossoverRate !== undefined && Number.isFinite(opts.crossoverRate) ? Math.max(0, Math.min(1, opts.crossoverRate)) : 0.5,
  }
}

/** `n` fresh 32-bit dungeon seeds from the trainer RNG. */
export function drawSeeds(rng: Rng, n: number): number[] {
  return Array.from({ length: n }, () => Math.floor(rng() * 4294967296) >>> 0)
}

/**
 * A new trainer. The first generation is `initial` (validated; must match the
 * class) padded with mutants of its first genome — or of the class baseline.
 */
export function createTrainer(opts: Partial<TrainerConfig> & { classKey: ClassKey; seed: number }, initial: readonly Genome[] = []): TrainerState {
  const config = makeTrainerConfig(opts)
  const rngState = seedRng(config.seed)
  const rng = rngOf(rngState)
  const start: Genome[] = initial.map((g, i) => {
    const r = validateGenome(g)
    if (!r.ok) throw new Error(`trainer: invalid initial genome ${i}: ${r.errors.join('; ')}`)
    if (r.genome.classKey !== config.classKey) throw new Error(`trainer: initial genome ${i} is for ${r.genome.classKey}, not ${config.classKey}`)
    return r.genome
  }).slice(0, config.populationSize)
  const seedGenome = start[0] ?? baselineGenome(config.classKey)
  if (start.length === 0) start.push(seedGenome)
  while (start.length < config.populationSize) start.push(mutateGenome(seedGenome, rng))
  const population: Individual[] = start.map((genome, i) => ({ id: i + 1, genome, parentIds: [], bornGeneration: 0, scores: null }))
  return {
    schema: TRAINER_SCHEMA,
    version: TRAINER_VERSION,
    config,
    rng: rngState,
    generation: 0,
    nextId: population.length + 1,
    seeds: drawSeeds(rng, config.seedsPerGeneration),
    population,
    history: [],
  }
}

/** Evaluation tasks still missing scores for the current generation. */
export function pendingTasks(state: TrainerState): EvalTask[] {
  return state.population
    .filter((ind) => ind.scores === null)
    .map((ind) => ({
      generation: state.generation,
      individualId: ind.id,
      genome: clone(ind.genome),
      seeds: [...state.seeds],
      depth: state.config.depth,
      reward: clone(state.config.reward),
    }))
}

/** Run one task locally. Returns the per-seed scores to submit. */
export function evaluateTask(task: EvalTask): number[] {
  return evaluateGenome(task.genome, { seeds: task.seeds, depth: task.depth, reward: task.reward }).scores
}

/** Largest |fitness| accepted from a submission; anything beyond is malformed. */
export const MAX_ABS_SCORE = 1e9

/** Record scores for one individual. Stale/unknown/duplicate/malformed submissions are rejected. */
export function submitScores(state: TrainerState, sub: ScoreSubmission): SubmitOutcome {
  if (typeof sub !== 'object' || sub === null) return { state, error: 'bad-scores' }
  if (sub.generation !== state.generation) return { state, error: 'stale-generation' }
  const idx = state.population.findIndex((ind) => ind.id === sub.individualId)
  if (idx < 0) return { state, error: 'unknown-individual' }
  if (state.population[idx].scores !== null) return { state, error: 'already-scored' }
  if (!Array.isArray(sub.scores) || sub.scores.length !== state.seeds.length || !sub.scores.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= MAX_ABS_SCORE)) {
    return { state, error: 'bad-scores' }
  }
  const next = clone(state)
  next.population[idx].scores = [...sub.scores]
  return { state: next }
}

export function isGenerationComplete(state: TrainerState): boolean {
  return state.population.every((ind) => ind.scores !== null)
}

/** Individuals of the (fully scored) current generation, best first; ties by id. */
export function rankPopulation(state: TrainerState): { individual: Individual; mean: number }[] {
  return state.population
    .map((individual) => ({ individual, mean: individual.scores ? mean(individual.scores) : -Infinity }))
    .sort((a, b) => (a.mean !== b.mean ? (b.mean > a.mean ? 1 : -1) : a.individual.id - b.individual.id))
}

/** Tournament selection: the best of `size` random picks (ties to the lower id). */
export function tournament<T extends { id: number }>(ranked: { individual: T; mean: number }[], size: number, rng: Rng): T {
  let best = ranked[Math.floor(rng() * ranked.length)]
  for (let i = 1; i < size; i++) {
    const c = ranked[Math.floor(rng() * ranked.length)]
    if (c.mean > best.mean || (c.mean === best.mean && c.individual.id < best.individual.id)) best = c
  }
  return best.individual
}

/**
 * Close the current generation: keep the elites (scores cleared — they will be
 * re-evaluated on the next seeds), breed the rest by tournament selection,
 * crossover and mutation, draw the next generation's seeds.
 * Throws if any individual is still unscored.
 */
export function advanceGeneration(state: TrainerState): TrainerState {
  if (!isGenerationComplete(state)) throw new Error('trainer: generation is not fully scored')
  const next = clone(state)
  const rng = rngOf(next.rng)
  const cfg = next.config
  const ranked = rankPopulation(next)
  const best = ranked[0]
  next.history.push({
    generation: next.generation,
    bestId: best.individual.id,
    bestGenomeHash: genomeHash(best.individual.genome),
    bestMean: best.mean,
    populationMean: mean(ranked.map((r) => r.mean)),
  })
  const elites: Individual[] = ranked.slice(0, cfg.eliteCount).map((r) => ({ ...r.individual, scores: null }))
  const children: Individual[] = []
  while (elites.length + children.length < cfg.populationSize) {
    const a = tournament(ranked, cfg.tournamentSize, rng)
    let genome: Genome
    let parentIds: number[]
    if (rng() < cfg.crossoverRate) {
      const b = tournament(ranked, cfg.tournamentSize, rng)
      genome = mutateGenome(crossoverGenomes(a.genome, b.genome, rng), rng)
      parentIds = a.id === b.id ? [a.id] : [a.id, b.id]
    } else {
      genome = mutateGenome(a.genome, rng)
      parentIds = [a.id]
    }
    children.push({ id: next.nextId++, genome, parentIds, bornGeneration: next.generation + 1, scores: null })
  }
  next.population = [...elites, ...children]
  next.generation++
  next.seeds = drawSeeds(rng, cfg.seedsPerGeneration)
  return next
}

/** The best individual of the last completed generation (null before the first). */
export function lastBest(state: TrainerState): GenerationSummary | null {
  return state.history.length > 0 ? state.history[state.history.length - 1] : null
}

/** Synchronously evaluate + advance `generations` times. */
export function trainGenerations(
  state: TrainerState,
  generations: number,
  evaluate: (task: EvalTask) => number[] = evaluateTask,
): TrainerState {
  let s = state
  for (let g = 0; g < generations; g++) {
    for (const task of pendingTasks(s)) {
      const res = submitScores(s, { generation: task.generation, individualId: task.individualId, scores: evaluate(task) })
      if (res.error) throw new Error(`trainer: submission rejected (${res.error})`)
      s = res.state
    }
    s = advanceGeneration(s)
  }
  return s
}
