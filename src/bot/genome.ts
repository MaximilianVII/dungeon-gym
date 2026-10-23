import { CLASS_KEYS, isClassKey, type ClassKey } from '../character/build'
import { hashString, type Rng } from '../rng'
import { deepFreeze } from '../freeze'

// ---------------------------------------------------------------------------
// A bot GENOME — the uploadable artifact. One genome = one class's complete
// playstyle: the tactical knobs the combat policy reads (bot/policy), the role
// leanings, the exploration appetite, and the class order for mid-run level-ups.
//
//   { "schema": "dungeon-gym/genome", "version": 1, "classKey": "wizard",
//     "genes": { ... } }
//
// Two entry points with deliberately different strictness:
//   • parseGenome / validateGenome — STRICT, for anything coming from outside
//     (uploads, files). Unknown/missing fields, wrong types, out-of-range or
//     non-finite numbers, unknown classes and oversize payloads are rejected
//     with a list of errors — never silently coerced.
//   • clampGenes — LENIENT, for UI sliders and the mutation operators.
// serializeGenome emits canonical JSON (fixed key order), so equal genomes
// always produce equal bytes and equal `genomeHash`es.
// ---------------------------------------------------------------------------

export const GENOME_SCHEMA = 'dungeon-gym/genome'
export const GENOME_VERSION = 1
/** Hard cap on a serialized genome (bytes of UTF-16 code units ≈ bytes for ASCII JSON). */
export const MAX_GENOME_CHARS = 4096
/** Level-ups available from the starting level 5 to the cap of 20. */
export const MAX_LEVEL_UP_ORDER = 15

export interface Genes {
  /** Heal (spell or potion) below this fraction of max HP. */
  healAtHpFrac: number
  /** Fighter: Second Wind below this fraction of max HP. */
  secondWindAtHpFrac: number
  /** Retreat below this fraction of max HP (scaled down by aggression). */
  retreatAtHpFrac: number
  /** Ranged stance: keeps range when kite − 0.4·aggression − 0.3·protect ≥ 0.5. */
  kite: number
  /** Monk: Patient Defense when at least this many foes are adjacent (minus 2·protect). */
  patientDefenseAdj: number
  /** Barbarian: uses Rage at all (false = never rages). */
  openWithRage: boolean
  /** Bard: spends Bardic Inspiration before attacking. */
  inspireBeforeAttack: boolean
  /** Fighter: Action Surge as soon as in melee (vs. only to finish a low foe). */
  actionSurgeEarly: boolean
  /** Target the lowest-HP foe (focus fire) instead of the nearest. */
  focusWeakest: boolean
  /** When low, drink a potion before trying a heal spell. */
  potionFirst: boolean
  /** Probability per turn of targeting enemy casters/healers first. */
  focusCasters: number
  /** Probability per turn of holding leveled spells while no boss is present. */
  slotReserve: number
  /** Party: probability per turn that a retreat falls back toward an ally. */
  regroup: number
  /** Party: priority to heal a wounded ally (gate > 0.45, threshold 0.35 + 0.4·g). */
  healAllies: number
  /** Hold the line: lowers effective kite, dodges sooner. */
  protectAllies: number
  /** Press the attack: lowers effective kite and retreat threshold. */
  aggression: number
  /** Fraction of a level's reachable floor to see before heading for the exit. */
  exploreCoverage: number
  /** Class taken at each mid-run level-up (index 0 = first level-up); empty = monoclass. */
  levelUpOrder: ClassKey[]
}

export interface Genome {
  schema: typeof GENOME_SCHEMA
  version: typeof GENOME_VERSION
  classKey: ClassKey
  genes: Genes
}

type NumericGene = 'healAtHpFrac' | 'secondWindAtHpFrac' | 'retreatAtHpFrac' | 'kite' | 'patientDefenseAdj' | 'focusCasters' | 'slotReserve' | 'regroup' | 'healAllies' | 'protectAllies' | 'aggression' | 'exploreCoverage'
type BooleanGene = 'openWithRage' | 'inspireBeforeAttack' | 'actionSurgeEarly' | 'focusWeakest' | 'potionFirst'
export type GeneKey = NumericGene | BooleanGene | 'levelUpOrder'

interface NumericSpec {
  min: number
  max: number
  integer?: boolean
  /** Largest single mutation step (the jitter's standard deviation is step / 3). */
  step: number
}

