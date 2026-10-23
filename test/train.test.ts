import { describe, it, expect } from 'vitest'
import {
  advanceGeneration, createTrainer, evaluateTask, isGenerationComplete, lastBest, makeTrainerConfig, pendingTasks, rankPopulation,
  submitScores, trainGenerations, type EvalTask, type TrainerState,
} from '../src/train/trainer'
import { BENCHMARK, benchmarkGenome, evaluateGenome, mean, scoreRun, type Benchmark } from '../src/train/evaluate'
import { considerForHallOfFame, type HallOfFame } from '../src/train/hallOfFame'
import { baselineGenome, genomeHash, makeGenome } from '../src/bot/genome'
import { BENCHMARK_REWARD, DEFAULT_REWARD, REWARD_PRESETS, clampReward, diversityBonus, memberFitness } from '../src/bot/reward'
import { mergeUsage } from '../src/bot/usage'
import { playRun } from '../src/bot/run'
import { CORE_VERSION } from '../src/version'
import { genes } from './genes'

/** A fast, deterministic synthetic fitness: peak at kite = 0.2, aggression = 0.8. */
function synthetic(task: EvalTask): number[] {
  const g = task.genome.genes
  const f = 100 - 100 * (Math.abs(g.kite - 0.2) + Math.abs(g.aggression - 0.8))
  return task.seeds.map((s) => f + (s % 7) / 100)
}

const CHEAP = { seedsPerGeneration: 2, depth: 1, populationSize: 4, eliteCount: 1 }

describe('trainer', () => {
  it('is fully deterministic for a given seed', () => {
    const a = trainGenerations(createTrainer({ classKey: 'fighter', seed: 7, ...CHEAP }), 3, synthetic)
    const b = trainGenerations(createTrainer({ classKey: 'fighter', seed: 7, ...CHEAP }), 3, synthetic)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    const c = trainGenerations(createTrainer({ classKey: 'fighter', seed: 8, ...CHEAP }), 3, synthetic)
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a))
  })

  it('scores every individual of a generation on the SAME seeds (common random numbers)', () => {
    const s = createTrainer({ classKey: 'wizard', seed: 1, populationSize: 6, seedsPerGeneration: 5 })
    const tasks = pendingTasks(s)
    expect(tasks).toHaveLength(6)
    for (const t of tasks) expect(t.seeds).toEqual(s.seeds)
    expect(new Set(tasks.map((t) => t.individualId)).size).toBe(6)
  })

  it('rejects stale, unknown, duplicate and malformed submissions — never mis-credits', () => {
    let s = createTrainer({ classKey: 'rogue', seed: 3, ...CHEAP })
    const [t0] = pendingTasks(s)
    const ok = submitScores(s, { generation: 0, individualId: t0.individualId, scores: [1, 2] })
    expect(ok.error).toBeUndefined()
    s = ok.state
    expect(submitScores(s, { generation: 0, individualId: t0.individualId, scores: [1, 2] }).error).toBe('already-scored')
    expect(submitScores(s, { generation: 0, individualId: 999, scores: [1, 2] }).error).toBe('unknown-individual')
    expect(submitScores(s, { generation: 0, individualId: pendingTasks(s)[0].individualId, scores: [1] }).error).toBe('bad-scores')
    expect(submitScores(s, { generation: 0, individualId: pendingTasks(s)[0].individualId, scores: [1, Number.NaN] }).error).toBe('bad-scores')
    // Finish the generation and advance: a late result for generation 0 is refused.
    for (const t of pendingTasks(s)) s = submitScores(s, { generation: 0, individualId: t.individualId, scores: [0, 0] }).state
    const before = s
    s = advanceGeneration(s)
    expect(submitScores(s, { generation: 0, individualId: t0.individualId, scores: [5, 5] }).error).toBe('stale-generation')
    // Inputs are never mutated.
    expect(before.generation).toBe(0)
  })

  it('advancing needs a fully scored generation; elites keep their ids, children get fresh ones', () => {
    let s = createTrainer({ classKey: 'cleric', seed: 4, ...CHEAP })
    expect(isGenerationComplete(s)).toBe(false)
    expect(() => advanceGeneration(s)).toThrow(/not fully scored/)
    for (const t of pendingTasks(s)) s = submitScores(s, { generation: 0, individualId: t.individualId, scores: synthetic(t) }).state
    const best = rankPopulation(s)[0].individual
    const next = advanceGeneration(s)
    expect(next.generation).toBe(1)
    expect(next.population[0].id).toBe(best.id)
    expect(next.population[0].scores).toBeNull() // elites are re-evaluated on new seeds
    const oldIds = new Set(s.population.map((i) => i.id))
    for (const child of next.population.slice(1)) {
      expect(oldIds.has(child.id)).toBe(false)
      expect(child.parentIds.length).toBeGreaterThan(0)
      expect(child.bornGeneration).toBe(1)
    }
    expect(next.seeds).not.toEqual(s.seeds)
    expect(lastBest(next)?.bestId).toBe(best.id)
    expect(lastBest(s)).toBeNull()
  })

  it('actually optimises: the best mean climbs on a synthetic landscape', () => {
    const s = trainGenerations(createTrainer({ classKey: 'fighter', seed: 11, populationSize: 10, eliteCount: 2, seedsPerGeneration: 2 }), 25, synthetic)
    const first = s.history[0].bestMean
    const last = s.history[s.history.length - 1].bestMean
    expect(last).toBeGreaterThan(first)
    expect(last).toBeGreaterThan(90)
  })

  it('freezes reward/depth in the config and clamps bad options', () => {
    const cfg = makeTrainerConfig({ classKey: 'bard', seed: -1, populationSize: 1, eliteCount: 50, depth: 999, crossoverRate: 7 })
    expect(cfg).toMatchObject({ seed: 4294967295, populationSize: 2, eliteCount: 1, depth: 50, crossoverRate: 1 })
    expect(cfg.reward).toEqual(DEFAULT_REWARD)
    expect(() => makeTrainerConfig({ classKey: 'starfarer' as 'bard', seed: 1 })).toThrow(/unknown class/)
    const task = pendingTasks(createTrainer({ classKey: 'bard', seed: 1, reward: BENCHMARK_REWARD }))[0]
    expect(task.reward).toEqual(BENCHMARK_REWARD)
  })

  it('accepts initial genomes and rejects mismatched ones', () => {
    const g = makeGenome('ranger', genes({ kite: 0.99 }))
    const s = createTrainer({ classKey: 'ranger', seed: 2, ...CHEAP }, [g])
    expect(s.population[0].genome).toEqual(g)
    expect(s.population).toHaveLength(4)
    expect(() => createTrainer({ classKey: 'ranger', seed: 2 }, [baselineGenome('wizard')])).toThrow(/is for wizard/)
    expect(() => createTrainer({ classKey: 'ranger', seed: 2 }, [{ ...g, version: 9 } as unknown as typeof g])).toThrow(/invalid initial genome/)
  })

  it('evaluates real runs for a task (deterministically)', () => {
    const s: TrainerState = createTrainer({ classKey: 'fighter', seed: 5, ...CHEAP })
    const t = pendingTasks(s)[0]
    const a = evaluateTask(t)
    expect(a).toHaveLength(2)
    expect(evaluateTask(t)).toEqual(a)
    const trained = trainGenerations(s, 1)
    expect(trained.generation).toBe(1)
  })
})

