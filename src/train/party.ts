import { isClassKey, type ClassKey } from '../character/build'
import { crossoverGenomes, mutateGenome } from '../bot/genome'
import { BENCHMARK_REWARD, DEFAULT_REWARD, diversityBonus, memberFitness, type RewardConfig } from '../bot/reward'
import { playRun, type RunResult } from '../bot/run'
import { baselineTeam, makeTeam, teamClasses, teamHash, validateTeam, type Team } from '../bot/team'
import { rngOf, seedRng, type Rng, type RngState } from '../rng'
import { CORE_VERSION } from '../version'
import { deepFreeze } from '../freeze'
import { drawSeeds, makeTrainerConfig, MAX_ABS_SCORE, tournament, type SubmitError, type TrainerConfig } from './trainer'
import { mean, type Benchmark } from './evaluate'

// ---------------------------------------------------------------------------
// Party training (2c). The unit of selection is a whole TEAM (bot/team): a
// fixed line-up of full genomes that plays every run together. A team's
// fitness on a run is the mean of its members' fitness (+ the reward's
// diversity bonus); members are never re-mixed per run. Breeding mutates every
// member and crosses two teams slot by slot (same class in the same slot).
//
// The trainer mirrors the solo one (train/trainer): common random numbers,
// elites re-evaluated, tournament selection, (generation, individualId) task
// keys with stale/duplicate submissions rejected, RNG in the state, pure
// functions. PARTY_BENCHMARK is the official party score (its own id).
// ---------------------------------------------------------------------------

/** A classic line-up: front-liner, healer, arcane caster, skirmisher. */
export const DEFAULT_PARTY: readonly ClassKey[] = deepFreeze(['fighter', 'cleric', 'wizard', 'rogue'])

export interface TeamEvaluation {
  teamHash: string
  /** Team fitness, one per seed (same order as `seeds`). */
  scores: number[]
  mean: number
  results: RunResult[]
}

/** Team fitness of a finished run: the mean member fitness + the diversity bonus. */
export function scoreTeamRun(result: RunResult, team: Team, reward: RewardConfig): number {
  const bonus = team.members.length > 1 ? diversityBonus(team.members.map((g) => g.genes), reward) : 0
  return mean(result.members.map((m) => memberFitness(m, reward))) + bonus
}

/** Play the team (strictly validated first) on every seed and score it. */
export function evaluateTeam(team: Team, opts: { seeds: readonly number[]; depth?: number; reward?: RewardConfig }): TeamEvaluation {
  const checked = validateTeam(team)
  if (!checked.ok) throw new Error(`evaluateTeam: invalid team: ${checked.errors.join('; ')}`)
  const reward = opts.reward ?? DEFAULT_REWARD
  const party = checked.team.members.map((genome) => ({ genome }))
  const results = opts.seeds.map((seed) => playRun({ seed, depth: opts.depth, party }))
  const scores = results.map((r) => scoreTeamRun(r, checked.team, reward))
  return { teamHash: teamHash(checked.team), scores, mean: mean(scores), results }
}

/** The official party benchmark: 32 fixed seeds × 15 levels, outcome-only reward
 *  (a party clears 10 levels nearly every time; 15 still separates line-ups). */
export const PARTY_BENCHMARK: Benchmark = deepFreeze({
  id: `dungeon-gym/party-bench-v1@${CORE_VERSION}`,
  coreVersion: CORE_VERSION,
  depth: 15,
  seeds: [
    880367475, 39255672, 3698065627, 4172114836, 93930124, 4272239736, 2068731168, 2144481154,
    1190733473, 1866658214, 365954686, 894692124, 2032500873, 2256465703, 4017587477, 667434682,
    1023831090, 2983163487, 3444264148, 2093221728, 14214342, 1218946786, 3816715538, 3456237821,
    1455405197, 4123208167, 2329223614, 4290499790, 2490308365, 536538714, 4250145834, 3531435496,
  ],
  reward: BENCHMARK_REWARD,
})

export interface TeamBenchmarkResult {
  benchmarkId: string
  teamHash: string
  classKeys: ClassKey[]
  /** Mean team fitness over the benchmark seeds — the team's official score. */
  score: number
  scores: number[]
  /** Runs in which the party cleared the last level. */
  wins: number
}