export const NUMERIC_GENES: Record<NumericGene, NumericSpec> = deepFreeze({
  healAtHpFrac: { min: 0, max: 0.9, step: 0.12 },
  secondWindAtHpFrac: { min: 0, max: 0.9, step: 0.12 },
  retreatAtHpFrac: { min: 0, max: 0.6, step: 0.08 },
  kite: { min: 0, max: 1, step: 0.15 },
  patientDefenseAdj: { min: 1, max: 4, integer: true, step: 1 },
  focusCasters: { min: 0, max: 1, step: 0.15 },
  slotReserve: { min: 0, max: 1, step: 0.15 },
  regroup: { min: 0, max: 1, step: 0.15 },
  healAllies: { min: 0, max: 1, step: 0.12 },
  protectAllies: { min: 0, max: 1, step: 0.12 },
  aggression: { min: 0, max: 1, step: 0.12 },
  exploreCoverage: { min: 0.3, max: 0.95, step: 0.08 },
})

export const BOOLEAN_GENES: readonly BooleanGene[] = ['openWithRage', 'inspireBeforeAttack', 'actionSurgeEarly', 'focusWeakest', 'potionFirst']

/** Canonical gene order (serialization + crossover). */
export const GENE_ORDER: readonly GeneKey[] = [
  'healAtHpFrac', 'secondWindAtHpFrac', 'retreatAtHpFrac', 'kite', 'patientDefenseAdj',
  'openWithRage', 'inspireBeforeAttack', 'actionSurgeEarly', 'focusWeakest', 'potionFirst',
  'focusCasters', 'slotReserve', 'regroup', 'healAllies', 'protectAllies', 'aggression',
  'exploreCoverage', 'levelUpOrder',
]

export const DEFAULT_GENES: Genes = deepFreeze({
  healAtHpFrac: 0.35,
  secondWindAtHpFrac: 0.5,
  retreatAtHpFrac: 0.15,
  kite: 0.5,
  patientDefenseAdj: 2,
  openWithRage: true,
  inspireBeforeAttack: true,
  actionSurgeEarly: true,
  focusWeakest: true,
  potionFirst: false,
  focusCasters: 0.4,
  slotReserve: 0.4,
  regroup: 0.5,
  healAllies: 0.5,
  protectAllies: 0.5,
  aggression: 0.5,
  exploreCoverage: 0.65,
  levelUpOrder: [],
})

// Per-class starting knowledge (ported from the legacy strategies/*.json).
const BASELINES: Record<ClassKey, Partial<Genes>> = {
  barbarian: { kite: 0.05, openWithRage: true, healAtHpFrac: 0.3, retreatAtHpFrac: 0.1, focusWeakest: true },
  bard: { kite: 0.55, inspireBeforeAttack: true, healAtHpFrac: 0.45 },
  cleric: { kite: 0.55, healAtHpFrac: 0.5, potionFirst: false },
  druid: { kite: 0.6, healAtHpFrac: 0.45 },
  fighter: { kite: 0.12, healAtHpFrac: 0.4, secondWindAtHpFrac: 0.55, actionSurgeEarly: true, focusWeakest: true },
  monk: { kite: 0.2, patientDefenseAdj: 2, healAtHpFrac: 0.4 },
  paladin: { kite: 0.15, healAtHpFrac: 0.45, focusWeakest: true },
  ranger: { kite: 0.7, healAtHpFrac: 0.4, focusWeakest: true },
  rogue: { kite: 0.4, healAtHpFrac: 0.4, retreatAtHpFrac: 0.25, focusWeakest: true },
  sorcerer: { kite: 0.85, healAtHpFrac: 0.4, retreatAtHpFrac: 0.22, focusWeakest: true },
  warlock: { kite: 0.8, healAtHpFrac: 0.4, retreatAtHpFrac: 0.2, focusWeakest: true },
  wizard: { kite: 0.9, healAtHpFrac: 0.45, retreatAtHpFrac: 0.25, focusWeakest: true },
}

function copyGenes(g: Genes): Genes {
  return { ...g, levelUpOrder: [...g.levelUpOrder] }
}

/** The bundled starting genome for a class. */
export function baselineGenome(classKey: ClassKey): Genome {
  return makeGenome(classKey, { ...copyGenes(DEFAULT_GENES), ...BASELINES[classKey] })
}

