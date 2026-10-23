import type { Battler, CombatAttack } from './types'

// ---------------------------------------------------------------------------
// Spell-slot bookkeeping. A leveled spell may be cast from any slot of its
// level or higher (upcasting); casters always spend the lowest one that fits —
// e.g. a warlock's 3rd-level Pact Magic slots cast 1st/2nd-level spells.
// ---------------------------------------------------------------------------

/** Index (level − 1) of the lowest slot that can cast `a`, or −1. */
export function castingSlotIndex(caster: Battler, a: CombatAttack): number {
  const slots = caster.spellSlots ?? []
  for (let i = (a.slotLevel ?? 1) - 1; i < slots.length; i++) if ((slots[i] ?? 0) > 0) return i
  return -1
}

export function slotAvailable(caster: Battler, a: CombatAttack): boolean {
  return castingSlotIndex(caster, a) >= 0
}

/** The level of the slot `a` would be cast from now (0 = none left). */
export function castingLevel(caster: Battler, a: CombatAttack): number {
  return castingSlotIndex(caster, a) + 1
}

/**
 * The spell as cast from a slot of `slotLevel` (SRD "At Higher Levels"): its
 * `upcast` dice are added once per level above its own — to the healing of a
 * heal, else to the damage; a multi-ray spell gains rays to match.
 */
export function upcast(a: CombatAttack, slotLevel: number): CombatAttack {
  const extra = slotLevel - (a.slotLevel ?? 1)
  if (extra <= 0 || !a.upcast) return a
  const add = (d: { count: number; sides: number; bonus: number }): { count: number; sides: number; bonus: number } =>
    ({ count: d.count + a.upcast!.count * extra, sides: d.sides, bonus: d.bonus + a.upcast!.bonus * extra })
  const out: CombatAttack = { ...a, slotLevel }
  if (a.source === 'heal' && a.heal) out.heal = add(a.heal)
  else out.damage = add(a.damage)
  if (a.beams && a.damage.count > 0) out.beams = Math.round(out.damage.count / (a.damage.count / a.beams))
  return out
}

/**
 * SRD Natural Recovery (Circle of the Land): regain expended slots whose
 * levels add up to at most half the druid level (rounded up), none of 6th
 * level or higher — highest first, never above the full table. Pure.
 */
export function naturalRecovery(slots: readonly number[], full: readonly number[], druidLevel: number): { slots: number[]; recovered: boolean } {
  let budget = Math.ceil(druidLevel / 2)
  const out = [...slots]
  let recovered = false
  for (let lvl = Math.min(5, full.length); lvl >= 1; lvl--) {
    while (lvl <= budget && (out[lvl - 1] ?? 0) < (full[lvl - 1] ?? 0)) {
      out[lvl - 1] = (out[lvl - 1] ?? 0) + 1
      budget -= lvl
      recovered = true
    }
  }
  return { slots: out, recovered }
}

/** Spend the lowest slot that casts `a`; returns the slot level used (0 = none left). */
export function spendSlot(caster: Battler, a: CombatAttack): number {
  const i = castingSlotIndex(caster, a)
  if (i < 0 || !caster.spellSlots) return 0
  caster.spellSlots[i] -= 1
  return i + 1
}
