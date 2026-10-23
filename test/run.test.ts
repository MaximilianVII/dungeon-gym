import { describe, it, expect } from 'vitest'
import {
  STEPS_PER_LEVEL, cloneRunState, createRun, isRunDone, playRun, runResult, runSnapshot, runToEnd, stepRun, type RunConfig, type RunState,
} from '../src/bot/run'
import { baselineGenome, makeGenome, type Genome } from '../src/bot/genome'
import { starterSpec, type ClassKey } from '../src/character/build'
import { aggregate, resultsCSV, totals } from '../src/bot/stats'

function solo(cls: ClassKey, seed: number, depth = 3, genome: Genome = baselineGenome(cls)): RunConfig {
  return { seed, depth, party: [{ genome }] }
}

/** Play to the end, cloning the state through JSON after `k` steps. */
function playWithRoundTrip(config: RunConfig, k: number): RunState {
  let s = createRun(config)
  for (let i = 0; i < k && !isRunDone(s); i++) stepRun(s)
  s = JSON.parse(JSON.stringify(s)) as RunState
  runToEnd(s)
  return s
}

describe('determinism', () => {
  it('the same seed and genome give an identical run (state and result)', () => {
    for (const cls of ['fighter', 'wizard', 'cleric'] as ClassKey[]) {
      const a = createRun(solo(cls, 4242))
      const b = createRun(solo(cls, 4242))
      expect(runToEnd(a)).toEqual(runToEnd(b))
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    }
  })

  it('a JSON round-trip of the state at any step (incl. mid-fight) continues identically', () => {
    const config = solo('fighter', 7919, 4)
    const reference = createRun(config)
    const phases: string[] = []
    while (!isRunDone(reference)) {
      phases.push(reference.phase)
      stepRun(reference)
    }
    const refJson = JSON.stringify(reference)
    const firstFight = phases.indexOf('combat')
    expect(firstFight).toBeGreaterThan(0)
    const checkpoints = [0, 1, 2, firstFight, firstFight + 3, Math.floor(phases.length / 2), phases.length - 1]
    for (const k of checkpoints) expect(JSON.stringify(playWithRoundTrip(config, k))).toBe(refJson)
  })

  it('the run state is plain JSON (no Set/Map/functions/undefined-only holes)', () => {
    const s = createRun(solo('rogue', 3))
    for (let i = 0; i < 200 && !isRunDone(s); i++) stepRun(s)
    const visit = (v: unknown): void => {
      if (v === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof v)) return
      expect(typeof v).toBe('object')
      expect(v instanceof Set || v instanceof Map).toBe(false)
      if (Array.isArray(v)) v.forEach(visit)
      else {
        expect(Object.getPrototypeOf(v)).toBe(Object.prototype)
        Object.values(v as object).forEach(visit)
      }
    }
    visit(s)
  })

  it('different seeds give different dungeons', () => {
    const results = [1, 2, 3, 4, 5].map((seed) => JSON.stringify(playRun(solo('fighter', seed))))
    expect(new Set(results).size).toBeGreaterThan(1)
  })

  it('runs are independent: interleaving two runs changes nothing', () => {
    const a = createRun(solo('paladin', 11))
    const b = createRun(solo('ranger', 12))
    while (!isRunDone(a) || !isRunDone(b)) {
      stepRun(a)
      stepRun(b)
    }
    expect(runResult(a)).toEqual(playRun(solo('paladin', 11)))
    expect(runResult(b)).toEqual(playRun(solo('ranger', 12)))
  })
})