/** Wrap genes into a genome (genes are clamped). */
export function makeGenome(classKey: ClassKey, genes: Genes): Genome {
  return { schema: GENOME_SCHEMA, version: GENOME_VERSION, classKey, genes: clampGenes(genes) }
}

function clampNum(v: number, spec: NumericSpec): number {
  if (!Number.isFinite(v)) return spec.min
  const c = Math.max(spec.min, Math.min(spec.max, v))
  return spec.integer ? Math.round(c) : c
}

/** LENIENT normalisation for UI and mutation: clamp numbers, coerce booleans, filter the order. */
export function clampGenes(g: Genes): Genes {
  const out: Genes = { ...g, levelUpOrder: [] }
  for (const k of Object.keys(NUMERIC_GENES) as NumericGene[]) out[k] = clampNum(g[k], NUMERIC_GENES[k])
  for (const k of BOOLEAN_GENES) out[k] = !!g[k]
  out.levelUpOrder = (Array.isArray(g.levelUpOrder) ? g.levelUpOrder : [])
    .map((k) => (typeof k === 'string' ? k.toLowerCase() : ''))
    .filter(isClassKey)
    .slice(0, MAX_LEVEL_UP_ORDER)
  return out
}

// ---------------------------------------------------------------------------
// Strict validation + canonical serialization
// ---------------------------------------------------------------------------

export type GenomeParseResult = { ok: true; genome: Genome } | { ok: false; errors: string[] }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function checkKeys(obj: Record<string, unknown>, expected: readonly string[], where: string, errors: string[]): void {
  // Echo attacker-supplied names only JSON-escaped and truncated.
  for (const k of Object.keys(obj)) if (!expected.includes(k)) errors.push(`${where}: unknown field ${JSON.stringify(k.slice(0, 40))}`)
  for (const k of expected) if (!Object.prototype.hasOwnProperty.call(obj, k)) errors.push(`${where}: missing field "${k}"`)
}

