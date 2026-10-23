import type { AbilityScores, PlayerSource } from '../combat/setup'
import type { CombatAttack } from '../combat/types'
import { grantSpells } from '../combat/spells'
import { grantAbilities } from '../combat/abilities'
import { defaultSubclassFor } from '../combat/subclasses'
import { KNOWN_CLASSES, hpForClassLevels, totalLevel } from '../combat/multiclass'
import { attacksPerActionForMulti, casterSlots, casterSlotsMulti, maxSlotLevelOf, profBonus } from './progression'

// ---------------------------------------------------------------------------
// Character construction from SRD 5.1 tables (CC-BY-4.0, see LICENSE-SRD.md):
// ability modifiers, hit dice, armor, weapons, spell slots, Extra Attack,
// signature abilities and the SRD subclass. A `CharacterSpec` is the small,
// stable description of a character (who they are + what they carry); a
// `PlayerSource` is the fully derived sheet the combat layer reads.
//
// No races, backgrounds, feats or skills — the run doesn't model them.
// ---------------------------------------------------------------------------

export type ClassKey =
  | 'barbarian' | 'bard' | 'cleric' | 'druid' | 'fighter' | 'monk'
  | 'paladin' | 'ranger' | 'rogue' | 'sorcerer' | 'warlock' | 'wizard'

export const CLASS_KEYS: readonly ClassKey[] = KNOWN_CLASSES as readonly ClassKey[]

export function isClassKey(k: string): k is ClassKey {
  return (CLASS_KEYS as readonly string[]).includes(k)
}

interface WeaponStats {
  name: string
  count: number
  sides: number
  damageType: string
  /** Range in tiles (normal range / 5 ft). 1 = melee. */
  range: number
  finesse?: boolean
  /** Monk weapon — may use DEX and the Martial Arts die. */
  monk?: boolean
}

/** A subset of the SRD weapon table. */
export const WEAPONS: Record<string, WeaponStats> = {
  club: { name: 'Club', count: 1, sides: 4, damageType: 'bludgeoning', range: 1, monk: true },
  dagger: { name: 'Dagger', count: 1, sides: 4, damageType: 'piercing', range: 1, finesse: true, monk: true },
  greataxe: { name: 'Greataxe', count: 1, sides: 12, damageType: 'slashing', range: 1 },
  greatsword: { name: 'Greatsword', count: 2, sides: 6, damageType: 'slashing', range: 1 },
  handaxe: { name: 'Handaxe', count: 1, sides: 6, damageType: 'slashing', range: 1, monk: true },
  longsword: { name: 'Longsword', count: 1, sides: 8, damageType: 'slashing', range: 1 },
  mace: { name: 'Mace', count: 1, sides: 6, damageType: 'bludgeoning', range: 1, monk: true },
  quarterstaff: { name: 'Quarterstaff', count: 1, sides: 6, damageType: 'bludgeoning', range: 1, monk: true },
  rapier: { name: 'Rapier', count: 1, sides: 8, damageType: 'piercing', range: 1, finesse: true },
  scimitar: { name: 'Scimitar', count: 1, sides: 6, damageType: 'slashing', range: 1, finesse: true },
  shortsword: { name: 'Shortsword', count: 1, sides: 6, damageType: 'piercing', range: 1, finesse: true, monk: true },
  warhammer: { name: 'Warhammer', count: 1, sides: 8, damageType: 'bludgeoning', range: 1 },
  shortbow: { name: 'Shortbow', count: 1, sides: 6, damageType: 'piercing', range: 16 },
  longbow: { name: 'Longbow', count: 1, sides: 8, damageType: 'piercing', range: 30 },
  'light-crossbow': { name: 'Light Crossbow', count: 1, sides: 8, damageType: 'piercing', range: 16 },
}

interface ArmorStats {
  base: number
  kind: 'light' | 'medium' | 'heavy'
}

