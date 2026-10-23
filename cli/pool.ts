import { Worker } from 'node:worker_threads'
import { evaluateGenome } from '../src/train/evaluate'
import { advanceGeneration, pendingTasks, submitScores, type TrainerState } from '../src/train/trainer'
import type { Genome } from '../src/bot/genome'
import type { RewardConfig } from '../src/bot/reward'

// ---------------------------------------------------------------------------
// Parallel evaluation for the Node trainer. The unit of work is ONE run
// (genome × seed); results are placed back by index, so the outcome never
// depends on how many workers there are or in which order they finish.
// ---------------------------------------------------------------------------

export interface EvalUnit {
  genome: Genome
  seed: number
  depth: number
  reward: RewardConfig
}

export interface UnitResult {
  score: number
  won: boolean
}

export interface Evaluator {
  evaluate(units: readonly EvalUnit[]): Promise<UnitResult[]>
  close(): Promise<void>
}

/** Play and score one unit (what a worker does). */
export function scoreUnit(u: EvalUnit): UnitResult {
  const ev = evaluateGenome(u.genome, { seeds: [u.seed], depth: u.depth, reward: u.reward })
  return { score: ev.scores[0], won: ev.results[0].won }
}

/** Single-threaded evaluator (also the reference for determinism tests). */
export function createInlineEvaluator(): Evaluator {
  return {
    evaluate: async (units) => units.map(scoreUnit),
    close: async () => undefined,
  }
}

interface Job {
  start: number
  units: readonly EvalUnit[]
}

/** A pool of `size` worker threads running `workerUrl` (see cli/worker.ts). */
export function createWorkerPool(size: number, workerUrl: URL): Evaluator {
  const workers = Array.from({ length: Math.max(1, size) }, () => new Worker(workerUrl))
  return {
    evaluate(units) {
      if (units.length === 0) return Promise.resolve([])
      const out = new Array<UnitResult>(units.length)
      const chunk = Math.max(1, Math.ceil(units.length / (workers.length * 4)))
      const jobs: Job[] = []
      for (let i = 0; i < units.length; i += chunk) jobs.push({ start: i, units: units.slice(i, i + chunk) })
      let next = 0
      let done = 0
      return new Promise((resolve, reject) => {
        const feed = (w: Worker): void => {
          if (next >= jobs.length) return
          const job = jobs[next++]
          const onError = (err: Error): void => {
            w.off('message', onMessage)
            reject(err)
          }
          const onMessage = (msg: { results: UnitResult[] }): void => {
            w.off('error', onError)
            msg.results.forEach((r, k) => { out[job.start + k] = r })
            if (++done === jobs.length) resolve(out)
            else feed(w)
          }
          w.once('message', onMessage)
          w.once('error', onError)
          w.postMessage({ units: job.units })
        }
        for (const w of workers) feed(w)
      })
    },
    async close() {
      await Promise.all(workers.map((w) => w.terminate()))
    },
  }
}

/** Evaluate + advance `generations` times with any evaluator. */
export async function trainWith(
  state: TrainerState,
  generations: number,
  evaluator: Evaluator,
  onGeneration?: (s: TrainerState) => void,
): Promise<TrainerState> {
  let s = state
  for (let g = 0; g < generations; g++) {
    const tasks = pendingTasks(s)
    const units = tasks.flatMap((t) => t.seeds.map((seed) => ({ genome: t.genome, seed, depth: t.depth, reward: t.reward })))
    const results = await evaluator.evaluate(units)
    let k = 0
    for (const t of tasks) {
      const scores = results.slice(k, k + t.seeds.length).map((r) => r.score)
      k += t.seeds.length
      const res = submitScores(s, { generation: t.generation, individualId: t.individualId, scores })
      if (res.error) throw new Error(`submission rejected: ${res.error}`)
      s = res.state
    }
    s = advanceGeneration(s)
    onGeneration?.(s)
  }
  return s
}
