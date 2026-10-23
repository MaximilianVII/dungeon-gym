import { readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { performance } from 'node:perf_hooks'
import { baselineGenome, genomeHash, parseGenome, serializeGenome, type Genome } from '../src/bot/genome'
import { BENCHMARK_REWARD, DEFAULT_REWARD } from '../src/bot/reward'
import { playRun } from '../src/bot/run'
import { CLASS_KEYS, isClassKey } from '../src/character/build'
import { BENCHMARK, mean } from '../src/train/evaluate'
import { createTrainer, lastBest, type TrainerState } from '../src/train/trainer'
import { CORE_VERSION } from '../src/version'
import { deriveSeed } from '../src/rng'
import { createInlineEvaluator, createWorkerPool, trainWith, type EvalUnit, type Evaluator } from './pool'

// ---------------------------------------------------------------------------
// dungeon-gym CLI:
//   train --class wizard [--generations 20] [--workers K] [--seed 1] [--out genome.json]
//         [--population 8] [--seeds 6] [--depth 10] [--reward benchmark|default]
//         [--init genome.json] [--curve curve.csv] [--state trainer.json] [--validate-seeds 32]
//   bench <genome.json> [--workers K]
//   validate <genome.json>
//   speed [--workers K] [--runs 200]
// The result of `train` depends only on its options — never on --workers.
// ---------------------------------------------------------------------------

type Args = { _: string[]; [flag: string]: string | boolean | string[] }

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else {
        out[key] = next
        i++
      }
    } else out._.push(a)
  }
  return out
}