/** A subset of the SRD armor table. */
export const ARMOR: Record<string, ArmorStats> = {
  leather: { base: 11, kind: 'light' },
  'studded-leather': { base: 12, kind: 'light' },
  hide: { base: 12, kind: 'medium' },
  'chain-shirt': { base: 13, kind: 'medium' },
  'scale-mail': { base: 14, kind: 'medium' },
  breastplate: { base: 14, kind: 'medium' },
  'chain-mail': { base: 16, kind: 'heavy' },
  splint: { base: 17, kind: 'heavy' },
  plate: { base: 18, kind: 'heavy' },
}

/** Spellcasting ability per caster class. */
const CASTING_ABILITY: Partial<Record<ClassKey, keyof AbilityScores>> = {
  bard: 'cha', cleric: 'wis', druid: 'wis', paladin: 'cha', ranger: 'wis', sorcerer: 'cha', warlock: 'cha', wizard: 'int',
}

/** The stable description of a character; `buildCharacter` derives the sheet. */
export interface CharacterSpec {
  name: string
  /** The class the character started in. */
  classKey: ClassKey
  /** Levels per class, e.g. `{ fighter: 5 }` or `{ fighter: 5, wizard: 1 }`. */
  classLevels: Record<string, number>
  abilityScores: AbilityScores
  /** SRD weapon keys (see WEAPONS); the first is the main weapon. */
  weapons: string[]
  /** SRD armor key (see ARMOR); omitted = unarmored. */
  armor?: string
  shield?: boolean
  /** Fighting Style: Defense (+1 AC while wearing armor). */
  defenseStyle?: boolean
}

export const MAX_CHARACTER_LEVEL = 20
const ABILITY_KEYS: readonly (keyof AbilityScores)[] = ['str', 'dex', 'con', 'int', 'wis', 'cha']
const SPEC_KEYS: readonly string[] = ['name', 'classKey', 'classLevels', 'abilityScores', 'weapons', 'armor', 'shield', 'defenseStyle']

function isIntIn(v: unknown, lo: number, hi: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
}

/** Strict check of a character spec from outside (empty array = valid). */
export function validateCharacterSpec(spec: unknown): string[] {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) return ['spec: expected an object']
  const s = spec as Record<string, unknown>
  const errors: string[] = []
  for (const k of Object.keys(s)) if (!SPEC_KEYS.includes(k)) errors.push(`spec: unknown field ${JSON.stringify(k.slice(0, 40))}`)
  if (typeof s.name !== 'string' || s.name.length < 1 || s.name.length > 64) errors.push('spec.name: expected 1–64 characters')
  if (typeof s.classKey !== 'string' || !isClassKey(s.classKey)) errors.push('spec.classKey: unknown class')
  const levels = s.classLevels
  if (typeof levels !== 'object' || levels === null || Array.isArray(levels)) errors.push('spec.classLevels: expected an object')
  else {
    let total = 0
    for (const [k, v] of Object.entries(levels)) {
      if (!isClassKey(k)) errors.push(`spec.classLevels: unknown class ${JSON.stringify(k.slice(0, 40))}`)
      if (!isIntIn(v, 1, MAX_CHARACTER_LEVEL)) errors.push(`spec.classLevels.${k.slice(0, 40)}: expected an integer 1–${MAX_CHARACTER_LEVEL}`)
      else total += v as number
    }
    if (total < 1 || total > MAX_CHARACTER_LEVEL) errors.push(`spec.classLevels: total level must be 1–${MAX_CHARACTER_LEVEL}`)
    if (typeof s.classKey === 'string' && !((levels as Record<string, unknown>)[s.classKey])) errors.push('spec.classLevels: must include the starting class')
  }
  const scores = s.abilityScores
  if (typeof scores !== 'object' || scores === null || Array.isArray(scores)) errors.push('spec.abilityScores: expected an object')
  else {
    const keys = Object.keys(scores)
    if (keys.length !== ABILITY_KEYS.length || !ABILITY_KEYS.every((k) => isIntIn((scores as Record<string, unknown>)[k], 1, 30))) {
      errors.push('spec.abilityScores: expected str/dex/con/int/wis/cha integers 1–30')
    }
  }
  if (!Array.isArray(s.weapons) || s.weapons.length < 1 || s.weapons.length > 4 || !s.weapons.every((w) => typeof w === 'string' && Object.prototype.hasOwnProperty.call(WEAPONS, w))) {
    errors.push('spec.weapons: expected 1–4 known weapon keys')
  }
  if (s.armor !== undefined && (typeof s.armor !== 'string' || !Object.prototype.hasOwnProperty.call(ARMOR, s.armor))) errors.push('spec.armor: unknown armor')
  if (s.shield !== undefined && typeof s.shield !== 'boolean') errors.push('spec.shield: expected a boolean')
  if (s.defenseStyle !== undefined && typeof s.defenseStyle !== 'boolean') errors.push('spec.defenseStyle: expected a boolean')
  return errors
}

