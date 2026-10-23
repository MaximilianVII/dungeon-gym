import { genomeHash, validateGenome, type Genome } from '../bot/genome'
import { BENCHMARK_REWARD, DEFAULT_REWARD, diversityBonus, memberFitness, type RewardConfig } from '../bot/reward'
import { playRun, type PartyMemberInit, type RunResult } from '../bot/run'
import { CORE_VERSION } from '../version'

// ---------------------------------------------------------------------------
// Deterministic evaluation of a genome on a set of dungeon seeds, and the
// fixed BENCHMARK that defines a genome's official score:
//
//   benchmarkGenome(genome).score   — same number on every machine for the
//                                     same CORE_VERSION; what a server should
//                                     recompute for an uploaded genome.
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  seeds: readonly number[]
  /** Dungeon depth per run (default 5). */
  depth?: number
  reward?: RewardConfig
  /** Optional fixed teammates (party evaluation); the genome plays slot 0. */
  teammates?: readonly PartyMemberInit[]
}

export interface Evaluation {
  genomeHash: string
  /** Fitness of the evaluated member, one per seed (same order as `seeds`). */
  scores: number[]
  mean: number
  results: RunResult[]
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

/** Fitness of the slot-0 member of a finished run under `reward`. */
export function scoreRun(result: RunResult, party: readonly PartyMemberInit[], reward: RewardConfig): number {
  const bonus = party.length > 1 ? diversityBonus(party.map((p) => p.genome.genes), reward) : 0
  return memberFitness(result.members[0], reward) + bonus
}

/** Play one run per seed and score the genome (strictly validated first). */
export function evaluateGenome(genome: Genome, opts: EvaluateOptions): Evaluation {
  const checked = validateGenome(genome)
  if (!checked.ok) throw new Error(`evaluateGenome: invalid genome: ${checked.errors.join('; ')}`)
  const reward = opts.reward ?? DEFAULT_REWARD
  const party: PartyMemberInit[] = [{ genome: checked.genome }, ...(opts.teammates ?? [])]
  const results = opts.seeds.map((seed) => playRun({ seed, depth: opts.depth, party }))
  const scores = results.map((r) => scoreRun(r, party, reward))
  return { genomeHash: genomeHash(checked.genome), scores, mean: mean(scores), results }
}

export interface Benchmark {
  id: string
  coreVersion: string
  depth: number
  seeds: readonly number[]
  reward: RewardConfig
}

/** The official solo benchmark: 32 fixed seeds × 10 levels, outcome-only reward. */
export const BENCHMARK: Benchmark = {
  id: `dungeon-gym/bench-v1@${CORE_VERSION}`,
  coreVersion: CORE_VERSION,
  depth: 10,
  seeds: [
    2069256438, 3403365569, 4168886260, 1039181353, 1222523175, 3241104425, 3431600125, 1948125537,
    3324615876, 917577558, 1278693056, 1401363704, 1439511625, 1288271729, 4248788169, 2891797392,
    378415729, 3063960374, 2308305891, 3886190076, 3632593987, 2068650922, 2514776209, 2447476565,
    3192556735, 3717279030, 2518926029, 4228554414, 1218025169, 2112934956, 903662956, 2593022835,
  ],
  reward: BENCHMARK_REWARD,
}

export interface BenchmarkResult {
  benchmarkId: string
  genomeHash: string
  classKey: Genome['classKey']
  /** Mean fitness over the benchmark seeds — the genome's official score. */
  score: number
  scores: number[]
  wins: number
}

/** Score a genome on the fixed benchmark. Deterministic. */
export function benchmarkGenome(genome: Genome, bench: Benchmark = BENCHMARK): BenchmarkResult {
  const ev = evaluateGenome(genome, { seeds: bench.seeds, depth: bench.depth, reward: bench.reward })
  return {
    benchmarkId: bench.id,
    genomeHash: ev.genomeHash,
    classKey: genome.classKey,
    score: ev.mean,
    scores: ev.scores,
    wins: ev.results.filter((r) => r.won).length,
  }
}
