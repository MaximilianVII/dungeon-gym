import { effectiveCasterLevel, extraAttacksFor, totalLevel } from '../combat/multiclass'

// ---------------------------------------------------------------------------
// 5e progression tables (SRD 5.1 class tables): spell slots, proficiency,
// Extra Attack and per-level HP, keyed by class + level. Used both to build the
// starting characters and to level bots up mid-run.
// ---------------------------------------------------------------------------

// Full-caster slots by character level (index 0 = level-1 slots).
const FULL_CASTER_SLOTS: number[][] = [
  [2],
  [3],
  [4, 2],
  [4, 3],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3, 1],
  [4, 3, 3, 2],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 2, 1, 1],
]

// Half-caster (paladin / ranger) slots by character level (none at level 1).
const HALF_CASTER_SLOTS: number[][] = [
  [],
  [2],
  [3],
  [3],
  [4, 2],
  [4, 2],
  [4, 3],
  [4, 3],
  [4, 3, 2],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3],
  [4, 3, 3, 1],
  [4, 3, 3, 1],
  [4, 3, 3, 2],
  [4, 3, 3, 2],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2],
]

/** Warlock Pact Magic: a few slots, all of the same (rising) level. */
function warlockSlots(level: number): number[] {
  const count = level >= 17 ? 4 : level >= 11 ? 3 : level >= 2 ? 2 : 1
  const slotLevel = level >= 9 ? 5 : level >= 7 ? 4 : level >= 5 ? 3 : level >= 3 ? 2 : 1
  const arr = new Array<number>(slotLevel).fill(0)
  arr[slotLevel - 1] = count
  return arr
}

const FULL = /wizard|sorcerer|cleric|druid|bard/i
const HALF = /paladin|ranger/i

/** Spell slots for a class at a level (5e), or null for a non-caster. */
export function casterSlots(classKey: string, level: number): number[] | null {
  const k = classKey.toLowerCase()
  const lv = Math.max(1, Math.min(20, Math.round(level)))
  if (/warlock/.test(k)) return warlockSlots(lv)
  if (FULL.test(k)) return [...FULL_CASTER_SLOTS[lv - 1]]
  if (HALF.test(k)) {
    const s = HALF_CASTER_SLOTS[lv - 1]
    return s.length ? [...s] : null
  }
  return null
}

/** Highest slot level the bot has (0 if none). */
export function maxSlotLevelOf(slots: number[]): number {
  let max = 0
  for (let i = 0; i < slots.length; i++) if (slots[i] > 0) max = i + 1
  return max
}

/** 5e proficiency bonus by character level. */
export function profBonus(level: number): number {
  return Math.floor((Math.max(1, level) - 1) / 4) + 2
}

/** Attacks per Attack action (Extra Attack). Fighters gain more at 11 / 20. */
export function attacksPerActionFor(classKey: string, level: number): number {
  const k = classKey.toLowerCase()
  if (k.includes('fighter')) return level >= 20 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1
  if (/barbarian|paladin|ranger|monk/.test(k)) return level >= 5 ? 2 : 1
  return 1
}

/** Average HP gained per level by class hit die (+ a little CON). */
export function hpGainPerLevel(classKey: string): number {
  const k = classKey.toLowerCase()
  if (k.includes('barbarian')) return 9 // d12
  if (/fighter|paladin|ranger/.test(k)) return 8 // d10
  if (/wizard|sorcerer/.test(k)) return 6 // d6
  return 7 // d8 — cleric / druid / monk / rogue / bard / warlock
}

// ---------------------------------------------------------------------------
// Multiclass-aware variants. A build is a record `{ fighter: 4, wizard: 1 }`;
// for a monoclass build the result equals the single-class variant.
// ---------------------------------------------------------------------------

/** Sum of class levels (delegates to combat/multiclass for a single source). */
export function totalLevelOf(classLevels: Record<string, number>): number {
  return totalLevel(classLevels)
}

/** Spell slots for a multiclass build using the SHARED 5e table (full casters
 *  ×1, half casters ×0.5, warlock SEPARATE). Returns null when the build has no
 *  caster levels at all. Warlock Pact Magic is merged into the same array so
 *  the combat layer (which spends `spellSlots[level-1]`) treats them uniformly. */
export function casterSlotsMulti(classLevels: Record<string, number>): number[] | null {
  const warlockLv = Math.max(0, Math.floor(classLevels.warlock ?? 0))
  // With ONE spellcasting class (warlock aside) the class's own table applies —
  // a lone Paladin 5 has 4/2 slots, not the shared table's 3. Only two or more
  // spellcasting classes use the SHARED multiclass table (the full-caster table
  // at the effective caster level).
  const casters = Object.entries(classLevels).filter(([k, v]) => v > 0 && k !== 'warlock' && casterSlots(k, 20) !== null)
  let shared: number[] | null = null
  if (casters.length === 1) shared = casterSlots(casters[0][0], casters[0][1])
  else if (casters.length > 1) {
    const ecl = effectiveCasterLevel(classLevels)
    shared = ecl > 0 ? casterSlots('wizard', ecl) : null
  }
  const pact = warlockLv > 0 ? casterSlots('warlock', warlockLv) : null
  if (!shared && !pact) return null
  // Pact Magic slots are separate from the shared pool; both are spendable, so
  // they add up per slot level.
  const out: number[] = shared ? [...shared] : []
  if (pact) {
    for (let i = 0; i < pact.length; i++) out[i] = (out[i] ?? 0) + pact[i]
  }
  return out
}

/** Attacks per Attack action for a multiclass build (5e: highest source only). */
export function attacksPerActionForMulti(classLevels: Record<string, number>): number {
  return extraAttacksFor(classLevels)
}