export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2)
}

/** Martial Arts die by monk level (SRD monk table). */
export function martialArtsDie(monkLevel: number): number {
  return monkLevel >= 17 ? 10 : monkLevel >= 11 ? 8 : monkLevel >= 5 ? 6 : 4
}

function armorClassOf(spec: CharacterSpec, mods: Record<keyof AbilityScores, number>, subclass: string | undefined): number {
  const armor = spec.armor ? ARMOR[spec.armor] : undefined
  let ac: number
  if (armor) {
    ac = armor.kind === 'heavy' ? armor.base : armor.kind === 'medium' ? armor.base + Math.min(2, mods.dex) : armor.base + mods.dex
    if (spec.defenseStyle) ac += 1
  } else if (spec.classKey === 'barbarian') {
    ac = 10 + mods.dex + mods.con // Unarmored Defense
  } else if (spec.classKey === 'monk' && !spec.shield) {
    ac = 10 + mods.dex + mods.wis // Unarmored Defense
  } else if (subclass === 'draconic') {
    ac = 13 + mods.dex // Draconic Resilience
  } else {
    ac = 10 + mods.dex
  }
  return ac + (spec.shield ? 2 : 0)
}

function speedOf(spec: CharacterSpec): number {
  let speed = 30
  const monk = spec.classLevels.monk ?? 0
  if (monk >= 2 && !spec.armor && !spec.shield) speed += monk >= 18 ? 30 : monk >= 14 ? 25 : monk >= 10 ? 20 : monk >= 6 ? 15 : 10
  const heavy = spec.armor ? ARMOR[spec.armor]?.kind === 'heavy' : false
  if ((spec.classLevels.barbarian ?? 0) >= 5 && !heavy) speed += 10 // Fast Movement
  return speed
}

function weaponAttack(key: string, spec: CharacterSpec, mods: Record<keyof AbilityScores, number>, prof: number): CombatAttack {
  const w = WEAPONS[key]
  if (!w) throw new Error(`Unknown weapon: ${key}`)
  const monkLevel = spec.classLevels.monk ?? 0
  const asMonk = monkLevel > 0 && !!w.monk
  const mod = w.range > 1 ? mods.dex : w.finesse || asMonk ? Math.max(mods.str, mods.dex) : mods.str
  const sides = asMonk ? Math.max(w.sides, martialArtsDie(monkLevel)) : w.sides
  return {
    name: w.name,
    toHit: prof + mod,
    damage: { count: w.count, sides, bonus: mod },
    damageType: w.damageType,
    range: w.range,
    source: 'weapon',
  }
}

/**
 * Spell actions for a (possibly multiclassed) build. Each caster class grants
 * its own list with its OWN casting ability and spell level access (a class
 * only knows spells its own levels could cast); slots are shared. Duplicates
 * (e.g. Cure Wounds from two classes) keep the better attack bonus.
 */
