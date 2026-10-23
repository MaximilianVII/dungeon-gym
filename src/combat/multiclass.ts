// ---------------------------------------------------------------------------
// Pure 5e multiclassing helpers (SRD 5.1 "Multiclassing").
//
// Plain data + arithmetic, no runtime dependencies. Used by character building
// (character/) and by the bot level-up path in the run loop (bot/run).
//
// `classLevels` is the record-shaped progression (`{ fighter: 4, wizard: 1 }`);
// the total character level is `sum(classLevels)`.
// ---------------------------------------------------------------------------

/** 5e class hit dice (d6 / d8 / d10 / d12). */
const HIT_DIE: Record<string, number> = {
  barbarian: 12,
  fighter: 10, paladin: 10, ranger: 10,
  bard: 8, cleric: 8, druid: 8, monk: 8, rogue: 8, warlock: 8,
  sorcerer: 6, wizard: 6,
}

/** Hit die size of a class (d8 for unknown keys). */
export function hitDieOf(classKey: string): number {
  return HIT_DIE[classKey.toLowerCase()] ?? 8
}

/** 5e multiclass spellcaster table: a full caster contributes its full level,
 *  a half caster contributes half (rounded down). The Warlock's Pact Magic
 *  slots are SEPARATE and do not feed this number. */
const FULL_CASTER = new Set(['wizard', 'sorcerer', 'bard', 'cleric', 'druid'])
const HALF_CASTER = new Set(['paladin', 'ranger'])

/** 5e multiclass prerequisites (SRD 5.1). `all` = every score must be ≥ 13;
 *  `any` = at least one of the listed scores must be ≥ 13. */
const MULTICLASS_PREREQS: Record<string, { all?: string[]; any?: string[] }> = {
  barbarian: { all: ['str'] },
  bard: { all: ['cha'] },
  cleric: { all: ['wis'] },
  druid: { all: ['wis'] },
  fighter: { any: ['str', 'dex'] },
  monk: { all: ['dex', 'wis'] },
  paladin: { all: ['str', 'cha'] },
  ranger: { all: ['dex', 'wis'] },
  rogue: { all: ['dex'] },
  sorcerer: { all: ['cha'] },
  warlock: { all: ['cha'] },
  wizard: { all: ['int'] },
}

/** Normalise to lowercase keys + integer levels ≥ 1 (drops zero/negative entries). */
function normalise(classLevels: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(classLevels)) {
    const n = Math.max(0, Math.floor(v))
    if (n > 0) out[k.toLowerCase()] = n
  }
  return out
}

/**
 * Caster level for the SHARED 5e spell-slot table. Full casters contribute
 * their level fully; half casters contribute half (rounded down); the Warlock
 * is excluded (Pact Magic slots come from a separate, smaller table).
 *
 * Example: `Cleric 5 / Paladin 4` → `5 + floor(4/2) = 7`.
 *          `Warlock 3 / Wizard 2` → `0 + 2 = 2`.
 */
export function effectiveCasterLevel(classLevels: Record<string, number>): number {
  const cl = normalise(classLevels)
  let total = 0
  for (const [k, v] of Object.entries(cl)) {
    if (FULL_CASTER.has(k)) total += v
    else if (HALF_CASTER.has(k)) total += Math.floor(v / 2)
    // warlock and martials contribute 0
  }
  return total
}

/**
 * Total HP from class levels under 5e averages: the FIRST class level grants
 * `max(hitDie) + conMod`; every subsequent level grants `avg+1 + conMod`
 * (i.e. `die/2 + 1 + conMod`). Because the input is a record (order lost),
 * the starting class is taken to be the one with the most levels — ties
 * broken by the larger hit die — which matches a natural "first class" pick.
 */
