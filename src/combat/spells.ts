import { parseDamage, type DamageDice } from './dice'
import type { CombatAttack, Condition, ControlEffect } from './types'

// ---------------------------------------------------------------------------
// Spell & class-action catalogue. A curated set of SRD 5.1 spells (and two
// class features — Divine Smite, Lay on Hands) that fit the combat model:
//   • cantrips — free, take the whole action, no slot.
//   • spells   — damage; spend a slot of their level. Melee-range entries stand
//                in for riders like Divine Smite.
//   • heal     — restore HP (casting mod added); spend a slot.
//   • control  — a 'spell' with a `control` effect instead of damage (Hold
//                Person, Sleep, Conjure Animals; see combat/control).
// Damage is resolved with an attack roll, or — for `area` spells — a Dex-style
// save for half against everyone in the burst. Cast from a higher slot, a
// spell adds its `upcast` dice per level (combat/slots). That is a simplification of the
// SRD text (e.g. Fireball is a save, Scorching Ray is three rays).
// Spell names are SRD 5.1 (CC-BY-4.0, see LICENSE-SRD.md).
// ---------------------------------------------------------------------------

interface SpellTemplate {
  name: string
  /** Lowercase class keys that learn this action. */
  classes: string[]
  source: 'cantrip' | 'spell' | 'heal'
  /** Spell-slot level for 'spell'/'heal'; omitted for cantrips. */
  slotLevel?: number
  /** Damage dice (cantrips + damaging spells). */
  damage?: string
  /** Healing dice for 'heal' actions; the caster's casting mod is added. */
  heal?: string
  damageType?: string
  /** Range in tiles (5 ft = 1 tile). 1 = melee / touch / self. */
  range: number
  /** On a hit, inflict a condition (e.g. Vicious Mockery → frightened). */
  applies?: { condition: Condition; rounds: number }
  /** Area-of-effect burst radius in tiles. */
  area?: number
  /** The caster regains half the damage dealt (Vampiric Touch). */
  drain?: boolean
  /** Always hits (Magic Missile). */
  autoHit?: boolean
  /** Separate rays, each its own attack roll (Scorching Ray). */
  beams?: number
  /** "At Higher Levels": dice per slot level above the spell's own. */
  upcast?: string
  /** Cast as a bonus action (Healing Word). */
  bonusAction?: boolean
  /** A non-damage effect (see combat/control). */
  control?: ControlEffect
}

const CATALOGUE: SpellTemplate[] = [
  // — Cantrips —
  { name: 'Fire Bolt', classes: ['wizard', 'sorcerer'], source: 'cantrip', damage: '1d10', damageType: 'fire', range: 24 },
  { name: 'Ray of Frost', classes: ['wizard', 'sorcerer'], source: 'cantrip', damage: '1d8', damageType: 'cold', range: 12 },
  { name: 'Eldritch Blast', classes: ['warlock'], source: 'cantrip', damage: '1d10', damageType: 'force', range: 24 },
  { name: 'Vicious Mockery', classes: ['bard'], source: 'cantrip', damage: '1d4', damageType: 'psychic', range: 12, applies: { condition: 'frightened', rounds: 1 } },
  { name: 'Sacred Flame', classes: ['cleric'], source: 'cantrip', damage: '1d8', damageType: 'radiant', range: 12 },
  { name: 'Produce Flame', classes: ['druid'], source: 'cantrip', damage: '1d8', damageType: 'fire', range: 6 },
  // — 1st level —
  { name: 'Burning Hands', upcast: '1d6', classes: ['wizard', 'sorcerer'], source: 'spell', slotLevel: 1, damage: '3d6', damageType: 'fire', range: 3, area: 1 },
  { name: 'Thunderwave', upcast: '1d8', classes: ['bard', 'druid', 'sorcerer', 'wizard'], source: 'spell', slotLevel: 1, damage: '2d8', damageType: 'thunder', range: 3, area: 1 },
  { name: 'Magic Missile', upcast: '1d4+1', classes: ['wizard', 'sorcerer'], source: 'spell', slotLevel: 1, damage: '3d4+3', damageType: 'force', range: 24, autoHit: true }, // three darts
  { name: 'Guiding Bolt', upcast: '1d6', classes: ['cleric'], source: 'spell', slotLevel: 1, damage: '4d6', damageType: 'radiant', range: 24 },
  { name: 'Inflict Wounds', upcast: '1d10', classes: ['cleric'], source: 'spell', slotLevel: 1, damage: '3d10', damageType: 'necrotic', range: 1 },
  { name: 'Divine Smite', upcast: '1d8', classes: ['paladin'], source: 'spell', slotLevel: 1, damage: '2d8', damageType: 'radiant', range: 1 },
  { name: 'Sleep', classes: ['bard', 'sorcerer', 'wizard'], source: 'spell', slotLevel: 1, range: 18, control: { kind: 'sleep', pool: { count: 5, sides: 8, bonus: 0 }, radius: 4 } },
  { name: "Hunter's Mark", classes: ['ranger'], source: 'spell', slotLevel: 1, range: 18, control: { kind: 'mark', bonus: { count: 1, sides: 6, bonus: 0 } } },
  // — 2nd level —
  { name: 'Scorching Ray', upcast: '2d6', classes: ['wizard', 'sorcerer'], source: 'spell', slotLevel: 2, damage: '6d6', damageType: 'fire', range: 24, beams: 3 }, // three 2d6 rays
  { name: 'Spiritual Weapon', classes: ['cleric'], source: 'spell', slotLevel: 2, damage: '2d8', damageType: 'force', range: 12 },
  { name: 'Moonbeam', upcast: '1d10', classes: ['druid'], source: 'spell', slotLevel: 2, damage: '2d10', damageType: 'radiant', range: 24 },
  { name: 'Shatter', upcast: '1d8', classes: ['bard', 'sorcerer', 'warlock', 'wizard'], source: 'spell', slotLevel: 2, damage: '3d8', damageType: 'thunder', range: 12, area: 2 },
  { name: 'Hold Person', classes: ['bard', 'cleric', 'druid', 'sorcerer', 'warlock', 'wizard'], source: 'spell', slotLevel: 2, range: 12, control: { kind: 'hold', save: 'wis', creatureType: 'humanoid' } },
  // — 3rd–5th level —
  { name: 'Fireball', upcast: '1d6', classes: ['wizard', 'sorcerer'], source: 'spell', slotLevel: 3, damage: '8d6', damageType: 'fire', range: 30, area: 3 },
  { name: 'Lightning Bolt', upcast: '1d6', classes: ['wizard', 'sorcerer'], source: 'spell', slotLevel: 3, damage: '8d6', damageType: 'lightning', range: 20, area: 3 },
  { name: 'Spirit Guardians', upcast: '1d8', classes: ['cleric'], source: 'spell', slotLevel: 3, damage: '3d8', damageType: 'radiant', range: 1, area: 2 },
  { name: 'Call Lightning', upcast: '1d10', classes: ['druid'], source: 'spell', slotLevel: 3, damage: '3d10', damageType: 'lightning', range: 24 },
  { name: 'Hypnotic Pattern', classes: ['bard', 'sorcerer', 'warlock', 'wizard'], source: 'spell', slotLevel: 3, range: 24, control: { kind: 'pattern', save: 'wis', radius: 3 } }, // 30-ft cube
  { name: 'Conjure Animals', classes: ['druid', 'ranger'], source: 'spell', slotLevel: 3, range: 12, control: { kind: 'conjure', beast: 'dire-wolf', count: 2 } }, // two CR 1 beasts
  { name: 'Vampiric Touch', upcast: '1d6', classes: ['warlock', 'wizard'], source: 'spell', slotLevel: 3, damage: '3d6', damageType: 'necrotic', range: 1, drain: true }, // heals half the damage
  { name: 'Ice Storm', upcast: '1d8', classes: ['wizard', 'sorcerer', 'druid'], source: 'spell', slotLevel: 4, damage: '5d6', damageType: 'cold', range: 60, area: 3 },
  { name: 'Cone of Cold', upcast: '1d8', classes: ['wizard', 'sorcerer'], source: 'spell', slotLevel: 5, damage: '8d8', damageType: 'cold', range: 12, area: 3 },
  { name: 'Flame Strike', upcast: '1d6', classes: ['cleric'], source: 'spell', slotLevel: 5, damage: '8d6', damageType: 'radiant', range: 12, area: 2 },
  // — Healing —
  { name: 'Healing Word', upcast: '1d4', classes: ['cleric', 'bard', 'druid'], source: 'heal', slotLevel: 1, heal: '1d4', range: 12, bonusAction: true },
  { name: 'Cure Wounds', upcast: '1d8', classes: ['cleric', 'druid', 'bard', 'paladin', 'ranger'], source: 'heal', slotLevel: 1, heal: '1d8', range: 1 },
  { name: 'Lay on Hands', classes: ['paladin'], source: 'heal', slotLevel: 1, heal: '2d4', range: 1 },
]