/** Score a team on the fixed party benchmark. Deterministic. */
export function benchmarkTeam(team: Team, bench: Benchmark = PARTY_BENCHMARK): TeamBenchmarkResult {
  const ev = evaluateTeam(team, { seeds: bench.seeds, depth: bench.depth, reward: bench.reward })
  return {
    benchmarkId: bench.id,
    teamHash: ev.teamHash,
    classKeys: teamClasses(team),
    score: ev.mean,
    scores: ev.scores,
    wins: ev.results.filter((r) => r.won).length,
  }
}

// ---------------------------------------------------------------------------
// Party trainer
// ---------------------------------------------------------------------------

export const PARTY_TRAINER_SCHEMA = 'dungeon-gym/party-trainer'
export const PARTY_TRAINER_VERSION = 1

export type PartyTrainerConfig = Omit<TrainerConfig, 'classKey'> & {
  /** The line-up's classes, in slot order (1–5). */
  classKeys: ClassKey[]
}

export interface TeamIndividual {
  id: number
  team: Team
  parentIds: number[]
  bornGeneration: number
  /** Team fitness per seed of the current generation; null until evaluated. */
  scores: number[] | null
}

export interface PartyGenerationSummary {
  generation: number
  bestId: number
  bestTeamHash: string
  bestMean: number
  populationMean: number
}

export interface PartyTrainerState {
  schema: typeof PARTY_TRAINER_SCHEMA
  version: typeof PARTY_TRAINER_VERSION
  config: PartyTrainerConfig
  rng: RngState
  generation: number
  nextId: number
  seeds: number[]
  population: TeamIndividual[]
  history: PartyGenerationSummary[]
}

export interface PartyEvalTask {
  generation: number
  individualId: number
  team: Team
  seeds: number[]
  depth: number
  reward: RewardConfig
}

