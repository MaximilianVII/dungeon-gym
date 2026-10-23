import type { CombatAttack } from './types'
import { deepFreeze } from '../freeze'

// ---------------------------------------------------------------------------
// Monster stat blocks. The ordinary foes are simplified stat blocks of SRD 5.1
// creatures (CC-BY-4.0, see LICENSE-SRD.md); the Cult Adept and the three bosses
// (Orc Warlord, Spider Broodmother, Bone Lich) are original Dungeon Gym content.
//
// `glyph` is the map letter. `initiativeMod` = DEX modifier. `visionRadius`
// (tiles) + `passivePerception` drive detection during exploration.
// ---------------------------------------------------------------------------

/**
 * How a monster behaves on its turn (drives the AI):
 *  • brute / skirmisher — march in and attack in melee (default).
 *  • ranged / caster    — kite: keep their distance and shoot / sling spells.
 *  • healer             — mend a wounded ally instead of attacking when one is near.
 *  • boss               — a tougher foe, usually with Multiattack.
 */
export type MonsterRole = 'brute' | 'skirmisher' | 'ranged' | 'caster' | 'healer' | 'boss'

export interface MonsterBlock {
  key: string
  name: string
  glyph: string
  maxHp: number
  ac: number
  /** Speed in feet (converted to tiles at setup: ft / 5). */
  speed: number
  initiativeMod: number
  /** How far the foe can notice you, in tiles (line of sight still required). */
  visionRadius: number
  /** Passive Perception — a sneaking player must beat this with a Stealth roll. */
  passivePerception: number
  attacks: CombatAttack[]
  /** Turn behaviour. Omitted = a plain melee approacher (like goblin/skeleton). */
  role?: MonsterRole
  /** Swings per turn (Multiattack). Defaults to 1. */
  attacksPerAction?: number
  /** A telegraphed AoE the boss winds up one turn then bursts the next (see
   *  combat/boss). `attack.area` is the burst radius; `cooldown` is the turns
   *  between bursts. Built into `battler.bossAoe` at setup (depth-scaled). */
  telegraph?: { attack: CombatAttack; cooldown: number }
}

export const GOBLIN: MonsterBlock = {
  key: 'goblin',
  name: 'Goblin',
  glyph: 'g',
  maxHp: 7,
  ac: 15, // leather armor + shield
  speed: 30,
  initiativeMod: 2, // DEX 14
  visionRadius: 6,
  passivePerception: 9,
  attacks: [
    { name: 'Scimitar', toHit: 4, damage: { count: 1, sides: 6, bonus: 2 }, damageType: 'slashing', range: 1 },
    { name: 'Shortbow', toHit: 4, damage: { count: 1, sides: 6, bonus: 2 }, damageType: 'piercing', range: 16 },
  ],
}

export const SKELETON: MonsterBlock = {
  key: 'skeleton',
  name: 'Skeleton',
  glyph: 's',
  maxHp: 13,
  ac: 13, // armor scraps
  speed: 30,
  initiativeMod: 2, // DEX 14
  visionRadius: 7, // darkvision
  passivePerception: 9,
  attacks: [
    { name: 'Shortsword', toHit: 4, damage: { count: 1, sides: 6, bonus: 2 }, damageType: 'piercing', range: 1 },
    { name: 'Shortbow', toHit: 4, damage: { count: 1, sides: 6, bonus: 2 }, damageType: 'piercing', range: 16 },
  ],
}

export const KOBOLD: MonsterBlock = {
  key: 'kobold',
  name: 'Kobold',
  glyph: 'k',
  maxHp: 5,
  ac: 12,
  speed: 30,
  initiativeMod: 2,
  visionRadius: 6,
  passivePerception: 8,
  role: 'skirmisher',
  attacks: [
    { name: 'Dagger', toHit: 4, damage: { count: 1, sides: 4, bonus: 2 }, damageType: 'piercing', range: 1 },
    { name: 'Sling', toHit: 4, damage: { count: 1, sides: 4, bonus: 2 }, damageType: 'bludgeoning', range: 12 },
  ],
}

export const BANDIT: MonsterBlock = {
  key: 'bandit',
  name: 'Bandit',
  glyph: 'b',
  maxHp: 11,
  ac: 12,
  speed: 30,
  initiativeMod: 1,
  visionRadius: 6,
  passivePerception: 10,
  role: 'ranged',
  attacks: [
    { name: 'Light Crossbow', toHit: 3, damage: { count: 1, sides: 8, bonus: 1 }, damageType: 'piercing', range: 16 },
    { name: 'Scimitar', toHit: 3, damage: { count: 1, sides: 6, bonus: 1 }, damageType: 'slashing', range: 1 },
  ],
}