/** Every spell name in the catalogue (for docs / licensing checks). */
export const SPELL_NAMES: readonly string[] = CATALOGUE.map((s) => s.name)

function withBonus(d: DamageDice, bonus: number): DamageDice {
  return { ...d, bonus: d.bonus + bonus }
}

function toAttack(s: SpellTemplate, toHit: number, castMod: number): CombatAttack {
  const atk: CombatAttack = {
    name: s.name,
    toHit,
    damage: s.damage ? parseDamage(s.damage) : { count: 0, sides: 0, bonus: 0 },
    damageType: s.damageType ?? 'force',
    range: s.range,
    source: s.source,
  }
  if (s.slotLevel !== undefined) atk.slotLevel = s.slotLevel
  if (s.heal) atk.heal = withBonus(parseDamage(s.heal), castMod)
  if (s.applies) atk.applies = { ...s.applies }
  if (s.area !== undefined) atk.area = s.area
  if (s.autoHit) atk.autoHit = true
  if (s.drain) atk.drain = true
  if (s.beams) atk.beams = s.beams
  if (s.upcast) atk.upcast = parseDamage(s.upcast)
  if (s.bonusAction) atk.bonusAction = true
  if (s.control) atk.control = JSON.parse(JSON.stringify(s.control)) as ControlEffect
  return atk
}

/** 5e cantrip damage scaling: an extra die at character level 5 / 11 / 17. */
export function cantripDice(level: number): number {
  return level >= 17 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1
}

/**
 * The spell actions ONE class grants: every catalogue entry for `classKey`,
 * leveled entries capped by `maxSlotLevel`, cantrip dice scaled by the
 * character's TOTAL level. `castMod` is folded into healing amounts. A
 * non-caster class returns [].
 */
export function grantSpells(
  classKey: string,
  spellToHit: number,
  maxSlotLevel: number,
  castMod: number,
  charLevel: number,
): CombatAttack[] {
  const k = classKey.toLowerCase()
  const mult = cantripDice(charLevel)
  return CATALOGUE
    .filter((s) => s.classes.includes(k))
    .filter((s) => s.source === 'cantrip' || (s.slotLevel ?? 1) <= maxSlotLevel)
    .map((s) => {
      const atk = toAttack(s, spellToHit, castMod)
      if (s.source === 'cantrip' && atk.damage.count > 0 && mult > 1) {
        atk.damage = { ...atk.damage, count: atk.damage.count * mult }
      }
      return atk
    })
}
