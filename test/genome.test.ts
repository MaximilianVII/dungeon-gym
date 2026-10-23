import { describe, it, expect } from 'vitest'
import {
  GENE_ORDER, MAX_GENOME_CHARS, MAX_LEVEL_UP_ORDER, baselineGenome, clampGenes, crossoverGenomes, describeGenes, genomeHash,
  makeGenome, mutateGenome, parseGenome, relevantGenes, roleOf, serializeGenome, validateGenome, type Genes, type Genome,
} from '../src/bot/genome'
import { CLASS_KEYS } from '../src/character/build'
import { makeRng } from '../src/rng'
import { genes } from './genes'

function raw(g: Genome): Record<string, unknown> {
  return JSON.parse(serializeGenome(g)) as Record<string, unknown>
}

function withGene(g: Genome, key: string, value: unknown): Record<string, unknown> {
  const r = raw(g)
  ;(r.genes as Record<string, unknown>)[key] = value
  return r
}

describe('genome schema', () => {
  it('every class baseline is a valid v1 genome that round-trips through JSON', () => {
    for (const cls of CLASS_KEYS) {
      const g = baselineGenome(cls)
      expect(g).toMatchObject({ schema: 'dungeon-gym/genome', version: 1, classKey: cls })
      const text = serializeGenome(g)
      const back = parseGenome(text)
      expect(back.ok).toBe(true)
      if (back.ok) {
        expect(back.genome).toEqual(g)
        expect(serializeGenome(back.genome)).toBe(text)
      }
    }
  })

  it('serializes canonically: key order is fixed regardless of input order', () => {
    const g = baselineGenome('wizard')
    const shuffled = { genes: { ...g.genes }, classKey: g.classKey, version: g.version, schema: g.schema } as Genome
    expect(serializeGenome(shuffled)).toBe(serializeGenome(g))
    expect(Object.keys(raw(g).genes as object)).toEqual([...GENE_ORDER])
    expect(genomeHash(shuffled)).toBe(genomeHash(g))
    expect(genomeHash(g)).toMatch(/^[0-9a-f]{8}$/)
    expect(genomeHash(baselineGenome('fighter'))).not.toBe(genomeHash(g))
  })

  it('rejects malformed payloads with explicit errors instead of coercing', () => {
    const g = baselineGenome('rogue')
    const bad = (v: unknown): string[] => {
      const r = validateGenome(v)
      expect(r.ok).toBe(false)
      return r.ok ? [] : r.errors
    }
    expect(bad(null)).toEqual(['genome: expected an object'])
    expect(bad([])).toEqual(['genome: expected an object'])
    expect(bad({ ...raw(g), schema: 'other' }).join()).toMatch(/schema/)
    expect(bad({ ...raw(g), version: 2 }).join()).toMatch(/version/)
    expect(bad({ ...raw(g), classKey: 'starfarer' }).join()).toMatch(/classKey/)
    expect(bad({ ...raw(g), extra: 1 }).join()).toMatch(/unknown field "extra"/)
    expect(bad({ ...raw(g), genes: 5 }).join()).toMatch(/genes: expected an object/)
    const missing = raw(g)
    delete (missing.genes as Record<string, unknown>).kite
    expect(bad(missing).join()).toMatch(/missing field "kite"/)
    expect(bad(withGene(g, 'mystery', 1)).join()).toMatch(/unknown field "mystery"/)
    expect(bad(withGene(g, 'healAtHpFrac', 2)).join()).toMatch(/outside/)
    expect(bad(withGene(g, 'healAtHpFrac', Number.NaN)).join()).toMatch(/finite number/)
    expect(bad(withGene(g, 'healAtHpFrac', '0.5')).join()).toMatch(/finite number/)
    expect(bad(withGene(g, 'patientDefenseAdj', 2.5)).join()).toMatch(/integer/)
    expect(bad(withGene(g, 'openWithRage', 'yes')).join()).toMatch(/boolean/)
    expect(bad(withGene(g, 'levelUpOrder', 'fighter')).join()).toMatch(/array/)
    expect(bad(withGene(g, 'levelUpOrder', ['fighter', 'starfarer'])).join()).toMatch(/levelUpOrder\[1\]/)
    expect(bad(withGene(g, 'levelUpOrder', Array(MAX_LEVEL_UP_ORDER + 1).fill('fighter'))).join()).toMatch(/at most/)
  })

  it('parseGenome rejects bad JSON, oversize payloads and prototype keys', () => {
    expect(parseGenome('{nope').ok).toBe(false)
    expect(parseGenome('x'.repeat(MAX_GENOME_CHARS + 1))).toEqual({ ok: false, errors: [`genome: payload exceeds ${MAX_GENOME_CHARS} characters`] })
    const text = serializeGenome(baselineGenome('monk')).replace('"genes":{', '"genes":{"__proto__":{"polluted":true},')
    const r = parseGenome(text)
    expect(r.ok).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(parseGenome(42 as unknown as string).ok).toBe(false)
  })

  it('clampGenes is the lenient path (UI/mutation): clamps, coerces, filters', () => {
    const c = clampGenes({ ...genes(), healAtHpFrac: 5, kite: Number.NaN, patientDefenseAdj: 2.6, openWithRage: 0 as unknown as boolean, levelUpOrder: ['FIGHTER', 'nope', 3] as unknown as Genes['levelUpOrder'] })
    expect(c).toMatchObject({ healAtHpFrac: 0.9, kite: 0, patientDefenseAdj: 3, openWithRage: false, levelUpOrder: ['fighter'] })
    expect(clampGenes({ ...genes(), levelUpOrder: undefined as unknown as Genes['levelUpOrder'] }).levelUpOrder).toEqual([])
  })
})