export const ORC: MonsterBlock = {
  key: 'orc',
  name: 'Orc',
  glyph: 'o',
  maxHp: 15,
  ac: 13,
  speed: 30,
  initiativeMod: 1,
  visionRadius: 7,
  passivePerception: 10,
  role: 'brute',
  attacks: [{ name: 'Greataxe', toHit: 5, damage: { count: 1, sides: 12, bonus: 3 }, damageType: 'slashing', range: 1 }],
}

export const ZOMBIE: MonsterBlock = {
  key: 'zombie',
  name: 'Zombie',
  glyph: 'z',
  maxHp: 22,
  ac: 8,
  speed: 20, // shambling — 4 tiles
  initiativeMod: -2,
  visionRadius: 5,
  passivePerception: 8,
  role: 'brute',
  attacks: [{ name: 'Slam', toHit: 3, damage: { count: 1, sides: 6, bonus: 1 }, damageType: 'bludgeoning', range: 1 }],
}

export const DIRE_WOLF: MonsterBlock = {
  key: 'dire-wolf',
  name: 'Dire Wolf',
  glyph: 'w',
  maxHp: 22,
  ac: 14,
  speed: 50, // fast — 10 tiles
  initiativeMod: 2,
  visionRadius: 8,
  passivePerception: 13,
  role: 'skirmisher',
  attacks: [{ name: 'Bite', toHit: 5, damage: { count: 2, sides: 6, bonus: 3 }, damageType: 'piercing', range: 1 }],
}

export const CULTIST: MonsterBlock = {
  key: 'cultist',
  name: 'Cult Adept',
  glyph: 'c',
  maxHp: 13,
  ac: 12,
  speed: 30,
  initiativeMod: 1,
  visionRadius: 7,
  passivePerception: 11,
  role: 'caster',
  attacks: [
    { name: 'Shadow Bolt', toHit: 4, damage: { count: 2, sides: 6, bonus: 0 }, damageType: 'necrotic', range: 12 },
    { name: 'Dagger', toHit: 3, damage: { count: 1, sides: 4, bonus: 1 }, damageType: 'piercing', range: 1 },
  ],
}

export const ACOLYTE: MonsterBlock = {
  key: 'acolyte',
  name: 'Acolyte',
  glyph: 'a',
  maxHp: 13,
  ac: 11,
  speed: 30,
  initiativeMod: 0,
  visionRadius: 6,
  passivePerception: 12,
  role: 'healer',
  attacks: [
    { name: 'Sacred Flame', toHit: 4, damage: { count: 1, sides: 8, bonus: 0 }, damageType: 'radiant', range: 12 },
    { name: 'Mace', toHit: 2, damage: { count: 1, sides: 6, bonus: 0 }, damageType: 'bludgeoning', range: 1 },
  ],
}

export const OGRE: MonsterBlock = {
  key: 'ogre',
  name: 'Ogre',
  glyph: 'O',
  maxHp: 40,
  ac: 11,
  speed: 40,
  initiativeMod: -1,
  visionRadius: 7,
  passivePerception: 8,
  role: 'brute',
  attacks: [{ name: 'Greatclub', toHit: 6, damage: { count: 2, sides: 8, bonus: 4 }, damageType: 'bludgeoning', range: 1 }],
}

export const GIANT_SPIDER: MonsterBlock = {
  key: 'giant-spider',
  name: 'Giant Spider',
  glyph: 'x',
  maxHp: 26,
  ac: 14,
  speed: 40,
  initiativeMod: 3,
  visionRadius: 8,
  passivePerception: 12,
  role: 'skirmisher',
  attacks: [
    // SRD bite: 1d8+3 piercing plus 2d8 poison (CON DC 11 for half); Web restrains at range.
    { name: 'Bite', toHit: 5, damage: { count: 1, sides: 8, bonus: 3 }, damageType: 'piercing', range: 1, rider: { damage: { count: 2, sides: 8, bonus: 0 }, damageType: 'poison', save: 'con', dc: 11 } },
    { name: 'Web', toHit: 5, damage: { count: 1, sides: 4, bonus: 0 }, damageType: 'bludgeoning', range: 6, applies: { condition: 'restrained', rounds: 2 }, recharge: 5 }, // Recharge 5–6
  ],
}