export interface PartySubmitOutcome {
  state: PartyTrainerState
  error?: SubmitError
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** Fill defaults and clamp a partial config (same knobs as the solo trainer). */
export function makePartyTrainerConfig(opts: Partial<PartyTrainerConfig> & { classKeys: readonly ClassKey[]; seed: number }): PartyTrainerConfig {
  const keys = [...opts.classKeys]
  if (keys.length < 1 || keys.length > 5) throw new Error('party trainer: 1–5 classes')
  for (const k of keys) if (!isClassKey(k)) throw new Error(`party trainer: unknown class "${String(k)}"`)
  const solo = makeTrainerConfig({ ...opts, classKey: keys[0] })
  return {
    seed: solo.seed,
    populationSize: solo.populationSize,
    eliteCount: solo.eliteCount,
    seedsPerGeneration: solo.seedsPerGeneration,
    depth: solo.depth,
    reward: solo.reward,
    tournamentSize: solo.tournamentSize,
    crossoverRate: solo.crossoverRate,
    classKeys: keys,
  }
}

function mutateTeam(team: Team, rng: Rng): Team {
  return makeTeam(team.members.map((g) => mutateGenome(g, rng)))
}

function crossoverTeams(a: Team, b: Team, rng: Rng): Team {
  return makeTeam(a.members.map((g, i) => crossoverGenomes(g, b.members[i], rng)))
}

/**
 * A new party trainer. The first generation is `initial` (validated; each must
 * have exactly the configured classes in order) padded with mutants of its
 * first team — or of the baseline team.
 */
export function createPartyTrainer(opts: Partial<PartyTrainerConfig> & { classKeys: readonly ClassKey[]; seed: number }, initial: readonly Team[] = []): PartyTrainerState {
  const config = makePartyTrainerConfig(opts)
  const rngState = seedRng(config.seed)
  const rng = rngOf(rngState)
  const start: Team[] = initial.map((t, i) => {
    const r = validateTeam(t)
    if (!r.ok) throw new Error(`party trainer: invalid initial team ${i}: ${r.errors.join('; ')}`)
    if (teamClasses(r.team).join(',') !== config.classKeys.join(',')) throw new Error(`party trainer: initial team ${i} is ${teamClasses(r.team).join(',')}, not ${config.classKeys.join(',')}`)
    return r.team
  }).slice(0, config.populationSize)
  const seedTeam = start[0] ?? baselineTeam(config.classKeys)
  if (start.length === 0) start.push(seedTeam)
  while (start.length < config.populationSize) start.push(mutateTeam(seedTeam, rng))
  return {
    schema: PARTY_TRAINER_SCHEMA,
    version: PARTY_TRAINER_VERSION,
    config,
    rng: rngState,
    generation: 0,
    nextId: start.length + 1,
    seeds: drawSeeds(rng, config.seedsPerGeneration),
    population: start.map((team, i) => ({ id: i + 1, team, parentIds: [], bornGeneration: 0, scores: null })),
    history: [],
  }
}

/** Evaluation tasks still missing scores for the current generation. */
export function pendingPartyTasks(state: PartyTrainerState): PartyEvalTask[] {
  return state.population
    .filter((ind) => ind.scores === null)
    .map((ind) => ({
      generation: state.generation,
      individualId: ind.id,
      team: clone(ind.team),
      seeds: [...state.seeds],
      depth: state.config.depth,
      reward: clone(state.config.reward),
    }))
}

/** Run one task locally. Returns the per-seed team scores to submit. */
export function evaluatePartyTask(task: PartyEvalTask): number[] {
  return evaluateTeam(task.team, { seeds: task.seeds, depth: task.depth, reward: task.reward }).scores
}

/** Record scores for one team. Stale/unknown/duplicate/malformed submissions are rejected. */
export function submitPartyScores(state: PartyTrainerState, sub: { generation: number; individualId: number; scores: number[] }): PartySubmitOutcome {
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

export function isPartyGenerationComplete(state: PartyTrainerState): boolean {
  return state.population.every((ind) => ind.scores !== null)
}

/** Teams of the (fully scored) current generation, best first; ties by id. */
export function rankTeams(state: PartyTrainerState): { individual: TeamIndividual; mean: number }[] {
  return state.population
    .map((individual) => ({ individual, mean: individual.scores ? mean(individual.scores) : -Infinity }))
    .sort((a, b) => (a.mean !== b.mean ? (b.mean > a.mean ? 1 : -1) : a.individual.id - b.individual.id))
}

/** Close the generation: keep elites (re-evaluated next time), breed the rest. */
export function advancePartyGeneration(state: PartyTrainerState): PartyTrainerState {
  if (!isPartyGenerationComplete(state)) throw new Error('party trainer: generation is not fully scored')
  const next = clone(state)
  const rng = rngOf(next.rng)
  const cfg = next.config
  const ranked = rankTeams(next)
  const best = ranked[0]
  next.history.push({
    generation: next.generation,
    bestId: best.individual.id,
    bestTeamHash: teamHash(best.individual.team),
    bestMean: best.mean,
    populationMean: mean(ranked.map((r) => r.mean)),
  })
  const elites: TeamIndividual[] = ranked.slice(0, cfg.eliteCount).map((r) => ({ ...r.individual, scores: null }))
  const children: TeamIndividual[] = []
  while (elites.length + children.length < cfg.populationSize) {
    const a = tournament(ranked, cfg.tournamentSize, rng)
    let team: Team
    let parentIds: number[]
    if (rng() < cfg.crossoverRate) {
      const b = tournament(ranked, cfg.tournamentSize, rng)
      team = mutateTeam(crossoverTeams(a.team, b.team, rng), rng)
      parentIds = a.id === b.id ? [a.id] : [a.id, b.id]
    } else {
      team = mutateTeam(a.team, rng)
      parentIds = [a.id]
    }
    children.push({ id: next.nextId++, team, parentIds, bornGeneration: next.generation + 1, scores: null })
  }
  next.population = [...elites, ...children]
  next.generation++
  next.seeds = drawSeeds(rng, cfg.seedsPerGeneration)
  return next
}

/** The best team of the last completed generation (null before the first). */
export function lastBestTeam(state: PartyTrainerState): PartyGenerationSummary | null {
  return state.history.length > 0 ? state.history[state.history.length - 1] : null
}

/** Synchronously evaluate + advance `generations` times. */
export function trainPartyGenerations(
  state: PartyTrainerState,
  generations: number,
  evaluate: (task: PartyEvalTask) => number[] = evaluatePartyTask,
): PartyTrainerState {
  let s = state
  for (let g = 0; g < generations; g++) {
    for (const task of pendingPartyTasks(s)) {
      const res = submitPartyScores(s, { generation: task.generation, individualId: task.individualId, scores: evaluate(task) })
      if (res.error) throw new Error(`party trainer: submission rejected (${res.error})`)
      s = res.state
    }
    s = advancePartyGeneration(s)
  }
  return s
}
