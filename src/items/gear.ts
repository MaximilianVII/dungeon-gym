import type { CombatAttack } from '../combat/types'
import type { ArtifactEffect, Rarity } from './artifacts'

// ---------------------------------------------------------------------------
// Gear a bot can find and equip mid-run: weapons (replace the main-hand
// attack), armour (AC, best piece only), and trinkets (flat bonuses).
//
// 5e armour proficiency: a class wearing armour it isn't proficient with has
// disadvantage on attacks and can't cast spells — so bots only pick up armour
// their class can use. Weapons and trinkets are unrestricted.
// ---------------------------------------------------------------------------

export type GearKind = 'mainHand' | 'offHand' | 'armor' | 'helmet' | 'legs' | 'boots' | 'ring' | 'amulet'

export interface GearItem {
  key: string
  name: string
  rarity: Rarity
  kind: GearKind
  /** Flat stat bonuses (ac / maxHp / toHit / damageBonus / speed). */
  effect?: ArtifactEffect
  /** Weapons define the attack used in combat. */
  attack?: CombatAttack
  /** Armour weight class (light/medium/heavy) — governs proficiency. */
  armorClass?: 'light' | 'medium' | 'heavy'
}

function weapon(name: string, toHit: number, count: number, sides: number, bonus: number, dt: string, range = 1): CombatAttack {
  return { name, toHit, damage: { count, sides, bonus }, damageType: dt, range, source: 'weapon' }
}

export const GEAR: GearItem[] = [
  { key: 'fine-sword', name: 'Fine Sword', rarity: 'uncommon', kind: 'mainHand', attack: weapon('Fine Sword', 6, 1, 8, 3, 'slashing') },
  { key: 'great-axe', name: 'Great Axe', rarity: 'rare', kind: 'mainHand', attack: weapon('Great Axe', 5, 1, 12, 2, 'slashing') },
  { key: 'duelist-rapier', name: 'Duelist’s Rapier', rarity: 'uncommon', kind: 'mainHand', attack: weapon('Duelist’s Rapier', 7, 1, 8, 2, 'piercing') },
  { key: 'warhammer', name: 'Warhammer', rarity: 'rare', kind: 'mainHand', attack: weapon('Warhammer', 6, 1, 10, 3, 'bludgeoning') },
  { key: 'short-bow', name: 'Short Bow', rarity: 'common', kind: 'mainHand', attack: weapon('Short Bow', 6, 1, 6, 2, 'piercing', 12) },
  { key: 'round-shield', name: 'Round Shield', rarity: 'common', kind: 'offHand', effect: { ac: 2 } },
  { key: 'leather-jerkin', name: 'Leather Jerkin', rarity: 'common', kind: 'armor', effect: { ac: 2 }, armorClass: 'light' },
  { key: 'chain-shirt', name: 'Chain Shirt', rarity: 'uncommon', kind: 'armor', effect: { ac: 4 }, armorClass: 'medium' },
  { key: 'plate-shard', name: 'Plate Shard', rarity: 'rare', kind: 'armor', effect: { ac: 6 }, armorClass: 'heavy' },
  { key: 'guardian-plate', name: 'Guardian Plate', rarity: 'legendary', kind: 'armor', effect: { ac: 8, maxHp: 5 }, armorClass: 'heavy' },
  { key: 'iron-helm', name: 'Iron Helm', rarity: 'common', kind: 'helmet', effect: { ac: 1 } },
  { key: 'leather-leggings', name: 'Leather Leggings', rarity: 'common', kind: 'legs', effect: { ac: 1 } },
  { key: 'fleet-anklet', name: 'Fleet Anklet', rarity: 'common', kind: 'boots', effect: { speed: 10 } },
  { key: 'vigor-band', name: 'Vigor Band', rarity: 'uncommon', kind: 'ring', effect: { maxHp: 6 } },
  { key: 'ring-precision', name: 'Ring of Precision', rarity: 'very-rare', kind: 'ring', effect: { toHit: 2, damageBonus: 1 } },
  { key: 'amulet-health', name: 'Amulet of Vigor', rarity: 'rare', kind: 'amulet', effect: { maxHp: 12 } },
]

const ARMOR_LEVEL = { light: 1, medium: 2, heavy: 3 } as const

/** The heaviest armour a class can wear without penalty (0 = none). */
function classMaxArmor(classKey: string): number {
  const k = classKey.toLowerCase()
  if (k === 'fighter' || k === 'paladin') return 3
  if (k === 'barbarian' || k === 'cleric' || k === 'druid' || k === 'ranger') return 2
  if (k === 'bard' || k === 'rogue' || k === 'warlock') return 1
  return 0 // wizard / sorcerer / monk — no armour (unarmoured defence)
}

/** Can this class wear this item without losing spellcasting? Non-armour = yes. */
export function canUseArmor(classKey: string, item: GearItem): boolean {
  if (!item.armorClass) return true
  return ARMOR_LEVEL[item.armorClass] <= classMaxArmor(classKey)
}

/** Gear this class is allowed to equip (armour gated by proficiency). */
export function usableGear(classKey: string): GearItem[] {
  return GEAR.filter((i) => canUseArmor(classKey, i))
}
