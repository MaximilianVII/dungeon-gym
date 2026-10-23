import type { Vec2 } from '../game/types'
import type { DamageDice } from './dice'
import type { BeastForm, ClassResources } from './abilities'

// ---------------------------------------------------------------------------
// Combat-layer types. Plain JSON data only (no Set/Map/closures), so a fight in
// progress can be serialized with the rest of the run state and resumed.
// ---------------------------------------------------------------------------

export type Team = 'player' | 'enemy'

// Minimal 5e condition set. 'raging' / 'inspired' / 'dodging' are turn/fight
// states rather than 5e conditions, kept here so they share the same plumbing.
export type Condition = 'prone' | 'poisoned' | 'frightened' | 'unconscious' | 'grappled' | 'restrained' | 'dodging' | 'raging' | 'inspired' | 'hidden'

export interface CombatAttack {
  name: string
  toHit: number
  damage: DamageDice
  damageType: string
  /** Reach/range in tiles. 1 = melee (adjacent, diagonal counts). >1 = ranged. */
  range: number
  /**
   * Where this action comes from. Weapon attacks are part of the Attack action
   * and benefit from Extra Attack; a cantrip or spell each takes the whole
   * action (no extra swings); a 'heal' restores HP instead of dealing damage.
   * Defaults to 'weapon' when omitted.
   */
  source?: 'weapon' | 'cantrip' | 'spell' | 'heal'
  /** For a leveled spell/heal ('spell'/'heal'): which spell-slot level it spends. */
  slotLevel?: number
  /** For a 'heal' action: HP restored (dice already include the casting mod). */
  heal?: DamageDice
  /** On a hit, inflict this condition on the target for a number of rounds. */
  applies?: { condition: Condition; rounds: number }
  /**
   * Area-of-effect burst RADIUS in tiles (Chebyshev). When set (>0) the action
   * is resolved against every foe within `area` tiles of the aimed tile — a
   * Dexterity-style save for half — instead of a single-target attack roll.
   */
  area?: number
  /** Recharge X–6: once used, the attack returns only on a d6 roll ≥ this at the start of the user's turn. */
  recharge?: number
  /** The attacker regains half the damage it deals (Vampiric Touch). */
  drain?: boolean
  /** Always hits (no attack roll), e.g. Magic Missile. */
  autoHit?: boolean
  /** Extra damage on a hit that the target may save against for half
   *  (e.g. a giant spider's poison: 2d8, CON DC 11). */
  rider?: { damage: DamageDice; damageType: string; save: Ability; dc: number }
}

/** The six abilities, by short name. */
export type Ability = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'

export interface DeathSaves {
  successes: number
  failures: number
  stable: boolean
  dead: boolean
}

export interface Battler {
  id: string
  name: string
  team: Team
  glyph: string
  pos: Vec2
  maxHp: number
  hp: number
  ac: number
  /** Movement budget per turn, in tiles (speed_ft / 5). */
  speedTiles: number
  initiativeMod: number
  /** Rolled initiative value (set at setup). Higher acts first. */
  initiative: number
  attacks: CombatAttack[]
  /** Attacks per Attack action (Extra Attack → 2). */
  attacksPerAction: number
  /** Active conditions (no duplicates); see hasCondition/addCondition. */
  conditions: Condition[]
  /** Enemy turn behaviour (from the monster block); players omit it. */
  role?: string
  /** Elite affix tag (shielded/hasted/brutal/vampiric); undefined = ordinary foe. */
  affix?: string
  /** Subclass key (champion, thief, berserker, …) — drives `effectsOf`. */
  subclass?: string
  /** Per-class level breakdown, used to gate subclass features by CLASS level. */
  classLevels?: Record<string, number>
  /** Total character level (fallback when classLevels is missing). */
  charLevel?: number
  /** Warlock Fiend — Dark One's Own Luck reroll fires once per fight. */
  darkOneLuckUsed?: boolean
  /** Limited-use class features (players only); see combat/abilities. */
  resources?: ClassResources
  /** Die size of the Bardic Inspiration this creature holds (with 'inspired'). */
  inspirationDie?: number
  /** Saving-throw bonuses (players: ability mod + proficiency); missing = DEX
   *  from initiativeMod, others +0. */
  saves?: Partial<Record<Ability, number>>
  /** Passive Perception (enemies; a hiding rogue must beat it). */
  passivePerception?: number
  /** Names of Recharge attacks used and not yet recharged. */
  spent?: string[]
  /** Druid Wild Shape: the beast form's remaining HP, AC and attack; the
   *  druid's own AC is kept to restore when the form drops to 0 HP. */
  wildShape?: { form: BeastForm; hp: number; formerAc: number }
  /** Hunter Colossus Slayer already dealt this turn. */
  colossusSlayerUsed?: boolean
  /** Rogue Sneak Attack already dealt this turn. */
  sneakAttackUsed?: boolean
  /** Berserker Frenzy — a bonus-action attack waiting to be spent this turn. */
  frenzyAttackPending?: boolean
  /** Signature class ability keys (see combat/abilities). */
  abilities?: string[]
  /** Rounds remaining for timed conditions (poisoned/frightened/restrained…). */
  condTimers?: Record<string, number>
  /** Players make death saves at 0 HP; enemies just die. */
  deathSaves?: DeathSaves
  /** Healing potions carried (players only). */
  potions?: number
  /** Current spell slots by level (index 0 = level 1); players/casters only. */
  spellSlots?: number[]
  /** A boss's telegraphed AoE (`.area` = burst radius); built in setup. */
  bossAoe?: CombatAttack
  /** Turns until the boss may telegraph again (0 = ready). */
  telegraphCd?: number
  /** Reset value for telegraphCd after a burst. */
  telegraphCdMax?: number
  /** When set, a wind-up is pending: the next boss turn bursts bossAoe here. */
  telegraphCenter?: Vec2
}

export type CombatOutcome = 'ongoing' | 'won' | 'lost'

// Structured combat events, for a future combat log / replay viewer. The
// headless run ignores them.
export type CombatEvent =
  | { kind: 'roll-initiative'; who: string; value: number }
  | {
      kind: 'attack'
      attacker: string
      target: string
      attackName: string
      d20: number
      total: number
      ac: number
      hit: boolean
      crit: boolean
    }
  | { kind: 'damage'; target: string; amount: number; hpLeft: number }
  | { kind: 'down'; who: string }
  | { kind: 'dead'; who: string }
  | {
      kind: 'death-save'
      who: string
      d20: number
      result: 'success' | 'failure' | 'revive' | 'crit-fail'
      successes: number
      failures: number
    }
  | { kind: 'stable'; who: string }
  | { kind: 'heal'; who: string; amount: number; spell: string }
  | { kind: 'ability'; who: string; ability: string }
  | { kind: 'telegraph'; who: string; attackName: string }
  | { kind: 'condition'; who: string; condition: string }

/** Is the battler at 0 HP (downed)? */
export function isDown(b: Battler): boolean {
  return b.hp <= 0
}

/** A combatant is out of the fight if an enemy at 0 HP, or a dead player. */
export function isOutOfFight(b: Battler): boolean {
  if (b.team === 'enemy') return b.hp <= 0
  return b.deathSaves?.dead === true
}

export function hasCondition(b: Battler, c: Condition): boolean {
  return b.conditions.includes(c)
}

export function addCondition(b: Battler, c: Condition): void {
  if (!b.conditions.includes(c)) b.conditions.push(c)
}

export function removeCondition(b: Battler, c: Condition): void {
  const i = b.conditions.indexOf(c)
  if (i >= 0) b.conditions.splice(i, 1)
}
