import { describe, it, expect } from 'vitest'
import { baselineGenome } from '../src/bot/genome'
import { baselineTeam, makeTeam, parseTeam, serializeTeam, teamClasses, teamHash, validateTeam, MAX_TEAM_CHARS } from '../src/bot/team'
import {
  DEFAULT_PARTY, PARTY_BENCHMARK, advancePartyGeneration, benchmarkTeam, createPartyTrainer, evaluatePartyTask, evaluateTeam,
  isPartyGenerationComplete, lastBestTeam, makePartyTrainerConfig, pendingPartyTasks, rankTeams, submitPartyScores, trainPartyGenerations,
} from '../src/train/party'
import { BENCHMARK } from '../src/train/evaluate'

const SMALL = { classKeys: ['fighter', 'cleric'] as const, seed: 5, populationSize: 3, seedsPerGeneration: 1, depth: 1 }

describe('teams', () => {
  it('round-trips through canonical JSON and hashes stably', () => {
    const t = baselineTeam(['fighter', 'cleric', 'wizard'])
    const text = serializeTeam(t)
    const back = parseTeam(text)
    expect(back.ok).toBe(true)
    if (back.ok) {
      expect(serializeTeam(back.team)).toBe(text)
      expect(teamHash(back.team)).toBe(teamHash(t))
      expect(teamClasses(back.team)).toEqual(['fighter', 'cleric', 'wizard'])
    }
    expect(teamHash(baselineTeam(['cleric', 'fighter', 'wizard']))).not.toBe(teamHash(t))
  })

  it('rejects malformed or oversized uploads', () => {
    expect(validateTeam(null).ok).toBe(false)
    expect(validateTeam([]).ok).toBe(false)
    expect(validateTeam({ schema: 'dungeon-gym/team', version: 1, members: [] }).ok).toBe(false)
    expect(validateTeam({ schema: 'dungeon-gym/team', version: 1, members: Array(6).fill(baselineGenome('fighter')) }).ok).toBe(false)
    expect(validateTeam({ schema: 'x', version: 2, members: [baselineGenome('rogue')], extra: 1 })).toMatchObject({ ok: false })
    const bad = validateTeam({ schema: 'dungeon-gym/team', version: 1, members: [baselineGenome('rogue'), { schema: 'dungeon-gym/genome' }] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors.some((e) => e.startsWith('team.members[1].'))).toBe(true)
    expect(parseTeam('{nope').ok).toBe(false)
    expect(parseTeam('x'.repeat(MAX_TEAM_CHARS + 1)).ok).toBe(false)
    expect(parseTeam(42 as unknown as string).ok).toBe(false)
    expect(() => makeTeam([])).toThrow()
  })
})

describe('party evaluation and benchmark', () => {
  it('the party benchmark has its own id and seeds', () => {
    expect(PARTY_BENCHMARK.id).toMatch(/^dungeon-gym\/party-bench-v1@/)
    expect(PARTY_BENCHMARK.id).not.toBe(BENCHMARK.id)
    expect(PARTY_BENCHMARK.seeds.length).toBe(32)
    expect(DEFAULT_PARTY).toEqual(['fighter', 'cleric', 'wizard', 'rogue'])
  })

  it('a team is scored as the mean of its members, deterministically', () => {
    const t = baselineTeam(['fighter', 'cleric'])
    const a = evaluateTeam(t, { seeds: [11, 12], depth: 2 })
    const b = evaluateTeam(t, { seeds: [11, 12], depth: 2 })
    expect(a).toEqual(b)
    expect(a.results[0].partySize).toBe(2)
    expect(() => evaluateTeam({ ...t, members: [] }, { seeds: [1] })).toThrow()
    const bench = benchmarkTeam(t, { ...PARTY_BENCHMARK, seeds: [1, 2], depth: 1 })
    expect(bench.classKeys).toEqual(['fighter', 'cleric'])
    expect(bench.scores.length).toBe(2)
    expect(bench.teamHash).toBe(teamHash(t))
  })
})

describe('party trainer', () => {
  it('validates its config and initial teams', () => {
    expect(() => makePartyTrainerConfig({ classKeys: [], seed: 1 })).toThrow()
    expect(() => makePartyTrainerConfig({ classKeys: ['fighter', 'nope' as never], seed: 1 })).toThrow()
    expect(makePartyTrainerConfig({ classKeys: ['wizard'], seed: 1, populationSize: 999 }).populationSize).toBe(128)
    expect(() => createPartyTrainer({ ...SMALL, classKeys: ['fighter', 'cleric'] }, [baselineTeam(['cleric', 'fighter'])])).toThrow()
    expect(() => createPartyTrainer({ ...SMALL, classKeys: ['fighter', 'cleric'] }, [{ schema: 'dungeon-gym/team', version: 1, members: [] } as never])).toThrow()
    const s = createPartyTrainer({ ...SMALL, classKeys: ['fighter', 'cleric'] }, [baselineTeam(['fighter', 'cleric'])])
    expect(s.population.length).toBe(3)
    expect(s.population.every((i) => teamClasses(i.team).join() === 'fighter,cleric')).toBe(true)
  })

  it('trains deterministically, and the state survives a JSON round-trip', () => {
    const a = trainPartyGenerations(createPartyTrainer({ ...SMALL, classKeys: ['fighter', 'cleric'] }), 2)
    const b = trainPartyGenerations(createPartyTrainer({ ...SMALL, classKeys: ['fighter', 'cleric'] }), 2)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.history.length).toBe(2)
    expect(lastBestTeam(a)?.generation).toBe(1)
    const viaJson = trainPartyGenerations(JSON.parse(JSON.stringify(trainPartyGenerations(createPartyTrainer({ ...SMALL, classKeys: ['fighter', 'cleric'] }), 1))), 1)
    expect(JSON.stringify(viaJson)).toBe(JSON.stringify(a))
  })

  it('rejects stale, unknown, duplicate and malformed submissions', () => {
    let s = createPartyTrainer({ ...SMALL, classKeys: ['fighter', 'cleric'] })
    expect(lastBestTeam(s)).toBeNull()
    const [task] = pendingPartyTasks(s)
    const scores = evaluatePartyTask(task)
    expect(submitPartyScores(s, { generation: 9, individualId: task.individualId, scores }).error).toBe('stale-generation')
    expect(submitPartyScores(s, { generation: 0, individualId: 999, scores }).error).toBe('unknown-individual')
    expect(submitPartyScores(s, { generation: 0, individualId: task.individualId, scores: [Number.NaN] }).error).toBe('bad-scores')
    expect(submitPartyScores(s, null as never).error).toBe('bad-scores')
    s = submitPartyScores(s, { generation: 0, individualId: task.individualId, scores }).state
    expect(submitPartyScores(s, { generation: 0, individualId: task.individualId, scores }).error).toBe('already-scored')
    expect(isPartyGenerationComplete(s)).toBe(false)
    expect(() => advancePartyGeneration(s)).toThrow()
    for (const t of pendingPartyTasks(s)) s = submitPartyScores(s, { generation: 0, individualId: t.individualId, scores: evaluatePartyTask(t) }).state
    expect(rankTeams(s).length).toBe(3)
    expect(advancePartyGeneration(s).generation).toBe(1)
  })
})