export function spellsForBuild(classLevels: Record<string, number>, abilityScores: AbilityScores): CombatAttack[] {
  const level = totalLevel(classLevels)
  const prof = profBonus(level)
  const byName = new Map<string, CombatAttack>()
  for (const [cls, lvl] of Object.entries(classLevels)) {
    const ability = CASTING_ABILITY[cls as ClassKey]
    if (!ability || lvl <= 0) continue
    const own = casterSlots(cls, lvl)
    const castMod = abilityMod(abilityScores[ability])
    for (const atk of grantSpells(cls, prof + castMod, own ? maxSlotLevelOf(own) : 0, castMod, level)) {
      // Agonizing Blast (an SRD Eldritch Invocation, warlock 2+): +CHA per beam.
      if (cls === 'warlock' && lvl >= 2 && atk.name === 'Eldritch Blast') {
        atk.damage = { ...atk.damage, bonus: atk.damage.bonus + castMod * atk.damage.count }
      }
      const prev = byName.get(atk.name)
      if (!prev || atk.toHit > prev.toHit) byName.set(atk.name, atk)
    }
  }
  return [...byName.values()]
}

/** Derive the full combat sheet for a spec. Pure; the spec is not mutated. */
export function buildCharacter(spec: CharacterSpec): PlayerSource {
  const s = spec.abilityScores
  const mods = { str: abilityMod(s.str), dex: abilityMod(s.dex), con: abilityMod(s.con), int: abilityMod(s.int), wis: abilityMod(s.wis), cha: abilityMod(s.cha) }
  const classLevels: Record<string, number> = { ...spec.classLevels }
  const level = totalLevel(classLevels)
  const prof = profBonus(level)
  const sc = defaultSubclassFor(spec.classKey)
  const subclass = sc && (classLevels[spec.classKey] ?? 0) >= sc.chosenAtLevel ? sc.key : undefined
  const sheet: PlayerSource = {
    name: spec.name,
    classKey: spec.classKey,
    classLevels,
    abilityScores: { ...s },
    maxHp: hpForClassLevels(classLevels, mods.con),
    ac: armorClassOf(spec, mods, subclass),
    speed: speedOf(spec),
    dexModifier: mods.dex,
    attacks: spec.weapons.map((w) => weaponAttack(w, spec, mods, prof)),
    attacksPerAction: attacksPerActionForMulti(classLevels),
    spells: spellsForBuild(classLevels, s),
    spellSlots: casterSlotsMulti(classLevels) ?? [],
    abilities: grantAbilities(classLevels),
    saves: savesOf(spec.classKey, mods, prof),
  }
  // Armor of Shadows (SRD Eldritch Invocation, warlock 2+): Mage Armor at will,
  // no slot — a warlock in light armor or none takes it when it is better.
  const lightOrNone = !spec.armor || ARMOR[spec.armor]?.kind === 'light'
  if ((classLevels.warlock ?? 0) >= 2 && lightOrNone && !spec.shield && sheet.ac < 13 + mods.dex) sheet.ac = 13 + mods.dex
  // Mage Armor (SRD, wizard/sorcerer): an unarmored arcane caster casts it at
  // the start of the day — AC 13 + DEX for one 1st-level slot.
  const arcane = (classLevels.wizard ?? 0) > 0 || (classLevels.sorcerer ?? 0) > 0
  if (arcane && !spec.armor && !spec.shield && sheet.ac < 13 + mods.dex && (sheet.spellSlots[0] ?? 0) > 0) {
    sheet.ac = 13 + mods.dex
    sheet.spellSlots = [sheet.spellSlots[0] - 1, ...sheet.spellSlots.slice(1)]
  }
  if (subclass) sheet.subclass = subclass
  return sheet
}