describe('relevance', () => {
  it('only includes genes the class (or its level-up order) can express', () => {
    const wizard = relevantGenes(baselineGenome('wizard'))
    expect(wizard).toContain('slotReserve')
    expect(wizard).not.toContain('openWithRage')
    expect(wizard).not.toContain('secondWindAtHpFrac')
    expect(wizard).not.toContain('regroup')
    const fighter = relevantGenes(baselineGenome('fighter'))
    expect(fighter).toEqual(expect.arrayContaining(['secondWindAtHpFrac', 'actionSurgeEarly']))
    expect(fighter).not.toContain('slotReserve')
    expect(fighter).not.toContain('potionFirst')
    const dipper = makeGenome('wizard', { ...baselineGenome('wizard').genes, levelUpOrder: ['fighter'] })
    expect(relevantGenes(dipper)).toContain('secondWindAtHpFrac')
    expect(relevantGenes(baselineGenome('cleric'), { party: true })).toEqual(expect.arrayContaining(['regroup', 'healAllies']))
    expect(relevantGenes(baselineGenome('monk'))).toContain('patientDefenseAdj')
    expect(relevantGenes(baselineGenome('barbarian'))).toContain('openWithRage')
    expect(relevantGenes(baselineGenome('bard'))).toContain('inspireBeforeAttack')
  })
})

describe('mutation + crossover', () => {
  it('is deterministic for a given RNG and never mutates its input', () => {
    const g = baselineGenome('ranger')
    const before = serializeGenome(g)
    expect(mutateGenome(g, makeRng(5))).toEqual(mutateGenome(g, makeRng(5)))
    expect(serializeGenome(g)).toBe(before)
  })

  it('never touches genes the class cannot express', () => {
    const base = baselineGenome('wizard')
    for (let i = 0; i < 300; i++) {
      const m = mutateGenome(base, makeRng(i))
      for (const k of ['openWithRage', 'actionSurgeEarly', 'inspireBeforeAttack', 'secondWindAtHpFrac', 'patientDefenseAdj', 'regroup', 'healAllies'] as const) {
        expect(m.genes[k]).toBe(base.genes[k])
      }
    }
  })

  it('always yields valid genomes, and the level-up order can grow and shrink', () => {
    let g = makeGenome('fighter', { ...baselineGenome('fighter').genes, levelUpOrder: ['rogue', 'rogue', 'rogue'] })
    const rng = makeRng(99)
    const lengths = new Set<number>()
    for (let i = 0; i < 600; i++) {
      g = mutateGenome(g, rng)
      expect(validateGenome(g).ok).toBe(true)
      lengths.add(g.genes.levelUpOrder.length)
    }
    expect(Math.min(...lengths)).toBeLessThan(3)
    expect(Math.max(...lengths)).toBeGreaterThan(3)
  })

  it('crossover mixes parent genes and refuses mixed classes', () => {
    const a = makeGenome('rogue', { ...baselineGenome('rogue').genes, kite: 0, aggression: 0, levelUpOrder: ['fighter'] })
    const b = makeGenome('rogue', { ...baselineGenome('rogue').genes, kite: 1, aggression: 1, levelUpOrder: [] })
    const kids = Array.from({ length: 40 }, (_, i) => crossoverGenomes(a, b, makeRng(i)))
    for (const k of kids) {
      expect([0, 1]).toContain(k.genes.kite)
      expect(validateGenome(k).ok).toBe(true)
    }
    expect(new Set(kids.map((k) => k.genes.kite)).size).toBe(2)
    expect(new Set(kids.map((k) => k.genes.levelUpOrder.length)).size).toBe(2)
    expect(() => crossoverGenomes(a, baselineGenome('wizard'), makeRng(1))).toThrow(/class mismatch/)
  })
})

describe('views', () => {
  it('roleOf picks the strongest lean; describeGenes renders rule lines', () => {
    expect(roleOf(genes({ healAllies: 0.9, protectAllies: 0.1, aggression: 0.1, kite: 0.1 }))).toBe('support')
    expect(roleOf(genes({ healAllies: 0.1, protectAllies: 0.9, aggression: 0.1, kite: 0.1 }))).toBe('tank')
    expect(roleOf(genes({ healAllies: 0.1, protectAllies: 0.1, aggression: 0.1, kite: 0.9 }))).toBe('skirmisher')
    const lines = describeGenes(genes({ kite: 0.9, levelUpOrder: ['fighter', 'wizard'] }))
    expect(lines.join('\n')).toMatch(/keeps range/)
    expect(lines.join('\n')).toMatch(/F·W/)
    expect(describeGenes(genes({ kite: 0.1, potionFirst: true })).join('\n')).toMatch(/charges into melee[\s\S]*|potion first/)
  })
})