/** The final-level boss: tougher, with Multiattack (two swings a turn). */
export const ORC_WARLORD: MonsterBlock = {
  key: 'orc-warlord',
  name: 'Orc Warlord',
  glyph: 'B',
  maxHp: 60,
  ac: 16,
  speed: 30,
  initiativeMod: 2,
  visionRadius: 9,
  passivePerception: 12,
  role: 'boss',
  attacksPerAction: 2,
  attacks: [
    { name: 'Warlord’s Greataxe', toHit: 7, damage: { count: 1, sides: 12, bonus: 4 }, damageType: 'slashing', range: 1 },
    { name: 'Javelin', toHit: 6, damage: { count: 1, sides: 6, bonus: 4 }, damageType: 'piercing', range: 12 },
  ],
  // Telegraphed ground-slam: winds up, then bursts a 2-tile radius for 4d6 thunder.
  telegraph: { cooldown: 3, attack: { name: 'Earthshaking Roar', toHit: 6, damage: { count: 4, sides: 6, bonus: 0 }, damageType: 'thunder', range: 8, area: 2 } },
}

// --- Tougher types for the DEEPER tiers (see MONSTER_POOLS in dungeon/generate).
// The dungeon also scales every monster's stats up continuously with depth
// (buildEnemyBattler), so these mid-CR blocks stay believable while the depth
// multiplier carries them to late-game lethality. ---

export const HOBGOBLIN: MonsterBlock = {
  key: 'hobgoblin',
  name: 'Hobgoblin',
  glyph: 'h',
  maxHp: 11,
  ac: 18, // chain mail + shield
  speed: 30,
  initiativeMod: 1,
  visionRadius: 7,
  passivePerception: 10,
  role: 'brute',
  attacks: [
    { name: 'Longsword', toHit: 3, damage: { count: 1, sides: 8, bonus: 1 }, damageType: 'slashing', range: 1 },
    { name: 'Longbow', toHit: 3, damage: { count: 1, sides: 8, bonus: 1 }, damageType: 'piercing', range: 30 },
  ],
}

export const GNOLL: MonsterBlock = {
  key: 'gnoll',
  name: 'Gnoll',
  glyph: 'G',
  maxHp: 22,
  ac: 15,
  speed: 30,
  initiativeMod: 1,
  visionRadius: 7,
  passivePerception: 10,
  role: 'skirmisher',
  attacks: [
    { name: 'Bite', toHit: 4, damage: { count: 1, sides: 4, bonus: 2 }, damageType: 'piercing', range: 1 },
    { name: 'Spear', toHit: 4, damage: { count: 1, sides: 6, bonus: 2 }, damageType: 'piercing', range: 1 },
  ],
}

export const BUGBEAR: MonsterBlock = {
  key: 'bugbear',
  name: 'Bugbear',
  glyph: 'B',
  maxHp: 27,
  ac: 16,
  speed: 30,
  initiativeMod: 2,
  visionRadius: 7,
  passivePerception: 10,
  role: 'brute',
  attacks: [
    { name: 'Morningstar', toHit: 4, damage: { count: 2, sides: 8, bonus: 2 }, damageType: 'piercing', range: 1 },
    { name: 'Javelin', toHit: 4, damage: { count: 1, sides: 6, bonus: 2 }, damageType: 'piercing', range: 6 },
  ],
}

export const WIGHT: MonsterBlock = {
  key: 'wight',
  name: 'Wight',
  glyph: 'W',
  maxHp: 45,
  ac: 14,
  speed: 30,
  initiativeMod: 2,
  visionRadius: 8, // darkvision
  passivePerception: 13,
  role: 'brute',
  attacksPerAction: 2,
  attacks: [
    { name: 'Life Drain', toHit: 4, damage: { count: 1, sides: 6, bonus: 2 }, damageType: 'necrotic', range: 1 },
    { name: 'Longbow', toHit: 4, damage: { count: 1, sides: 8, bonus: 2 }, damageType: 'piercing', range: 30 },
  ],
}

export const WRAITH: MonsterBlock = {
  key: 'wraith',
  name: 'Wraith',
  glyph: 'R',
  maxHp: 67,
  ac: 13,
  speed: 60, // incorporeal flight — 12 tiles
  initiativeMod: 3,
  visionRadius: 9,
  passivePerception: 12,
  role: 'skirmisher',
  attacks: [{ name: 'Life Drain', toHit: 6, damage: { count: 4, sides: 8, bonus: 3 }, damageType: 'necrotic', range: 1 }],
}

export const TROLL: MonsterBlock = {
  key: 'troll',
  name: 'Troll',
  glyph: 'T',
  maxHp: 84,
  ac: 15,
  speed: 30,
  initiativeMod: 1,
  visionRadius: 8, // darkvision
  passivePerception: 12,
  role: 'brute',
  attacksPerAction: 3, // bite + 2 claws
  attacks: [{ name: 'Claw', toHit: 7, damage: { count: 2, sides: 6, bonus: 4 }, damageType: 'slashing', range: 1 }],
}

