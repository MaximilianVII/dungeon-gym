import { describe, it, expect } from 'vitest'
import { generateRun } from '../src/dungeon/generate'
import { createRun, isRunDone, runSnapshot, runToEnd, stepRun, type RunState } from '../src/bot/run'
import { baselineGenome } from '../src/bot/genome'
import { BENCHMARK } from '../src/train/evaluate'

describe('encounter groups', () => {
  it('every spawn belongs to a group whose members stand around its leader', () => {
    let biggest = 0
    for (let seed = 1; seed <= 20; seed++) {
      for (const lvl of generateRun(seed * 7919, 5)) {
        const byGroup = new Map<number, typeof lvl.enemies>()
        for (const e of lvl.enemies) {
          expect(Number.isInteger(e.group)).toBe(true)
          byGroup.set(e.group, [...(byGroup.get(e.group) ?? []), e])
        }
        for (const members of byGroup.values()) {
          if (members.some((m) => /warlord|broodmother|lich/.test(m.key))) continue // the boss stands alone
          const lead = members[0]
          for (const m of members) expect(Math.max(Math.abs(m.pos.x - lead.pos.x), Math.abs(m.pos.y - lead.pos.y))).toBeLessThanOrEqual(2)
          biggest = Math.max(biggest, members.length)
        }
      }
    }
    expect(biggest).toBeGreaterThanOrEqual(2)
  })

  it('packs grow with the party size', () => {
    const largest = (scale: number): number => {
      let max = 0
      for (let seed = 1; seed <= 10; seed++) {
        for (const lvl of generateRun(seed, 4, { enemyScale: scale })) {
          const counts: Record<number, number> = {}
          for (const e of lvl.enemies) counts[e.group] = (counts[e.group] ?? 0) + 1
          max = Math.max(max, ...Object.values(counts))
        }
      }
      return max
    }
    expect(largest(4)).toBeGreaterThan(largest(1))
  })

  it('a spotted group is fought together', () => {
    let maxFoes = 0
    for (const seed of BENCHMARK.seeds.slice(0, 6)) {
      const s = createRun({ seed, depth: 3, party: [{ genome: baselineGenome('fighter') }] })
      maxFoes = Math.max(maxFoes, runToEnd(s).members[0].stats.maxFoes)
    }
    expect(maxFoes).toBeGreaterThanOrEqual(2)
  })
})

describe('summoned allies in a run', () => {
  /** Step a druid run until its beasts are in the fight. */
  function untilAllies(): { s: RunState; steps: number } | null {
    for (const seed of BENCHMARK.seeds) {
      const s = createRun({ seed, depth: 6, party: [{ genome: baselineGenome('druid') }] })
      let steps = 0
      while (!isRunDone(s)) {
        stepRun(s)
        steps++
        if ((s.combat?.allies.length ?? 0) > 0) return { s, steps }
      }
    }
    return null
  }

  it('beasts join the fight, show in the snapshot, act and leave with the fight; JSON round-trip is exact', () => {
    const found = untilAllies()
    expect(found).not.toBeNull()
    const { s } = found!
    const c = s.combat!
    expect(c.allies.every((b) => b.team === 'player' && b.summoner === 'p0')).toBe(true)
    expect(c.order).toEqual(expect.arrayContaining(c.allies.map((b) => b.id)))
    expect(runSnapshot(s).allies.length).toBe(c.allies.filter((b) => b.hp > 0).length)
    const copy = JSON.parse(JSON.stringify(s)) as RunState
    runToEnd(s)
    runToEnd(copy)
    expect(JSON.stringify(copy)).toBe(JSON.stringify(s))
    expect(runSnapshot(s).allies).toEqual([])
  })

  it('a solo bot that is down and stable loses the fight at once', () => {
    const s = createRun({ seed: BENCHMARK.seeds[0], depth: 3, party: [{ genome: baselineGenome('wizard') }] })
    while (!isRunDone(s) && s.phase !== 'combat') stepRun(s)
    const b = s.members[0].battler
    b.hp = 0
    b.deathSaves = { successes: 3, failures: 0, stable: true, dead: false }
    stepRun(s)
    expect(isRunDone(s)).toBe(true)
    expect(s.endReason).toBe('wiped')
  })
})
