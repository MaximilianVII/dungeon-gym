import type { MemberResult } from './run'

// ---------------------------------------------------------------------------
// Aggregate finished bot runs into per-class statistics:
// runs, wins, deaths, average + deepest depth, and a death-by-level breakdown.
// Sorted by death rate (who dies most first) so "which class dies more / less"
// reads straight off the top and bottom of the table. Pure.
// ---------------------------------------------------------------------------

export interface ClassStat {
  classKey: string
  runs: number
  wins: number
  deaths: number
  /** Deaths / runs, 0..1. */
  deathRate: number
  /** Wins / runs, 0..1. */
  winRate: number
  avgDepth: number
  deepest: number
  /** Total damage dealt by this class across all its runs. */
  damage: number
  /** Total enemies killed by this class. */
  kills: number
  /** Total HP healed (self + allies) by this class. */
  healing: number
  /** Death count per dungeon level (index 0 = level 1). */
  deathByLevel: number[]
}

export function aggregate(results: MemberResult[]): ClassStat[] {
  const byClass = new Map<string, MemberResult[]>()
  for (const r of results) {
    const list = byClass.get(r.classKey) ?? []
    list.push(r)
    byClass.set(r.classKey, list)
  }
  const out: ClassStat[] = []
  for (const [classKey, rs] of byClass) {
    const runs = rs.length
    const wins = rs.filter((r) => r.won).length
    const deaths = rs.filter((r) => !r.alive).length
    const avgDepth = rs.reduce((s, r) => s + r.depthReached, 0) / runs
    const deepest = rs.reduce((m, r) => Math.max(m, r.depthReached), 0)
    const damage = rs.reduce((s, r) => s + (r.damage ?? 0), 0)
    const kills = rs.reduce((s, r) => s + (r.kills ?? 0), 0)
    const healing = rs.reduce((s, r) => s + (r.healing ?? 0), 0)
    const deathByLevel: number[] = []
    for (const r of rs) {
      if (!r.alive && r.deathLevel) {
        const i = r.deathLevel - 1
        deathByLevel[i] = (deathByLevel[i] ?? 0) + 1
      }
    }
    out.push({ classKey, runs, wins, deaths, deathRate: deaths / runs, winRate: wins / runs, avgDepth, deepest, damage, kills, healing, deathByLevel })
  }
  out.sort((a, b) => b.deathRate - a.deathRate || b.avgDepth - a.avgDepth)
  return out
}

export interface Totals {
  runs: number
  wins: number
  deaths: number
}

export function totals(results: MemberResult[]): Totals {
  return {
    runs: results.length,
    wins: results.filter((r) => r.won).length,
    deaths: results.filter((r) => !r.alive).length,
  }
}

/** Per-run rows in completion order — plot depth vs run# per class to see the
 *  learning progression. */
export function resultsCSV(results: MemberResult[]): string {
  const header = 'run,class,depthReached,charLevel,won,alive,deathLevel,deathCause,damage,healing,kills'
  const rows = results.map((r, i) =>
    [i + 1, r.classKey, r.depthReached, r.charLevel, r.won ? 1 : 0, r.alive ? 1 : 0, r.deathLevel ?? '', r.deathCause ?? '', r.damage, r.healing, r.kills].join(','),
  )
  return [header, ...rows].join('\n')
}