/** STRICT validation of an already-parsed value. */
export function validateGenome(value: unknown): GenomeParseResult {
  const errors: string[] = []
  if (!isPlainObject(value)) return { ok: false, errors: ['genome: expected an object'] }
  checkKeys(value, ['schema', 'version', 'classKey', 'genes'], 'genome', errors)
  if (value.schema !== GENOME_SCHEMA) errors.push(`genome.schema: expected "${GENOME_SCHEMA}"`)
  if (value.version !== GENOME_VERSION) errors.push(`genome.version: expected ${GENOME_VERSION}`)
  if (typeof value.classKey !== 'string' || !isClassKey(value.classKey)) errors.push(`genome.classKey: expected one of ${CLASS_KEYS.join(', ')}`)
  const genes = value.genes
  if (!isPlainObject(genes)) {
    errors.push('genome.genes: expected an object')
    return { ok: false, errors }
  }
  checkKeys(genes, GENE_ORDER, 'genome.genes', errors)
  // Read every field exactly once and validate/return those copies, so an
  // accessor or a later mutation of the input cannot change what was checked.
  const read: Record<string, unknown> = {}
  for (const k of GENE_ORDER) if (Object.prototype.hasOwnProperty.call(genes, k)) read[k] = genes[k]
  for (const [k, spec] of Object.entries(NUMERIC_GENES) as [NumericGene, NumericSpec][]) {
    if (!(k in read)) continue
    const v = read[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`genes.${k}: expected a finite number`)
    else if (v < spec.min || v > spec.max) errors.push(`genes.${k}: ${v} is outside [${spec.min}, ${spec.max}]`)
    else if (spec.integer && !Number.isInteger(v)) errors.push(`genes.${k}: expected an integer`)
  }
  for (const k of BOOLEAN_GENES) {
    if (k in read && typeof read[k] !== 'boolean') errors.push(`genes.${k}: expected a boolean`)
  }
  let order: unknown[] = []
  if ('levelUpOrder' in read) {
    const raw = read.levelUpOrder
    if (!Array.isArray(raw)) errors.push('genes.levelUpOrder: expected an array')
    else if (raw.length > MAX_LEVEL_UP_ORDER) errors.push(`genes.levelUpOrder: at most ${MAX_LEVEL_UP_ORDER} entries`)
    else {
      for (let i = 0; i < raw.length; i++) {
        if (!(i in raw)) errors.push(`genes.levelUpOrder[${i}]: missing entry`)
        order.push(raw[i])
      }
      order.forEach((c, i) => {
        if (typeof c !== 'string' || !isClassKey(c)) errors.push(`genes.levelUpOrder[${i}]: unknown class`)
      })
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  const out = { ...read, levelUpOrder: order } as unknown as Genes
  return {
    ok: true,
    genome: { schema: GENOME_SCHEMA, version: GENOME_VERSION, classKey: value.classKey as ClassKey, genes: out },
  }
}

/** STRICT parse of a JSON text (size-capped). */
export function parseGenome(text: string): GenomeParseResult {
  if (typeof text !== 'string') return { ok: false, errors: ['genome: expected JSON text'] }
  if (text.length > MAX_GENOME_CHARS) return { ok: false, errors: [`genome: payload exceeds ${MAX_GENOME_CHARS} characters`] }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return { ok: false, errors: [`genome: invalid JSON (${err instanceof Error ? err.message : 'parse error'})`] }
  }
  return validateGenome(value)
}

/** Canonical JSON (fixed key order, no whitespace). */
export function serializeGenome(genome: Genome): string {
  const genes: Record<string, unknown> = {}
  for (const k of GENE_ORDER) genes[k] = k === 'levelUpOrder' ? [...genome.genes.levelUpOrder] : genome.genes[k]
  return JSON.stringify({ schema: genome.schema, version: genome.version, classKey: genome.classKey, genes })
}

/** Stable short id of a genome's canonical form (FNV-1a, hex). Not cryptographic. */
export function genomeHash(genome: Genome): string {
  return hashString(serializeGenome(genome)).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// Relevance, mutation, crossover
// ---------------------------------------------------------------------------

const HEAL_CASTERS: readonly ClassKey[] = ['bard', 'cleric', 'druid', 'paladin', 'ranger']
const CASTERS: readonly ClassKey[] = ['bard', 'cleric', 'druid', 'paladin', 'ranger', 'sorcerer', 'warlock', 'wizard']

export interface RelevanceContext {
  /** Party play (allies present) — enables the party-only genes. */
  party: boolean
}

/**
 * Genes that can change this genome's behaviour. A gene tied to a class
 * feature is relevant if the starting class OR any class in the level-up order
 * has that feature; party-only genes need allies.
 */
export function relevantGenes(genome: Genome, ctx: RelevanceContext = { party: false }): GeneKey[] {
  const classes = new Set<ClassKey>([genome.classKey, ...genome.genes.levelUpOrder])
  const has = (k: ClassKey): boolean => classes.has(k)
  const any = (ks: readonly ClassKey[]): boolean => ks.some(has)
  const out: GeneKey[] = ['healAtHpFrac', 'retreatAtHpFrac', 'kite', 'focusWeakest', 'focusCasters', 'protectAllies', 'aggression', 'exploreCoverage', 'levelUpOrder']
  if (has('fighter')) out.push('secondWindAtHpFrac', 'actionSurgeEarly')
  if (has('monk')) out.push('patientDefenseAdj')
  if (has('barbarian')) out.push('openWithRage')
  if (has('bard')) out.push('inspireBeforeAttack')
  if (any(HEAL_CASTERS)) out.push('potionFirst')
  if (any(CASTERS)) out.push('slotReserve')
  if (ctx.party) {
    out.push('regroup')
    if (any(HEAL_CASTERS)) out.push('healAllies')
  }
  return GENE_ORDER.filter((k) => out.includes(k))
}

/** Bell-shaped jitter in [−step, step] from a sum of three uniforms (engine-independent, unlike Box–Muller). */
function jitter(rng: Rng, step: number): number {
  return (rng() + rng() + rng() - 1.5) * (step / 1.5)
}

function mutateOrder(order: ClassKey[], rng: Rng): ClassKey[] {
  const out = [...order]
  const pick = (): ClassKey => CLASS_KEYS[Math.floor(rng() * CLASS_KEYS.length)]
  const op = out.length === 0 ? 0 : Math.floor(rng() * 3)
  if (op === 0 && out.length < MAX_LEVEL_UP_ORDER) out.splice(Math.floor(rng() * (out.length + 1)), 0, pick())
  else if (op === 1) out.splice(Math.floor(rng() * out.length), 1)
  else if (out.length > 0) out[Math.floor(rng() * out.length)] = pick()
  return out
}

export interface MutateOptions extends RelevanceContext {
  /** How many numeric genes to jitter at most (default 3). */
  maxNumeric?: number
}

/**
 * A mutated copy (input untouched): jitter 1..maxNumeric relevant numeric
 * genes, maybe flip one relevant boolean, maybe edit the level-up order.
 */
export function mutateGenome(genome: Genome, rng: Rng, opts: MutateOptions = { party: false }): Genome {
  const relevant = relevantGenes(genome, opts)
  const numeric = relevant.filter((k): k is NumericGene => k in NUMERIC_GENES)
  const booleans = relevant.filter((k): k is BooleanGene => (BOOLEAN_GENES as readonly string[]).includes(k))
  const g = copyGenes(genome.genes)
  const tweaks = 1 + Math.floor(rng() * (opts.maxNumeric ?? 3))
  for (let i = 0; i < tweaks && numeric.length > 0; i++) {
    const k = numeric[Math.floor(rng() * numeric.length)]
    const spec = NUMERIC_GENES[k]
    g[k] = spec.integer ? g[k] + (rng() < 0.5 ? -1 : 1) : g[k] + jitter(rng, spec.step)
  }
  if (booleans.length > 0 && rng() < 0.25) {
    const k = booleans[Math.floor(rng() * booleans.length)]
    g[k] = !g[k]
  }
  if (rng() < 0.2) g.levelUpOrder = mutateOrder(g.levelUpOrder, rng)
  return makeGenome(genome.classKey, g)
}

/** Uniform crossover of two same-class genomes (the level-up order comes whole from one parent). */
export function crossoverGenomes(a: Genome, b: Genome, rng: Rng): Genome {
  if (a.classKey !== b.classKey) throw new Error(`crossover: class mismatch (${a.classKey} vs ${b.classKey})`)
  const g = copyGenes(a.genes)
  const src = (): Genes => (rng() < 0.5 ? a.genes : b.genes)
  for (const k of Object.keys(NUMERIC_GENES) as NumericGene[]) g[k] = src()[k]
  for (const k of BOOLEAN_GENES) g[k] = src()[k]
  g.levelUpOrder = [...src().levelUpOrder]
  return makeGenome(a.classKey, g)
}

// ---------------------------------------------------------------------------
// Human-readable views
// ---------------------------------------------------------------------------

export type Role = 'support' | 'tank' | 'dps' | 'skirmisher'

/** The genome's emergent role — whichever lean is strongest. */
export function roleOf(g: Genes): Role {
  const scores: [Role, number][] = [
    ['support', g.healAllies],
    ['tank', g.protectAllies],
    ['dps', g.aggression],
    ['skirmisher', g.kite],
  ]
  let best: Role = 'dps'
  let bv = -Infinity
  for (const [r, v] of scores) {
    if (v > bv) {
      bv = v
      best = r
    }
  }
  return best
}

const pct = (v: number): string => `${Math.round(v * 100)}%`

/** Readable rule lines for a genome card. */
export function describeGenes(g: Genes): string[] {
  const stance = g.kite > 0.6 ? 'keeps range (kites)' : g.kite < 0.35 ? 'charges into melee' : 'mixed range'
  const order = g.levelUpOrder.length > 0 ? g.levelUpOrder.map((k) => k.charAt(0).toUpperCase()).join('·') : '—'
  return [
    `Role lean: ${roleOf(g)} (heal-allies ${pct(g.healAllies)} · protect ${pct(g.protectAllies)} · aggression ${pct(g.aggression)})`,
    `Heals at ${pct(g.healAtHpFrac)} HP (${g.potionFirst ? 'potion first' : 'spell first'})`,
    `Stance: ${stance}; targets the ${g.focusWeakest ? 'weakest' : 'nearest'} foe`,
    `Retreats below ${pct(g.retreatAtHpFrac)} HP`,
    `Abilities: ${g.openWithRage ? 'rage ' : ''}${g.inspireBeforeAttack ? 'inspire-first ' : ''}${g.actionSurgeEarly ? 'surge-early ' : ''}dodge@${g.patientDefenseAdj}+`,
    `Targets casters ${pct(g.focusCasters)} · slot reserve ${pct(g.slotReserve)} · regroup ${pct(g.regroup)}`,
    `Explores ${pct(g.exploreCoverage)} of each level`,
    `Level-up order: ${order}`,
  ]
}