describe('evaluation + benchmark', () => {
  const MINI: Benchmark = { id: 'mini', coreVersion: CORE_VERSION, depth: 1, seeds: [1, 2, 3], reward: BENCHMARK_REWARD }

  it('evaluateGenome is deterministic and validates its genome', () => {
    const g = baselineGenome('paladin')
    const a = evaluateGenome(g, { seeds: [10, 20], depth: 1 })
    expect(a).toEqual(evaluateGenome(g, { seeds: [10, 20], depth: 1 }))
    expect(a.mean).toBe(mean(a.scores))
    expect(a.genomeHash).toBe(genomeHash(g))
    expect(() => evaluateGenome({ ...g, classKey: 'x' } as unknown as typeof g, { seeds: [1] })).toThrow(/invalid genome/)
    expect(mean([])).toBe(0)
  })

  it('the official benchmark is fixed, versioned and outcome-only', () => {
    expect(BENCHMARK.seeds).toHaveLength(32)
    expect(new Set(BENCHMARK.seeds).size).toBe(32)
    expect(BENCHMARK.id).toContain(CORE_VERSION)
    expect(BENCHMARK.reward.damage).toBe(0)
    expect(BENCHMARK.reward.healing).toBe(0)
    const r = benchmarkGenome(baselineGenome('fighter'), MINI)
    expect(r).toEqual(benchmarkGenome(baselineGenome('fighter'), MINI))
    expect(r).toMatchObject({ benchmarkId: 'mini', classKey: 'fighter', genomeHash: genomeHash(baselineGenome('fighter')) })
    expect(r.scores).toHaveLength(3)
  })

  it('party evaluation adds the diversity bonus of the genes that played', () => {
    const party = [{ genome: makeGenome('cleric', genes({ healAllies: 0.9, protectAllies: 0.1, aggression: 0.1, kite: 0.1 })) }, { genome: makeGenome('fighter', genes({ healAllies: 0.1, protectAllies: 0.9, aggression: 0.1, kite: 0.1 })) }]
    const result = playRun({ seed: 4, depth: 1, party })
    expect(scoreRun(result, party, DEFAULT_REWARD) - memberFitness(result.members[0], DEFAULT_REWARD)).toBe(DEFAULT_REWARD.diversity)
    const ev = evaluateGenome(party[0].genome, { seeds: [4], depth: 1, teammates: [party[1]] })
    expect(ev.results[0].partySize).toBe(2)
  })
})