function num(args: Args, key: string, dflt: number): number {
  const v = args[key]
  if (v === undefined) return dflt
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number`)
  return n
}

function str(args: Args, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' ? v : undefined
}

function readGenome(path: string): Genome {
  const res = parseGenome(readFileSync(path, 'utf8'))
  if (!res.ok) throw new Error(`${path}: invalid genome\n  ${res.errors.join('\n  ')}`)
  return res.genome
}

function evaluatorFor(workers: number): Evaluator {
  return workers <= 1 ? createInlineEvaluator() : createWorkerPool(workers, new URL('./worker.mjs', import.meta.url))
}

const log = (line: string): void => {
  process.stdout.write(line + '\n')
}

async function train(args: Args): Promise<void> {
  const classKey = str(args, 'class') ?? ''
  if (!isClassKey(classKey)) throw new Error(`--class must be one of ${CLASS_KEYS.join(', ')}`)
  const workers = num(args, 'workers', availableParallelism())
  const generations = num(args, 'generations', 20)
  const init = str(args, 'init')
  let state: TrainerState = createTrainer({
    classKey,
    seed: num(args, 'seed', 1),
    populationSize: num(args, 'population', 8),
    seedsPerGeneration: num(args, 'seeds', 12),
    depth: num(args, 'depth', BENCHMARK.depth),
    reward: str(args, 'reward') === 'default' ? DEFAULT_REWARD : BENCHMARK_REWARD,
  }, init ? [readGenome(init)] : [])
  const evaluator = evaluatorFor(workers)
  const curve = ['generation,best_mean,population_mean']
  const t0 = performance.now()
  let runs = 0
  // Each generation's best, kept for hold-out selection (a generation's best is
  // picked on few, noisy seeds; re-scoring on fresh seeds removes that bias).
  const candidates = new Map<string, Genome>()
  let genome: Genome
  let validationMean = 0
  try {
    state = await trainWith(state, generations, evaluator, (s) => {
      const h = lastBest(s)!
      const g = s.population.find((i) => i.id === h.bestId)?.genome
      if (g) candidates.set(genomeHash(g), g)
      runs += s.config.populationSize * s.config.seedsPerGeneration
      curve.push(`${h.generation},${h.bestMean.toFixed(3)},${h.populationMean.toFixed(3)}`)
      const rate = runs / ((performance.now() - t0) / 1000)
      log(`gen ${String(h.generation).padStart(3)}  best ${h.bestMean.toFixed(1).padStart(6)}  mean ${h.populationMean.toFixed(1).padStart(6)}  (${rate.toFixed(0)} runs/s)`)
    })
    // Hold-out validation on seeds derived from the trainer seed (never the
    // benchmark seeds), so the pick is not tuned to the official score.
    const vSeeds = Array.from({ length: num(args, 'validate-seeds', 32) }, (_, i) => deriveSeed(state.config.seed, `validation:${i}`))
    const list = [...candidates.values()]
    const units = list.flatMap((g) => vSeeds.map((seed) => ({ genome: g, seed, depth: state.config.depth, reward: state.config.reward })))
    const results = await evaluator.evaluate(units)
    genome = list[0]
    validationMean = -Infinity
    list.forEach((g, i) => {
      const m = mean(results.slice(i * vSeeds.length, (i + 1) * vSeeds.length).map((r) => r.score))
      if (m >= validationMean) {
        validationMean = m
        genome = g
      }
    })
  } finally {
    await evaluator.close()
  }
  log(`selected on ${candidates.size} candidates, validation mean ${validationMean.toFixed(1)}`)
  const out = str(args, 'out') ?? `${classKey}.genome.json`
  writeFileSync(out, serializeGenome(genome) + '\n')
  const curveFile = str(args, 'curve')
  if (curveFile) writeFileSync(curveFile, curve.join('\n') + '\n')
  const stateFile = str(args, 'state')
  if (stateFile) writeFileSync(stateFile, JSON.stringify(state) + '\n')
  log(`wrote ${out} (${genomeHash(genome)})`)
}

async function benchmarkScores(genome: Genome, workers: number): Promise<{ scores: number[]; wins: number }> {
  const evaluator = evaluatorFor(workers)
  try {
    const units: EvalUnit[] = BENCHMARK.seeds.map((seed) => ({ genome, seed, depth: BENCHMARK.depth, reward: BENCHMARK.reward }))
    const results = await evaluator.evaluate(units)
    return { scores: results.map((r) => r.score), wins: results.filter((r) => r.won).length }
  } finally {
    await evaluator.close()
  }
}

async function bench(args: Args): Promise<void> {
  const path = args._[1]
  const genome = path ? readGenome(path) : null
  const workers = num(args, 'workers', availableParallelism())
  const genomes = genome ? [genome] : CLASS_KEYS.map(baselineGenome)
  for (const g of genomes) {
    const { scores, wins } = await benchmarkScores(g, workers)
    log(JSON.stringify({ benchmarkId: BENCHMARK.id, classKey: g.classKey, genomeHash: genomeHash(g), score: Number(mean(scores).toFixed(3)), wins }))
  }
}

function validate(args: Args): void {
  const path = args._[1]
  if (!path) throw new Error('usage: validate <genome.json>')
  const res = parseGenome(readFileSync(path, 'utf8'))
  if (res.ok) log(`ok ${res.genome.classKey} ${genomeHash(res.genome)}`)
  else {
    log(`invalid:\n  ${res.errors.join('\n  ')}`)
    process.exitCode = 1
  }
}

async function speed(args: Args): Promise<void> {
  const workers = num(args, 'workers', availableParallelism())
  const runs = num(args, 'runs', 240)
  const units: EvalUnit[] = Array.from({ length: runs }, (_, i) => ({
    genome: baselineGenome(CLASS_KEYS[i % CLASS_KEYS.length]),
    seed: BENCHMARK.seeds[i % BENCHMARK.seeds.length] + Math.floor(i / BENCHMARK.seeds.length),
    depth: BENCHMARK.depth,
    reward: BENCHMARK.reward,
  }))
  const evaluator = evaluatorFor(workers)
  try {
    await evaluator.evaluate(units.slice(0, Math.min(runs, workers * 2))) // warm-up
    const t0 = performance.now()
    await evaluator.evaluate(units)
    const secs = (performance.now() - t0) / 1000
    log(JSON.stringify({ coreVersion: CORE_VERSION, workers, runs, seconds: Number(secs.toFixed(3)), runsPerSecond: Number((runs / secs).toFixed(1)), depth: BENCHMARK.depth }))
  } finally {
    await evaluator.close()
  }
}

/** Telemetry table of the baseline genomes on the benchmark (docs/balance.md). */
function report(): void {
  log('| class | score | wins | depth | char lvl | fights | foes / fight | idle / retreat turns | surprised turns | slots | potions | top killers |')
  log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const c of CLASS_KEYS) {
    const party = [{ genome: baselineGenome(c) }]
    const rs = BENCHMARK.seeds.map((seed) => playRun({ seed, depth: BENCHMARK.depth, party }).members[0])
    const sum = (f: (m: (typeof rs)[number]) => number): number => rs.reduce((a, m) => a + f(m), 0)
    const n = rs.length
    const turns = Math.max(1, sum((m) => m.stats.turns))
    const killers: Record<string, number> = {}
    for (const m of rs) if (m.stats.killedBy) killers[m.stats.killedBy] = (killers[m.stats.killedBy] ?? 0) + 1
    const top = Object.entries(killers).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ')
    const score = mean(rs.map((m) => m.depthReached * 12 + (m.won ? 40 : 0) + (m.alive ? 15 : -30) + m.charLevel))
    log(`| ${c} | ${score.toFixed(1)} | ${rs.filter((m) => m.won).length} | ${(sum((m) => m.depthReached) / n).toFixed(1)} | ${(sum((m) => m.charLevel) / n).toFixed(1)} | ${(sum((m) => m.stats.fights) / n).toFixed(1)} | ${(sum((m) => m.stats.foesFaced) / Math.max(1, sum((m) => m.stats.fights))).toFixed(2)} | ${(100 * sum((m) => m.stats.idleTurns) / turns).toFixed(0)}% / ${(100 * sum((m) => m.stats.retreatTurns) / turns).toFixed(0)}% | ${(100 * sum((m) => m.stats.surprisedTurns) / (turns + sum((m) => m.stats.surprisedTurns))).toFixed(0)}% | ${(sum((m) => m.stats.slotsSpent) / n).toFixed(1)} | ${(sum((m) => m.stats.potionsUsed) / n).toFixed(2)} | ${top} |`)
  }
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  switch (args._[0]) {
    case 'train': return train(args)
    case 'bench': return bench(args)
    case 'validate': return validate(args)
    case 'speed': return speed(args)
    case 'report': return report()
    default:
      log('usage: dungeon-gym <train|bench|validate|speed|report> [options] (see cli/main.ts)')
      process.exitCode = args._[0] ? 1 : 0
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
