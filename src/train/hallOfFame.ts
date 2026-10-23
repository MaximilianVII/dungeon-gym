import type { ClassKey } from '../character/build'
import { validateGenome, type Genome } from '../bot/genome'
import { BENCHMARK, benchmarkGenome, type Benchmark, type BenchmarkResult } from './evaluate'

// ---------------------------------------------------------------------------
// Hall of Fame — the best genome per class, judged ONLY by its own benchmark
// score. The score is always recomputed here (the benchmark is deterministic
// and cheap), never taken from the caller, so a recorded score always belongs
// to the recorded genome and cannot be forged.
// Plain JSON; functions return a new hall and never mutate the input.
// ---------------------------------------------------------------------------

export interface HallOfFameEntry {
  classKey: ClassKey
  genome: Genome
  genomeHash: string
  benchmarkId: string
  score: number
  wins: number
}

export type HallOfFame = Partial<Record<ClassKey, HallOfFameEntry>>

export type HallOfFameRejection = 'invalid-genome' | 'not-better'

export interface HallOfFameUpdate {
  hall: HallOfFame
  crowned: boolean
  /** The genome's freshly computed benchmark result (absent for an invalid genome). */
  result?: BenchmarkResult
  reason?: HallOfFameRejection
}

/**
 * Benchmark `genome` and crown it for its class if it beats the incumbent on
 * the same benchmark (ties keep the incumbent). An incumbent scored on a
 * different benchmark id (e.g. an older CORE_VERSION) is always replaced.
 */
export function considerForHallOfFame(hall: HallOfFame, genome: Genome, bench: Benchmark = BENCHMARK): HallOfFameUpdate {
  const checked = validateGenome(genome)
  if (!checked.ok) return { hall, crowned: false, reason: 'invalid-genome' }
  const result = benchmarkGenome(checked.genome, bench)
  const incumbent = hall[checked.genome.classKey]
  if (incumbent && incumbent.benchmarkId === result.benchmarkId && incumbent.score >= result.score) {
    return { hall, crowned: false, result, reason: 'not-better' }
  }
  const entry: HallOfFameEntry = {
    classKey: checked.genome.classKey,
    genome: checked.genome,
    genomeHash: result.genomeHash,
    benchmarkId: result.benchmarkId,
    score: result.score,
    wins: result.wins,
  }
  return { hall: { ...hall, [entry.classKey]: entry }, crowned: true, result }
}
