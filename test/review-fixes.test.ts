import { describe, it, expect } from 'vitest'
import { createRun, equipFoundGear, isRunDone, runResult, stepRun, MAX_DEPTH } from '../src/bot/run'
import { baselineGenome, serializeGenome, validateGenome, type Genome } from '../src/bot/genome'
import { starterSpec, validateCharacterSpec } from '../src/character/build'
import { GEAR } from '../src/items/gear'
import { createTrainer, pendingTasks, submitScores, type ScoreSubmission } from '../src/train/trainer'
import { clampReward, DEFAULT_REWARD } from '../src/bot/reward'

const gear = (key: string) => GEAR.find((g) => g.key === key)!

describe('members killed outright leave the party', () => {
  it('a member whose death saves read "dead" is marked dead on the next step (no zombies)', () => {
    const s = createRun({ seed: 77, depth: 3, party: [{ genome: baselineGenome('fighter') }, { genome: baselineGenome('wizard') }] })
    while (!isRunDone(s) && s.phase !== 'combat') stepRun(s)
    expect(s.phase).toBe('combat')
    const wizard = s.members[1]
    wizard.battler.hp = 0
    wizard.battler.deathSaves = { successes: 0, failures: 0, stable: false, dead: true } // e.g. massive damage
    stepRun(s)
    expect(wizard.alive).toBe(false)
    expect(wizard.deathCause).toBe('combat')
    while (!isRunDone(s)) stepRun(s)
    expect(runResult(s).members[1].alive).toBe(false)
  })
})

describe('createRun input validation', () => {
  const genome = baselineGenome('fighter')
  it('rejects non-integer, non-finite or out-of-range depth and seed', () => {
    for (const depth of [Number.NaN, Number.POSITIVE_INFINITY, 0, 2.5, MAX_DEPTH + 1]) {
      expect(() => createRun({ seed: 1, depth, party: [{ genome }] })).toThrow(/depth/)
    }
    expect(() => createRun({ seed: Number.NaN, party: [{ genome }] })).toThrow(/seed/)
  })

  it('rejects absurd character specs', () => {
    const ok = starterSpec('fighter')
    expect(validateCharacterSpec(ok)).toEqual([])
    const bad = [
      { ...ok, classLevels: { fighter: 1e9 } },
      { ...ok, classLevels: { fighter: 5, xwizard: 1 } },
      { ...ok, classLevels: { wizard: 5 } },
      { ...ok, classLevels: { fighter: 15, rogue: 6 } },
      { ...ok, abilityScores: { ...ok.abilityScores, str: Number.NaN } },
      { ...ok, abilityScores: { str: 10 } },
      { ...ok, weapons: ['lightsaber'] },
      { ...ok, weapons: [] },
      { ...ok, armor: 'mithral' },
      { ...ok, shield: 'yes' },
      { ...ok, name: '' },
      { ...ok, extra: 1 },
    ]
    for (const spec of bad) {
      expect(validateCharacterSpec(spec).length).toBeGreaterThan(0)
      expect(() => createRun({ seed: 1, party: [{ genome, spec: spec as typeof ok }] })).toThrow(/invalid character/)
    }
    expect(validateCharacterSpec(null)).toEqual(['spec: expected an object'])
  })
})

describe('found gear', () => {
  it('one item per slot: a second helm or a redundant shield adds nothing', () => {
    const s = createRun({ seed: 1, party: [{ genome: baselineGenome('wizard') }] })
    const m = s.members[0]
    const ac0 = m.battler.ac
    equipFoundGear(m, gear('iron-helm'))
    equipFoundGear(m, gear('iron-helm'))
    expect(m.battler.ac).toBe(ac0 + 1)
    const f = createRun({ seed: 1, party: [{ genome: baselineGenome('fighter') }] }).members[0]
    const fac = f.battler.ac
    equipFoundGear(f, gear('round-shield'))
    expect(f.battler.ac).toBe(fac) // already carries a shield
  })

  it('found armour replaces the sheet armour instead of stacking on it', () => {
    const f = createRun({ seed: 1, party: [{ genome: baselineGenome('fighter') }] }).members[0]
    const ac0 = f.battler.ac // chain mail 16 + Defense + shield = 19
    const hp0 = f.battler.maxHp
    equipFoundGear(f, gear('leather-jerkin'))
    expect(f.battler.ac).toBe(ac0)
    equipFoundGear(f, gear('plate-shard')) // +6 over 10+DEX = chain mail's worth: no gain
    expect(f.battler.ac).toBe(ac0)
    equipFoundGear(f, gear('guardian-plate')) // +8 → +2 over chain mail, +5 HP
    expect(f.battler.ac).toBe(ac0 + 2)
    expect(f.battler.maxHp).toBe(hp0 + 5)
    equipFoundGear(f, gear('guardian-plate'))
    expect(f.battler.maxHp).toBe(hp0 + 5)
  })

  it('weapons are swapped only for a better one', () => {
    const r = createRun({ seed: 1, party: [{ genome: baselineGenome('wizard') }] }).members[0]
    equipFoundGear(r, gear('short-bow'))
    expect(r.equipped.mainHand).toBe('short-bow')
    equipFoundGear(r, gear('great-axe'))
    expect(r.equipped.mainHand).toBe('great-axe')
    equipFoundGear(r, gear('short-bow'))
    expect(r.equipped.mainHand).toBe('great-axe')
  })
})

describe('genome validation reads each field once', () => {
  it('rejects holes in the level-up order', () => {
    const g = JSON.parse(serializeGenome(baselineGenome('fighter'))) as { genes: Record<string, unknown> }
    g.genes.levelUpOrder = new Array(3)
    const r = validateGenome(g)
    expect(r.ok).toBe(false)
  })

  it('returns exactly the values it validated (no getter tricks)', () => {
    const g = JSON.parse(serializeGenome(baselineGenome('fighter'))) as Genome
    let reads = 0
    Object.defineProperty(g.genes, 'kite', { enumerable: true, get: () => (reads++ === 0 ? 0.5 : 99) })
    const r = validateGenome(g)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.genome.genes.kite).toBe(0.5)
  })

  it('escapes attacker-supplied key names in errors', () => {
    const g = JSON.parse(serializeGenome(baselineGenome('fighter'))) as Record<string, unknown>
    g['<script>"x'] = 1
    const r = validateGenome(g)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join()).toContain('"<script>\\"x"')
  })
})

describe('trainer submissions', () => {
  it('rejects null and absurd scores', () => {
    const s = createTrainer({ classKey: 'rogue', seed: 3, populationSize: 3, seedsPerGeneration: 2 })
    const id = pendingTasks(s)[0].individualId
    expect(submitScores(s, null as unknown as ScoreSubmission).error).toBe('bad-scores')
    expect(submitScores(s, { generation: 0, individualId: id, scores: [1e308, 1] }).error).toBe('bad-scores')
    expect(submitScores(s, { generation: 0, individualId: id, scores: [1e6, 1] }).error).toBeUndefined()
  })
})

describe('reward config', () => {
  it('treats an explicit undefined like a missing key', () => {
    expect(clampReward({ depth: undefined }).depth).toBe(DEFAULT_REWARD.depth)
  })
})
