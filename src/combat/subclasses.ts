// ---------------------------------------------------------------------------
// Subclass catalogue — exactly the twelve subclasses published in the SRD 5.1
// (one per class; CC-BY-4.0, see LICENSE-SRD.md). Feature text is paraphrased.
//
// Only a few features carry an `effect` the combat layer actually reads; the
// rest are data for a character sheet. Feature levels follow the SRD.
// ---------------------------------------------------------------------------

/** Subclass effects wired into combat (see combat/resolve, bot/policy, combat/setup). */
export type SubclassEffect =
  | { kind: 'critRange'; /** Crit on this d20 face or higher (19 = 19–20). */ range: number }
  | { kind: 'healingBonus'; /** Heals of 1st level+ restore n + spell level extra. */ n: number }
  | { kind: 'extraHpPerLevel'; n: number }
  | { kind: 'frenzyHaste' /** Berserker — bonus-action melee attack while raging. */ }
  | { kind: 'sculptSpells' /** Evoker — allies caught in your AoE take no damage. */ }
  | { kind: 'potentCantrip' /** Evoker — a missed cantrip still deals half damage (simplified). */ }
  | { kind: 'darkOneLuck' /** Fiend — reroll one failed save per fight (simplified). */ }
  | { kind: 'cuttingWords' /** Lore — once per fight, subtract 1d6 from a hit against you. */ }
  | { kind: 'openHandTechnique' /** Open Hand — melee hits may knock prone (simplified). */ }

export interface SubclassFeature {
  level: number
  /** Stable machine key (lower_snake_case). */
  key: string
  name: string
  description: string
  effect?: SubclassEffect
}

export interface Subclass {
  classKey: string
  key: string
  name: string
  /** The class level at which this subclass is chosen. */
  chosenAtLevel: number
  features: SubclassFeature[]
}

