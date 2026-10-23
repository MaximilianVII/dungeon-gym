import type { ClassKey } from '../character/build'
import { genomeHash, validateGenome, type Genome } from '../bot/genome'
import { BENCHMARK, type BenchmarkResult } from './evaluate'

// ---------------------------------------------------------------------------
// Hall of Fame — the best genome per class, judged ONLY by its own benchmark
// score (mean over the fixed benchmark seeds). A candidate is accepted only
// with a BenchmarkResult that matches it (same genome hash, class and
// benchmark id), so a recorded score always belongs to the recorded genome.
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

export type HallOfFameRejection = 'invalid-genome' | 'hash-mismatch' | 'class-mismatch' | 'wrong-benchmark' | 'not-better'

export interface HallOfFameUpdate {
  hall: HallOfFame
  crowned: boolean
  reason?: HallOfFameRejection
}

/** Crown `genome` for its class if its benchmark score beats the incumbent (ties keep the incumbent). */
export function considerForHallOfFame(
  hall: HallOfFame,
  genome: Genome,
  bench: BenchmarkResult,
  benchmarkId: string = BENCHMARK.id,
): HallOfFameUpdate {
  const checked = validateGenome(genome)
  if (!checked.ok) return { hall, crowned: false, reason: 'invalid-genome' }
  if (bench.benchmarkId !== benchmarkId) return { hall, crowned: false, reason: 'wrong-benchmark' }
  if (bench.classKey !== checked.genome.classKey) return { hall, crowned: false, reason: 'class-mismatch' }
  if (bench.genomeHash !== genomeHash(checked.genome)) return { hall, crowned: false, reason: 'hash-mismatch' }
  const incumbent = hall[checked.genome.classKey]
  if (incumbent && incumbent.benchmarkId === benchmarkId && incumbent.score >= bench.score) {
    return { hall, crowned: false, reason: 'not-better' }
  }
  const entry: HallOfFameEntry = {
    classKey: checked.genome.classKey,
    genome: checked.genome,
    genomeHash: bench.genomeHash,
    benchmarkId,
    score: bench.score,
    wins: bench.wins,
  }
  return { hall: { ...hall, [entry.classKey]: entry }, crowned: true }
}
