import { describe, it, expect } from 'vitest'
import {
  baselineGenome, parseGenome, serializeGenome,
  createRun, stepRun, isRunDone, runResult, runSnapshot, playRun,
  createTrainer, trainGenerations, lastBest,
  benchmarkGenome, considerForHallOfFame, BENCHMARK, CORE_VERSION,
  baselineTeam, createPartyTrainer, trainPartyGenerations, lastBestTeam, benchmarkTeam, PARTY_BENCHMARK,
  type Benchmark,
} from '../src/index'

// Mirrors the README usage section through the public entry point.
describe('README usage', () => {
  it('works end to end through src/index.ts', () => {
    const genome = baselineGenome('wizard')
    const text = serializeGenome(genome)
    const parsed = parseGenome(text)
    expect(parsed.ok).toBe(true)

    const run = createRun({ seed: 42, depth: 2, party: [{ genome }] })
    while (!isRunDone(run)) {
      stepRun(run)
      runSnapshot(run)
    }
    expect(runResult(run)).toEqual(playRun({ seed: 42, depth: 2, party: [{ genome }] }))

    let trainer = createTrainer({ classKey: 'wizard', seed: 1, populationSize: 3, seedsPerGeneration: 1, depth: 1 })
    trainer = trainGenerations(trainer, 2)
    expect(lastBest(trainer)?.generation).toBe(1)

    const quick: Benchmark = { ...BENCHMARK, seeds: BENCHMARK.seeds.slice(0, 2), depth: 1 }
    const score = benchmarkGenome(genome, quick)
    expect(score.scores).toHaveLength(2)
    const { hall, crowned } = considerForHallOfFame({}, genome, quick)
    expect(crowned).toBe(true)
    expect(hall.wizard?.benchmarkId).toContain(CORE_VERSION)
  })

  it('party training works through src/index.ts', () => {
    const team = baselineTeam(['fighter', 'cleric'])
    let party = createPartyTrainer({ classKeys: ['fighter', 'cleric'], seed: 1, populationSize: 3, seedsPerGeneration: 1, depth: 1 })
    party = trainPartyGenerations(party, 1)
    expect(lastBestTeam(party)?.generation).toBe(0)
    expect(benchmarkTeam(team, { ...PARTY_BENCHMARK, seeds: [1], depth: 1 }).benchmarkId).toContain(CORE_VERSION)
  })
})