export const SUBCLASS_CATALOGUE: Subclass[] = [
  {
    classKey: 'barbarian', key: 'berserker', name: 'Path of the Berserker', chosenAtLevel: 3,
    features: [
      { level: 3, key: 'frenzy', name: 'Frenzy', description: 'While raging, make one melee weapon attack as a bonus action each turn.', effect: { kind: 'frenzyHaste' } },
      { level: 6, key: 'mindless_rage', name: 'Mindless Rage', description: 'Cannot be charmed or frightened while raging.' },
      { level: 10, key: 'intimidating_presence', name: 'Intimidating Presence', description: 'Use an action to frighten a creature.' },
      { level: 14, key: 'retaliation', name: 'Retaliation', description: 'Reaction melee attack against a creature within 5 ft that damages you.' },
    ],
  },
  {
    classKey: 'bard', key: 'lore', name: 'College of Lore', chosenAtLevel: 3,
    features: [
      { level: 3, key: 'bonus_proficiencies', name: 'Bonus Proficiencies', description: 'Gain three skill proficiencies.' },
      { level: 3, key: 'cutting_words', name: 'Cutting Words', description: 'Reaction: reduce a creature’s roll with a Bardic Inspiration die.', effect: { kind: 'cuttingWords' } },
      { level: 6, key: 'additional_magical_secrets', name: 'Additional Magical Secrets', description: 'Learn two spells from any class list.' },
      { level: 14, key: 'peerless_skill', name: 'Peerless Skill', description: 'Add a Bardic Inspiration die to your own ability check.' },
    ],
  },
  {
    classKey: 'cleric', key: 'life', name: 'Life Domain', chosenAtLevel: 1,
    features: [
      { level: 1, key: 'bonus_proficiency', name: 'Bonus Proficiency', description: 'Proficiency with heavy armor.' },
      { level: 1, key: 'disciple_of_life', name: 'Disciple of Life', description: 'Healing spells of 1st level or higher restore an extra 2 + spell level HP.', effect: { kind: 'healingBonus', n: 2 } },
      { level: 2, key: 'preserve_life', name: 'Channel Divinity: Preserve Life', description: 'Restore HP split among nearby creatures.' },
      { level: 6, key: 'blessed_healer', name: 'Blessed Healer', description: 'Healing another creature also heals you.' },
      { level: 8, key: 'divine_strike', name: 'Divine Strike', description: 'Once per turn, weapon hits deal extra radiant damage.' },
      { level: 17, key: 'supreme_healing', name: 'Supreme Healing', description: 'Healing dice are maximized.' },
    ],
  },
  {
    classKey: 'druid', key: 'land', name: 'Circle of the Land', chosenAtLevel: 2,
    features: [
      { level: 2, key: 'bonus_cantrip', name: 'Bonus Cantrip', description: 'Learn one extra druid cantrip.' },
      { level: 2, key: 'natural_recovery', name: 'Natural Recovery', description: 'Recover some spell slots on a short rest.' },
      { level: 3, key: 'circle_spells', name: 'Circle Spells', description: 'Always-prepared spells tied to your land.' },
      { level: 6, key: 'lands_stride', name: 'Land’s Stride', description: 'Move through nonmagical difficult terrain freely.' },
      { level: 10, key: 'natures_ward', name: 'Nature’s Ward', description: 'Immune to poison and disease; elementals and fey cannot charm or frighten you.' },
      { level: 14, key: 'natures_sanctuary', name: 'Nature’s Sanctuary', description: 'Beasts and plants hesitate to attack you.' },
    ],
  },
  {
    classKey: 'fighter', key: 'champion', name: 'Champion', chosenAtLevel: 3,
    features: [
      { level: 3, key: 'improved_critical', name: 'Improved Critical', description: 'Weapon attacks score a critical hit on a 19 or 20.', effect: { kind: 'critRange', range: 19 } },
      { level: 7, key: 'remarkable_athlete', name: 'Remarkable Athlete', description: 'Add half proficiency to some ability checks.' },
      { level: 10, key: 'additional_fighting_style', name: 'Additional Fighting Style', description: 'Choose a second Fighting Style.' },
      { level: 15, key: 'superior_critical', name: 'Superior Critical', description: 'Weapon attacks score a critical hit on an 18–20.', effect: { kind: 'critRange', range: 18 } },
      { level: 18, key: 'survivor', name: 'Survivor', description: 'Regain HP each turn while bloodied.' },
    ],
  },
  {
    classKey: 'monk', key: 'open_hand', name: 'Way of the Open Hand', chosenAtLevel: 3,
    features: [
      { level: 3, key: 'open_hand_technique', name: 'Open Hand Technique', description: 'Unarmed hits can knock a target prone (simplified: half the time on a melee hit).', effect: { kind: 'openHandTechnique' } },
      { level: 6, key: 'wholeness_of_body', name: 'Wholeness of Body', description: 'Heal yourself once per long rest.' },
      { level: 11, key: 'tranquility', name: 'Tranquility', description: 'Sanctuary-like protection after a long rest.' },
      { level: 17, key: 'quivering_palm', name: 'Quivering Palm', description: 'Set up lethal vibrations in a creature.' },
    ],
  },
  {
    classKey: 'paladin', key: 'devotion', name: 'Oath of Devotion', chosenAtLevel: 3,
    features: [
      { level: 3, key: 'sacred_weapon', name: 'Channel Divinity: Sacred Weapon', description: 'Add CHA to weapon attack rolls for a minute.' },
      { level: 7, key: 'aura_of_devotion', name: 'Aura of Devotion', description: 'You and nearby allies cannot be charmed.' },
      { level: 15, key: 'purity_of_spirit', name: 'Purity of Spirit', description: 'Always under protection from evil and good.' },
      { level: 20, key: 'holy_nimbus', name: 'Holy Nimbus', description: 'Radiate damaging sunlight.' },
    ],
  },
  {
    classKey: 'ranger', key: 'hunter', name: 'Hunter', chosenAtLevel: 3,
    features: [
      { level: 3, key: 'hunters_prey', name: 'Hunter’s Prey', description: 'Choose an offensive hunting technique.' },
      { level: 7, key: 'defensive_tactics', name: 'Defensive Tactics', description: 'Choose a defensive technique.' },
      { level: 11, key: 'multiattack', name: 'Multiattack', description: 'Volley or whirlwind attack.' },
      { level: 15, key: 'superior_hunters_defense', name: 'Superior Hunter’s Defense', description: 'Choose an advanced defensive technique.' },
    ],
  },
  {
    classKey: 'rogue', key: 'thief', name: 'Thief', chosenAtLevel: 3,
    features: [
      { level: 3, key: 'fast_hands', name: 'Fast Hands', description: 'Use objects with Cunning Action.' },
      { level: 3, key: 'second_story_work', name: 'Second-Story Work', description: 'Climb at full speed; longer jumps.' },
      { level: 9, key: 'supreme_sneak', name: 'Supreme Sneak', description: 'Advantage on Stealth when moving slowly.' },
      { level: 13, key: 'use_magic_device', name: 'Use Magic Device', description: 'Ignore requirements on magic items.' },
      { level: 17, key: 'thiefs_reflexes', name: 'Thief’s Reflexes', description: 'Take two turns in the first round of combat.' },
    ],
  },
  {
    classKey: 'sorcerer', key: 'draconic', name: 'Draconic Bloodline', chosenAtLevel: 1,
    features: [
      { level: 1, key: 'dragon_ancestor', name: 'Dragon Ancestor', description: 'Choose a dragon type; speak Draconic.' },
      { level: 1, key: 'draconic_resilience', name: 'Draconic Resilience', description: '+1 HP per sorcerer level; unarmored AC 13 + DEX.', effect: { kind: 'extraHpPerLevel', n: 1 } },
      { level: 6, key: 'elemental_affinity', name: 'Elemental Affinity', description: 'Add CHA to damage of spells of your ancestry’s type.' },
      { level: 14, key: 'dragon_wings', name: 'Dragon Wings', description: 'Sprout wings and gain a flying speed.' },
      { level: 18, key: 'draconic_presence', name: 'Draconic Presence', description: 'An aura of awe or fear.' },
    ],
  },
  {
    classKey: 'warlock', key: 'fiend', name: 'The Fiend', chosenAtLevel: 1,
    features: [
      { level: 1, key: 'dark_ones_blessing', name: 'Dark One’s Blessing', description: 'Gain temporary HP when you drop a hostile creature to 0 HP.' },
      { level: 6, key: 'dark_ones_own_luck', name: 'Dark One’s Own Luck', description: 'Bolster one save per rest (simplified: reroll one failed save per fight).', effect: { kind: 'darkOneLuck' } },
      { level: 10, key: 'fiendish_resilience', name: 'Fiendish Resilience', description: 'Resistance to a damage type of your choice.' },
      { level: 14, key: 'hurl_through_hell', name: 'Hurl Through Hell', description: 'Send a creature through the lower planes.' },
    ],
  },
  {
    classKey: 'wizard', key: 'evocation', name: 'School of Evocation', chosenAtLevel: 2,
    features: [
      { level: 2, key: 'evocation_savant', name: 'Evocation Savant', description: 'Copy evocation spells for less time and gold.' },
      { level: 2, key: 'sculpt_spells', name: 'Sculpt Spells', description: 'Allies caught in your evocation spells are spared.', effect: { kind: 'sculptSpells' } },
      { level: 6, key: 'potent_cantrip', name: 'Potent Cantrip', description: 'Cantrips still deal half damage when they fail (simplified: on a miss).', effect: { kind: 'potentCantrip' } },
      { level: 10, key: 'empowered_evocation', name: 'Empowered Evocation', description: 'Add INT to one damage roll of an evocation spell.' },
      { level: 14, key: 'overchannel', name: 'Overchannel', description: 'Maximize the damage of a low-level spell.' },
    ],
  },
]

