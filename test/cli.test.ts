import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInlineEvaluator, scoreUnit, trainWith, type Evaluator } from '../cli/pool'
import { createTrainer, trainGenerations, evaluateTask, type EvalTask } from '../src/train/trainer'
import { baselineGenome, parseGenome, serializeGenome } from '../src/bot/genome'

const OPTS = { classKey: 'fighter' as const, seed: 9, populationSize: 4, seedsPerGeneration: 2, depth: 2 }

describe('trainWith (pool-driven training)', () => {
  it('matches the synchronous trainer exactly', async () => {
    const viaPool = await trainWith(createTrainer(OPTS), 3, createInlineEvaluator())
    const sync = trainGenerations(createTrainer(OPTS), 3, (t: EvalTask) => evaluateTask(t))
    expect(JSON.stringify(viaPool)).toBe(JSON.stringify(sync))
  })

  it('does not depend on the order in which units finish', async () => {
    const reversed: Evaluator = {
      evaluate: async (units) => {
        const out = new Array(units.length)
        for (let i = units.length - 1; i >= 0; i--) out[i] = scoreUnit(units[i])
        return out
      },
      close: async () => undefined,
    }
    const a = await trainWith(createTrainer(OPTS), 2, reversed)
    const b = await trainWith(createTrainer(OPTS), 2, createInlineEvaluator())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('dungeon-gym CLI (built bundle, real worker_threads)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dungeon-gym-cli-'))
  const cli = join(dir, 'cli.mjs')
  const run = (...args: string[]): string => execFileSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' })

  beforeAll(() => {
    execFileSync(process.execPath, [join(__dirname, '..', 'scripts', 'build.mjs'), dir])
  }, 60_000)

  it('train gives the same genome with 1 and with 3 workers', () => {
    const common = ['train', '--class', 'wizard', '--generations', '2', '--population', '4', '--seeds', '3', '--depth', '2', '--seed', '42']
    run(...common, '--workers', '1', '--out', 'one.json', '--curve', 'one.csv')
    run(...common, '--workers', '3', '--out', 'three.json', '--curve', 'three.csv')
    const one = readFileSync(join(dir, 'one.json'), 'utf8')
    expect(readFileSync(join(dir, 'three.json'), 'utf8')).toBe(one)
    expect(readFileSync(join(dir, 'three.csv'), 'utf8')).toBe(readFileSync(join(dir, 'one.csv'), 'utf8'))
    expect(parseGenome(one).ok).toBe(true)
  }, 60_000)

  it('validate accepts a genome and rejects a broken one', () => {
    writeFileSync(join(dir, 'ok.json'), serializeGenome(baselineGenome('rogue')))
    expect(run('validate', 'ok.json')).toMatch(/^ok rogue [0-9a-f]{8}/)
    writeFileSync(join(dir, 'bad.json'), '{"schema":"dungeon-gym/genome","version":2}')
    expect(() => run('validate', 'bad.json')).toThrow()
  })

  it('bench scores a genome on the official benchmark (same with 1 or 2 workers)', () => {
    const one = JSON.parse(run('bench', 'ok.json', '--workers', '1')) as { score: number; classKey: string }
    const two = JSON.parse(run('bench', 'ok.json', '--workers', '2')) as { score: number }
    expect(one.classKey).toBe('rogue')
    expect(two.score).toBe(one.score)
  }, 60_000)
})