describe('run rules', () => {
  it('hitting the step cap is a LOSS, even on the last level (legacy counted it as a win)', () => {
    const s = createRun(solo('fighter', 5, 1))
    expect(s.maxSteps).toBe(STEPS_PER_LEVEL)
    s.maxSteps = 3
    const r = runToEnd(s)
    expect(s.levelIndex).toBe(s.depth - 1) // on the last (only) level
    expect(r.endReason).toBe('step-cap')
    expect(r.won).toBe(false)
    expect(r.members[0].alive).toBe(false)
  })

  it('a finished run ignores further steps; runToEnd can stop early', () => {
    const s = createRun(solo('wizard', 9, 2))
    const partial = runToEnd(s, 5)
    expect(partial.steps).toBe(5)
    expect(isRunDone(s)).toBe(false)
    const r = runToEnd(s)
    const json = JSON.stringify(s)
    stepRun(s)
    expect(JSON.stringify(s)).toBe(json)
    expect(r.endReason).not.toBeNull()
  })

  it('reports depth, levels and outcome consistently', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const r = playRun(solo('barbarian', seed, 3))
      const m = r.members[0]
      expect(r.depthReached).toBe(m.depthReached)
      expect(m.charLevel).toBeGreaterThanOrEqual(5)
      if (r.won) {
        expect(r.endReason).toBe('won')
        expect(m.depthReached).toBe(3)
      } else {
        expect(['wiped', 'step-cap', 'stuck']).toContain(r.endReason)
        expect(m.deathLevel).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('plays a party; enemies scale with party size', () => {
    const s = createRun({ seed: 77, depth: 2, party: [{ genome: baselineGenome('fighter') }, { genome: baselineGenome('cleric') }, { genome: baselineGenome('wizard'), name: 'Zed' }] })
    expect(s.enemyScale).toBe(3)
    const r = runToEnd(s)
    expect(r.partySize).toBe(3)
    expect(r.members.map((m) => m.classKey)).toEqual(['fighter', 'cleric', 'wizard'])
    expect(r.members[2].name).toBe('Zed')
  })

  it('validates its inputs', () => {
    expect(() => createRun({ seed: 1, party: [] })).toThrow(/party size/)
    const g = baselineGenome('fighter')
    expect(() => createRun({ seed: 1, party: Array(6).fill({ genome: g }) })).toThrow(/party size/)
    const broken = { ...g, genes: { ...g.genes, kite: 7 } }
    expect(() => createRun({ seed: 1, party: [{ genome: broken }] })).toThrow(/invalid genome/)
    expect(() => createRun({ seed: 1, party: [{ genome: g, spec: starterSpec('wizard') }] })).toThrow(/genome is for fighter/)
  })

  it('the exploreCoverage gene changes how much of a level the party sweeps', () => {
    const steps = (exploreCoverage: number): number => {
      const g = makeGenome('fighter', { ...baselineGenome('fighter').genes, exploreCoverage })
      const s = createRun(solo('fighter', 31, 1, g))
      let explore = 0
      while (!isRunDone(s)) {
        if (s.phase === 'explore') explore++
        stepRun(s)
      }
      return s.seenCount / Math.max(1, s.reachableFloor) + explore * 0
    }
    expect(steps(0.95)).toBeGreaterThan(steps(0.3))
  })
})

describe('level-ups follow the genome', () => {
  function findLevelling(genome: Genome, minLevel: number): RunState {
    for (let seed = 1; seed <= 60; seed++) {
      const s = createRun({ seed, depth: 8, party: [{ genome }] })
      runToEnd(s)
      if (s.members[0].spec.classLevels && Object.values(s.members[0].spec.classLevels).reduce((a, b) => a + b, 0) >= minLevel) return s
    }
    throw new Error('no levelling seed found')
  }

  it('takes levels in the ordered class and gains its abilities', () => {
    const g = makeGenome('fighter', { ...baselineGenome('fighter').genes, levelUpOrder: ['rogue', 'rogue'] })
    const s = findLevelling(g, 7)
    const m = s.members[0]
    expect(m.spec.classLevels.rogue).toBe(2)
    expect(m.battler.abilities).toContain('cunning-dash')
    // Levels beyond the order go to the starting class.
    expect(runResult(s).members[0].classLevels.rogue).toBe(2)
    expect(runResult(s).members[0].classLevels.fighter).toBeGreaterThanOrEqual(5)
  })

  it('falls back to the starting class when prerequisites are not met', () => {
    // The starting fighter has INT 10 — wizard needs INT 13.
    const g = makeGenome('fighter', { ...baselineGenome('fighter').genes, levelUpOrder: ['wizard', 'wizard'] })
    const s = findLevelling(g, 6)
    expect(s.members[0].spec.classLevels.wizard).toBeUndefined()
    expect(s.members[0].spec.classLevels.fighter).toBeGreaterThanOrEqual(6)
  })
})

describe('views', () => {
  it('snapshots exploration and combat', () => {
    const s = createRun(solo('fighter', 7919, 2))
    expect(runSnapshot(s)).toMatchObject({ level: 1, map: null, phase: 'explore' })
    let maxFoesInCombat = 0
    let sawExploreFoes = false
    while (!isRunDone(s)) {
      stepRun(s)
      const snap = runSnapshot(s)
      expect(snap.players).toHaveLength(1)
      if (snap.phase === 'combat') maxFoesInCombat = Math.max(maxFoesInCombat, snap.enemies.length)
      else if (snap.enemies.length > 0) sawExploreFoes = true
    }
    expect(maxFoesInCombat).toBeGreaterThan(0)
    expect(sawExploreFoes).toBe(true)
  })

  it('cloneRunState is a deep copy', () => {
    const s = createRun(solo('monk', 2))
    stepRun(s)
    const c = cloneRunState(s)
    stepRun(c)
    expect(c.steps).toBe(s.steps + 1)
  })

  it('aggregates results into per-class stats and CSV', () => {
    const results = [1, 2, 3].flatMap((seed) => playRun(solo('fighter', seed, 2)).members)
      .concat(playRun(solo('wizard', 1, 2)).members)
    const stats = aggregate(results)
    expect(stats.map((s) => s.classKey).sort()).toEqual(['fighter', 'wizard'])
    expect(stats.find((s) => s.classKey === 'fighter')?.runs).toBe(3)
    expect(totals(results).runs).toBe(4)
    expect(resultsCSV(results).split('\n')).toHaveLength(5)
  })
})