const BY_CLASS: Record<string, Subclass[]> = {}
const BY_KEY: Record<string, Subclass> = {}
for (const s of SUBCLASS_CATALOGUE) {
  ;(BY_CLASS[s.classKey] ??= []).push(s)
  BY_KEY[s.key] = s
}

/** Every registered subclass for a class (lowercase key). May be empty. */
export function subclassesFor(classKey: string): Subclass[] {
  return BY_CLASS[classKey.toLowerCase()] ?? []
}

export function getSubclass(key: string): Subclass | undefined {
  return BY_KEY[key]
}

/** The class's SRD subclass — what a bot takes when it reaches chosenAtLevel. */
export function defaultSubclassFor(classKey: string): Subclass | undefined {
  return subclassesFor(classKey)[0]
}

/** Features a subclass grants at or below `level` (for sheet rendering). */
export function featuresUpTo(subclassKey: string, level: number): SubclassFeature[] {
  return getSubclass(subclassKey)?.features.filter((f) => f.level <= level) ?? []
}

export interface SubclassCarrier {
  subclass?: string
  classLevels?: Record<string, number>
  charLevel?: number
}

/** Every effect on the carrier's subclass features at or below its CLASS level. */
export function effectsOf(battler: SubclassCarrier): SubclassEffect[] {
  if (!battler.subclass) return []
  const sc = getSubclass(battler.subclass)
  if (!sc) return []
  const classLvl = battler.classLevels?.[sc.classKey] ?? battler.charLevel ?? 0
  const out: SubclassEffect[] = []
  for (const f of sc.features) {
    if (f.level <= classLvl && f.effect) out.push(f.effect)
  }
  return out
}

/** The first effect of a given kind on a battler, or undefined. */
export function findEffect<K extends SubclassEffect['kind']>(
  battler: SubclassCarrier,
  kind: K,
): Extract<SubclassEffect, { kind: K }> | undefined {
  return effectsOf(battler).find((e): e is Extract<SubclassEffect, { kind: K }> => e.kind === kind)
}