export const HILL_GIANT: MonsterBlock = {
  key: 'hill-giant',
  name: 'Hill Giant',
  glyph: 'H',
  maxHp: 105,
  ac: 13,
  speed: 40,
  initiativeMod: -1,
  visionRadius: 8,
  passivePerception: 12,
  role: 'brute',
  attacksPerAction: 2,
  attacks: [
    { name: 'Greatclub', toHit: 8, damage: { count: 3, sides: 8, bonus: 5 }, damageType: 'bludgeoning', range: 1 },
    { name: 'Rock', toHit: 8, damage: { count: 3, sides: 10, bonus: 5 }, damageType: 'bludgeoning', range: 12 },
  ],
}

/** A cave/warren boss: a venom-spitting matriarch with a telegraphed poison burst. */
export const SPIDER_BROODMOTHER: MonsterBlock = {
  key: 'spider-broodmother',
  name: 'Spider Broodmother',
  glyph: 'B',
  maxHp: 72,
  ac: 15,
  speed: 40,
  initiativeMod: 3,
  visionRadius: 9,
  passivePerception: 13,
  role: 'boss',
  attacksPerAction: 2,
  attacks: [
    { name: 'Savage Bite', toHit: 7, damage: { count: 2, sides: 8, bonus: 4 }, damageType: 'piercing', range: 1, applies: { condition: 'poisoned', rounds: 3 } },
    { name: 'Web Spit', toHit: 6, damage: { count: 1, sides: 6, bonus: 0 }, damageType: 'bludgeoning', range: 8, applies: { condition: 'restrained', rounds: 2 } },
  ],
  telegraph: { cooldown: 3, attack: { name: 'Venom Spray', toHit: 6, damage: { count: 3, sides: 6, bonus: 0 }, damageType: 'poison', range: 10, area: 2, applies: { condition: 'poisoned', rounds: 2 } } },
}

/** A vault/sewer boss: a spellcasting lich with a wide telegraphed necrotic nova. */
export const BONE_LICH: MonsterBlock = {
  key: 'bone-lich',
  name: 'Bone Lich',
  glyph: 'B',
  maxHp: 78,
  ac: 15,
  speed: 30,
  initiativeMod: 2,
  visionRadius: 10,
  passivePerception: 13,
  role: 'boss',
  attacksPerAction: 1,
  attacks: [
    { name: 'Bone Spear', toHit: 7, damage: { count: 3, sides: 8, bonus: 2 }, damageType: 'necrotic', range: 12 },
    { name: 'Withering Touch', toHit: 6, damage: { count: 2, sides: 8, bonus: 3 }, damageType: 'necrotic', range: 1 },
  ],
  telegraph: { cooldown: 3, attack: { name: 'Necrotic Nova', toHit: 7, damage: { count: 5, sides: 6, bonus: 0 }, damageType: 'necrotic', range: 12, area: 3 } },
}

export const MONSTERS: Record<string, MonsterBlock> = deepFreeze({
  goblin: GOBLIN,
  skeleton: SKELETON,
  kobold: KOBOLD,
  bandit: BANDIT,
  orc: ORC,
  zombie: ZOMBIE,
  'dire-wolf': DIRE_WOLF,
  cultist: CULTIST,
  acolyte: ACOLYTE,
  ogre: OGRE,
  'giant-spider': GIANT_SPIDER,
  hobgoblin: HOBGOBLIN,
  gnoll: GNOLL,
  bugbear: BUGBEAR,
  wight: WIGHT,
  wraith: WRAITH,
  troll: TROLL,
  'hill-giant': HILL_GIANT,
  'orc-warlord': ORC_WARLORD,
  'spider-broodmother': SPIDER_BROODMOTHER,
  'bone-lich': BONE_LICH,
})

export function getMonster(key: string): MonsterBlock | undefined {
  return MONSTERS[key]
}

// Per-biome boss key. Vault keeps the Orc Warlord so the standard 5-level run's
// finale (and its test) is unchanged; the other biomes field a themed boss, so a
// run that ends on a different biome (a run of another depth) meets a
// different boss. Fallback = the Orc Warlord.
const BIOME_BOSS: Record<string, string> = {
  crypt: 'orc-warlord',
  cave: 'spider-broodmother',
  sewer: 'bone-lich',
  warren: 'spider-broodmother',
  vault: 'orc-warlord',
}

/** The boss planted on the last level of a run, themed to the level's biome. */
export function bossForBiome(biome: string): string {
  return BIOME_BOSS[biome] ?? 'orc-warlord'
}