/** Saving-throw proficiencies of each class (only the starting class counts). */
const SAVE_PROFICIENCIES: Record<ClassKey, readonly (keyof AbilityScores)[]> = {
  barbarian: ['str', 'con'], bard: ['dex', 'cha'], cleric: ['wis', 'cha'], druid: ['int', 'wis'],
  fighter: ['str', 'con'], monk: ['str', 'dex'], paladin: ['wis', 'cha'], ranger: ['str', 'dex'],
  rogue: ['dex', 'int'], sorcerer: ['con', 'cha'], warlock: ['wis', 'cha'], wizard: ['int', 'wis'],
}

function savesOf(classKey: ClassKey, mods: Record<keyof AbilityScores, number>, prof: number): Record<keyof AbilityScores, number> {
  const profs = SAVE_PROFICIENCIES[classKey]
  const save = (k: keyof AbilityScores): number => mods[k] + (profs.includes(k) ? prof : 0)
  return { str: save('str'), dex: save('dex'), con: save('con'), int: save('int'), wis: save('wis'), cha: save('cha') }
}

// ---------------------------------------------------------------------------
// The 12 starting characters (one per class), standard-array scores, level 5.
// ---------------------------------------------------------------------------

export const STARTING_LEVEL = 5

type StarterBase = Omit<CharacterSpec, 'classKey' | 'classLevels'>

const STARTERS: Record<ClassKey, StarterBase> = {
  barbarian: { name: 'Korga Stonefist', abilityScores: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 }, weapons: ['greataxe'] },
  bard: { name: 'Lyra Mellowe', abilityScores: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 }, weapons: ['rapier'], armor: 'studded-leather' },
  cleric: { name: 'Sister Maeve', abilityScores: { str: 13, dex: 10, con: 14, int: 8, wis: 15, cha: 12 }, weapons: ['mace'], armor: 'chain-mail', shield: true },
  druid: { name: 'Thornwise', abilityScores: { str: 8, dex: 13, con: 14, int: 12, wis: 15, cha: 10 }, weapons: ['quarterstaff'], armor: 'leather', shield: true },
  fighter: { name: 'Dame Halloran', abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 }, weapons: ['longsword'], armor: 'chain-mail', shield: true, defenseStyle: true },
  monk: { name: 'Brother Ash', abilityScores: { str: 12, dex: 15, con: 13, int: 10, wis: 14, cha: 8 }, weapons: ['quarterstaff'] },
  paladin: { name: 'Sir Bracken', abilityScores: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 }, weapons: ['longsword'], armor: 'chain-mail', shield: true, defenseStyle: true },
  ranger: { name: 'Faye Brightwood', abilityScores: { str: 12, dex: 15, con: 13, int: 8, wis: 14, cha: 10 }, weapons: ['shortbow', 'rapier'], armor: 'studded-leather' },
  rogue: { name: 'Wren Quick', abilityScores: { str: 8, dex: 15, con: 14, int: 12, wis: 13, cha: 10 }, weapons: ['rapier', 'shortbow'], armor: 'studded-leather' },
  sorcerer: { name: 'Ember Vance', abilityScores: { str: 8, dex: 14, con: 13, int: 12, wis: 10, cha: 15 }, weapons: ['dagger'] },
  warlock: { name: 'Mordecai Vael', abilityScores: { str: 8, dex: 14, con: 13, int: 12, wis: 10, cha: 15 }, weapons: ['dagger'], armor: 'studded-leather' },
  wizard: { name: 'Marl Ashgrove', abilityScores: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }, weapons: ['dagger'] },
}

/** The starting character spec for a class (a fresh copy). */
export function starterSpec(classKey: ClassKey, level: number = STARTING_LEVEL): CharacterSpec {
  const base = STARTERS[classKey]
  return {
    ...base,
    abilityScores: { ...base.abilityScores },
    weapons: [...base.weapons],
    classKey,
    classLevels: { [classKey]: level },
  }
}

/** The derived starting sheet for a class. */
export function starterCharacter(classKey: ClassKey, level: number = STARTING_LEVEL): PlayerSource {
  return buildCharacter(starterSpec(classKey, level))
}