export function hpForClassLevels(classLevels: Record<string, number>, conMod: number): number {
  const cl = normalise(classLevels)
  const entries = Object.entries(cl).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return (HIT_DIE[b[0]] ?? 0) - (HIT_DIE[a[0]] ?? 0)
  })
  let total = 0
  let isFirst = true
  for (const [k, v] of entries) {
    const die = HIT_DIE[k] ?? 8
    let n = v
    if (isFirst) {
      // First level: max of the hit die + conMod.
      total += die + conMod
      n -= 1
      isFirst = false
    }
    // Subsequent levels in this class: avg+1 + conMod each.
    total += n * (die / 2 + 1 + conMod)
  }
  return Math.floor(total)
}

/** 5e proficiency bonus by TOTAL character level (sum of class levels). */
export function proficiencyBonus(totalLevel: number): number {
  return Math.floor((Math.max(1, totalLevel) - 1) / 4) + 2
}

/**
 * Number of attacks the Attack action grants. Per 5e, Extra Attack does NOT
 * stack across classes — only the highest applicable source counts:
 *   • Fighter 5 / 11 / 20 → 1 / 2 / 3 extra
 *   • Barbarian / Paladin / Ranger / Monk 5 → 1 extra
 * Returns the TOTAL attacks per Attack action (1 = baseline, no extra).
 */
export function extraAttacksFor(classLevels: Record<string, number>): number {
  const cl = normalise(classLevels)
  let best = 1
  const fl = cl.fighter ?? 0
  if (fl >= 20) best = Math.max(best, 4)
  else if (fl >= 11) best = Math.max(best, 3)
  else if (fl >= 5) best = Math.max(best, 2)
  for (const k of ['barbarian', 'paladin', 'ranger', 'monk']) {
    if ((cl[k] ?? 0) >= 5) best = Math.max(best, 2)
  }
  return best
}

/**
 * Does a character with these ability scores meet the prerequisite of `into`? Pass the
 * scores keyed by short name (`str`/`dex`/`con`/`int`/`wis`/`cha`). The
 * function applies the **multiclassing** prereqs (SRD 5.1), NOT the start
 * rules — a character starting in a class never has to pass these.
 */
export function canMulticlass(
  into: string,
  abilityScores: Record<string, number>,
): { ok: boolean; reason?: string } {
  const k = into.toLowerCase()
  const req = MULTICLASS_PREREQS[k]
  if (!req) return { ok: false, reason: `Unknown class: ${into}` }
  const scoreOf = (name: string): number => abilityScores[name.toLowerCase()] ?? 0
  if (req.all) {
    for (const a of req.all) {
      if (scoreOf(a) < 13) return { ok: false, reason: `${into} requires ${a.toUpperCase()} 13 (have ${scoreOf(a)})` }
    }
  }
  if (req.any) {
    const passed = req.any.some((a) => scoreOf(a) >= 13)
    if (!passed) return { ok: false, reason: `${into} requires ${req.any.map((a) => a.toUpperCase()).join(' or ')} 13` }
  }
  return { ok: true }
}

/** Known class keys (the 12 SRD classes). */
export const KNOWN_CLASSES: readonly string[] = [
  'barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk',
  'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard',
]

/**
 * Can a character whose current build is `classLevels` take a level in
 * `into`? Staying in a class it already has is always allowed; entering a NEW
 * class requires meeting the prerequisites of `into` AND of every class it
 * already has (SRD 5.1 multiclassing rule).
 */
export function canTakeLevelIn(
  into: string,
  classLevels: Record<string, number>,
  abilityScores: Record<string, number>,
): { ok: boolean; reason?: string } {
  const k = into.toLowerCase()
  if (!KNOWN_CLASSES.includes(k)) return { ok: false, reason: `Unknown class: ${into}` }
  if ((classLevels[k] ?? 0) > 0) return { ok: true }
  for (const cls of [k, ...Object.keys(normalise(classLevels))]) {
    const r = canMulticlass(cls, abilityScores)
    if (!r.ok) return r
  }
  return { ok: true }
}

/** Sum of class levels (handy alias). */
export function totalLevel(classLevels: Record<string, number>): number {
  let s = 0
  for (const v of Object.values(normalise(classLevels))) s += v
  return s
}