describe('hall of fame', () => {
  const MINI: Benchmark = { id: BENCHMARK.id, coreVersion: CORE_VERSION, depth: 1, seeds: [1, 2], reward: BENCHMARK_REWARD }

  it('scores the genome itself (no caller-supplied score to forge); best score wins', () => {
    const a = baselineGenome('fighter')
    let hall: HallOfFame = {}
    const first = considerForHallOfFame(hall, a, MINI)
    expect(first.crowned).toBe(true)
    expect(hall).toEqual({}) // immutable
    hall = first.hall
    expect(hall.fighter?.score).toBe(benchmarkGenome(a, MINI).score)
    expect(hall.fighter?.genomeHash).toBe(genomeHash(a))
    expect(considerForHallOfFame(hall, a, MINI).reason).toBe('not-better')
    expect(considerForHallOfFame(hall, { ...a, version: 3 } as unknown as typeof a, MINI).reason).toBe('invalid-genome')
    // A genome that scores better replaces the incumbent; a worse one does not.
    const rivals = [0.05, 0.3, 0.6, 0.95].map((kite) => makeGenome('fighter', { ...a.genes, kite, aggression: 1 - kite }))
    for (const r of rivals) {
      const res = considerForHallOfFame(hall, r, MINI)
      expect(res.crowned).toBe((res.result?.score ?? -Infinity) > (hall.fighter?.score ?? -Infinity))
      hall = res.hall
    }
    // An incumbent from another benchmark version is always replaced.
    const stale: HallOfFame = { fighter: { ...hall.fighter!, benchmarkId: 'old', score: Number.MAX_VALUE } }
    expect(considerForHallOfFame(stale, a, MINI).crowned).toBe(true)
  })

  it('the official benchmark tables are frozen', () => {
    expect(Object.isFrozen(BENCHMARK)).toBe(true)
    expect(Object.isFrozen(BENCHMARK.seeds)).toBe(true)
    expect(() => (BENCHMARK.seeds as number[]).push(1)).toThrow()
    expect(Object.isFrozen(DEFAULT_REWARD.abilityRewards)).toBe(true)
  })
})

describe('reward + usage', () => {
  it('scores a member-run from its outcome, plus per-ability bonuses', () => {
    const r = { depthReached: 3, alive: true, won: false, charLevel: 6, damage: 10, healing: 5, usage: { Fireball: 2 } }
    expect(memberFitness(r, DEFAULT_REWARD)).toBeCloseTo(3 * 12 + 15 + 6 + 2 + 6)
    expect(memberFitness({ ...r, alive: false, won: false }, BENCHMARK_REWARD)).toBe(36 - 30 + 6)
    expect(memberFitness(r, { ...DEFAULT_REWARD, abilityRewards: { Fireball: 5 } })).toBeCloseTo(3 * 12 + 15 + 6 + 2 + 6 + 10)
    expect(diversityBonus([genes({ healAllies: 1 }), genes({ healAllies: 1 })], DEFAULT_REWARD)).toBe(0)
  })

  it('clamps reward configs and offers presets', () => {
    const c = clampReward({ depth: 1000, win: Number.NaN, abilityRewards: { Rage: 0, Fireball: 999, Bad: Number.NaN } })
    expect(c.depth).toBe(100)
    expect(c.win).toBe(0)
    expect(c.abilityRewards).toEqual({ Fireball: 200 })
    expect(REWARD_PRESETS.benchmark).toEqual(BENCHMARK_REWARD)
  })

  it('merges usage tallies without mutating inputs', () => {
    const a = { Rage: 1 }
    expect(mergeUsage(a, { Rage: 2, Frenzy: 1 })).toEqual({ Rage: 3, Frenzy: 1 })
    expect(a).toEqual({ Rage: 1 })
  })
})
