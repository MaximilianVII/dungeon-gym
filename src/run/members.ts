import { rollDie, type Rng } from '../combat/dice'
import { buildPlayerBattler, charLevelOf, cloneAttack } from '../combat/setup'
import { canTakeLevelIn, hitDieOf } from '../combat/multiclass'
import type { Battler, CombatAttack } from '../combat/types'
import { naturalRecovery } from '../combat/slots'
import { drawRewards, effectScore, getArtifact, pickArtifact, type ArtifactEffect, type LootWeights } from '../items/artifacts'
import { GEAR, usableGear, type GearItem } from '../items/gear'
import { abilityMod, buildCharacter } from '../character/build'
import { casterSlots, profBonus } from '../character/progression'
import { lootWeights } from '../bot/genome'
import { maxResources, restoreResources } from '../combat/abilities'
import { findEffect } from '../combat/subclasses'
import { SHORT_RESTS_PER_LEVEL, STARTING_POTIONS, GEAR_BASE_PROF, type GearSlot, type MemberState, type RunState } from './types'
import { aliveMembers } from './state'

// ---------------------------------------------------------------------------
// Party members between and after fights: deriving a member's battler from
// its character + gear + artifacts, rests, rewards and level-ups.
// ---------------------------------------------------------------------------

export const isWeapon = (a: CombatAttack): boolean => !a.source || a.source === 'weapon'

export function gearByKey(key: string): GearItem | undefined {
  return GEAR.find((g) => g.key === key)
}

/**
 * Derive a member's battler from its character spec + found gear + bonuses.
 * With `prev`, live state carries over (HP shifted by any max-HP change,
 * conditions, death saves, potions, position, per-fight flags); spell slots
 * carry over unless `refillSlots` (a level-up refills them).
 */
export type Totals = Required<ArtifactEffect>

/** Flat bonuses from the member's artifacts and worn trinkets (not weapon/armour). */
export function flatBonus(m: MemberState): Totals {
  const acc: Totals = { maxHp: 0, ac: 0, toHit: 0, damageBonus: 0, speed: 0 }
  const add = (e: ArtifactEffect | undefined): void => {
    if (!e) return
    acc.maxHp += e.maxHp ?? 0
    acc.ac += e.ac ?? 0
    acc.toHit += e.toHit ?? 0
    acc.damageBonus += e.damageBonus ?? 0
    acc.speed += e.speed ?? 0
  }
  for (const k of m.owned) add(getArtifact(k)?.effect)
  for (const [slot, key] of Object.entries(m.equipped)) {
    if (!key || slot === 'mainHand' || slot === 'armor') continue
    if (slot === 'offHand' && m.spec.shield) continue // already carries a shield
    add(gearByKey(key)?.effect)
  }
  return acc
}

export function deriveBattler(m: MemberState, prev: Battler | null, refillSlots: boolean): Battler {
  const sheet = buildCharacter(m.spec)
  const fresh = buildPlayerBattler({ ...sheet, id: `p${m.memberId}`, potions: STARTING_POTIONS }, prev?.pos ?? { x: 0, y: 0 })
  const charLevel = charLevelOf(m.spec.classLevels)
  const bonus = flatBonus(m)
  let weapons = fresh.attacks.filter(isWeapon)
  const found = m.equipped.mainHand ? gearByKey(m.equipped.mainHand) : undefined
  if (found?.attack) {
    const a = cloneAttack(found.attack)
    a.toHit += profBonus(charLevel) - GEAR_BASE_PROF
    weapons = [a]
  }
  for (const a of weapons) {
    a.toHit += bonus.toHit
    a.damage.bonus += bonus.damageBonus
  }
  // Found armour REPLACES the sheet's armour: its AC (a bonus over 10 + DEX)
  // only counts where it beats what the sheet already gets from armour or
  // Unarmored Defense.
  const armor = m.equipped.armor ? gearByKey(m.equipped.armor) : undefined
  const sheetArmor = sheet.ac - 10 - sheet.dexModifier - (m.spec.shield ? 2 : 0)
  const armorGain = Math.max(0, (armor?.effect?.ac ?? 0) - sheetArmor)
  const b: Battler = {
    ...fresh,
    attacks: [...weapons, ...fresh.attacks.filter((a) => !isWeapon(a))],
    maxHp: fresh.maxHp + bonus.maxHp + (armor?.effect?.maxHp ?? 0),
    ac: fresh.ac + armorGain + bonus.ac,
    speedTiles: Math.max(1, Math.floor((sheet.speed + bonus.speed) / 5)),
  }
  b.hp = b.maxHp
  if (!prev) return b
  b.hp = Math.min(b.maxHp, prev.hp + Math.max(0, b.maxHp - prev.maxHp))
  b.pos = { ...prev.pos }
  b.conditions = [...prev.conditions]
  if (prev.condTimers) b.condTimers = { ...prev.condTimers }
  if (prev.deathSaves) b.deathSaves = { ...prev.deathSaves }
  b.potions = prev.potions ?? 0
  b.initiative = prev.initiative
  if (!refillSlots) b.spellSlots = [...(prev.spellSlots ?? [])]
  if (prev.darkOneLuckUsed) b.darkOneLuckUsed = true
  // Limited uses carry over; a level-up adds whatever its new levels grant.
  if (prev.resources && b.resources) {
    const cha = m.spec.abilityScores.cha
    const before = maxResources(prev.classLevels ?? m.spec.classLevels, cha)
    const now = b.resources
    const keep = (k: keyof typeof now): number => Math.max(0, prev.resources![k] + now[k] - before[k])
    b.resources = { rage: keep('rage'), secondWind: keep('secondWind'), actionSurge: keep('actionSurge'), inspiration: keep('inspiration'), wildShape: keep('wildShape') }
  }
  if (prev.inspirationDie !== undefined) b.inspirationDie = prev.inspirationDie
  if (prev.tempHp !== undefined) b.tempHp = prev.tempHp
  return b
}

/** What any short rest restores besides HP: per-short-rest features, a
 *  warlock's Pact Magic slots (added back, capped at the build's full table)
 *  and, once per long rest, a Land druid's Natural Recovery. */
export function restoreShortRestFeatures(m: MemberState): void {
  const b = m.battler
  const cha = m.spec.abilityScores.cha
  b.resources = restoreResources(b.resources ?? maxResources(m.spec.classLevels, cha), m.spec.classLevels, cha, false)
  const warlockLv = m.spec.classLevels.warlock ?? 0
  const pact = warlockLv > 0 ? casterSlots('warlock', warlockLv) : null
  if (pact) {
    const full = buildCharacter(m.spec).spellSlots
    const slots = [...(b.spellSlots ?? [])]
    for (let i = 0; i < pact.length; i++) slots[i] = Math.min(full[i] ?? 0, (slots[i] ?? 0) + pact[i])
    b.spellSlots = slots
  }
  if (!m.naturalRecoveryUsed && findEffect(b, 'naturalRecovery')) {
    const nr = naturalRecovery(b.spellSlots ?? [], buildCharacter(m.spec).spellSlots, m.spec.classLevels.druid ?? 0)
    b.spellSlots = nr.slots
    m.naturalRecoveryUsed = nr.recovered
  }
}

/** Camp between levels: survivors rest (long = full HP, slots, uses and half
 *  the Hit Dice back; short = top up to ~3/4 HP + short-rest features). */
export function restParty(s: RunState, long: boolean): void {
  for (const m of s.members) {
    if (!m.alive) continue
    const b = m.battler
    if (long) {
      const level = charLevelOf(m.spec.classLevels)
      b.hp = b.maxHp
      b.spellSlots = [...buildCharacter(m.spec).spellSlots]
      b.resources = maxResources(m.spec.classLevels, m.spec.abilityScores.cha)
      m.hitDice = Math.min(level, m.hitDice + Math.max(1, Math.floor(level / 2)))
      m.naturalRecoveryUsed = false
      delete b.tempHp
      continue
    }
    b.hp = Math.max(b.hp, Math.floor(b.maxHp * 0.75))
    restoreShortRestFeatures(m)
  }
}

/**
 * SRD short rest inside a level: after a won fight, if a survivor is below
 * half HP, the party rests once per level — each member spends Hit Dice
 * (die + CON, at least 1 HP each) until it is back to 3/4 HP or out of dice,
 * and regains its short-rest features.
 */
export function shortRestAfterFight(s: RunState, rng: Rng): void {
  if (s.shortRestsThisLevel >= SHORT_RESTS_PER_LEVEL) return
  const alive = aliveMembers(s)
  if (!alive.some((m) => m.battler.hp < m.battler.maxHp / 2)) return
  s.shortRestsThisLevel++
  // Song of Rest (bard 2+): whoever regains HP from Hit Dice gets an extra 1d6.
  const songOfRest = alive.some((m) => (m.spec.classLevels.bard ?? 0) >= 2)
  for (const m of alive) {
    const b = m.battler
    const die = hitDieOf(m.classKey)
    const con = abilityMod(m.spec.abilityScores.con)
    let spent = 0
    while (m.hitDice > 0 && b.hp < Math.floor(b.maxHp * 0.75)) {
      b.hp = Math.min(b.maxHp, b.hp + Math.max(1, rollDie(rng, die) + con))
      m.hitDice--
      spent++
    }
    if (songOfRest && spent > 0) b.hp = Math.min(b.maxHp, b.hp + rollDie(rng, 6))
    restoreShortRestFeatures(m)
  }
}

export function avgDamage(a: CombatAttack): number {
  return (a.damage.count * (a.damage.sides + 1)) / 2 + a.damage.bonus
}

export function gearEffectScore(key: string | undefined, w: LootWeights): number {
  const item = key ? gearByKey(key) : undefined
  return item?.effect ? effectScore(item.effect, w) : -Infinity
}

/** The slot a found item would go into (a ring takes a free or the weaker ring slot). */
export function slotFor(m: MemberState, item: GearItem, w: LootWeights): GearSlot {
  if (item.kind !== 'ring') return item.kind
  if (!m.equipped.ring1) return 'ring1'
  if (!m.equipped.ring2) return 'ring2'
  return gearEffectScore(m.equipped.ring1, w) <= gearEffectScore(m.equipped.ring2, w) ? 'ring1' : 'ring2'
}

/** Equip a found gear item if it beats what is in its slot (one item per slot).
 *  Trinkets are compared by the member's loot genes. */
export function equipFoundGear(m: MemberState, item: GearItem): void {
  const w = lootWeights(m.genes)
  const slot = slotFor(m, item, w)
  if (m.equipped[slot] === item.key) return
  if (item.attack) {
    const cur = m.battler.attacks.find(isWeapon)
    if (cur && avgDamage(item.attack) + flatBonus(m).damageBonus <= avgDamage(cur)) return
  } else if (item.kind === 'armor') {
    if ((item.effect?.ac ?? 0) <= (gearByKey(m.equipped.armor ?? '')?.effect?.ac ?? 0)) return
  } else if (!item.effect || effectScore(item.effect, w) <= gearEffectScore(m.equipped[slot], w)) {
    return
  }
  m.equipped = { ...m.equipped, [slot]: item.key }
  m.battler = deriveBattler(m, m.battler, false)
}

/** On clearing a level: party finds, then each survivor picks an artifact. */
export function grantReward(s: RunState, rng: Rng): void {
  if (rollDie(rng, 100) <= 12) s.scrolls += 1
  if (rollDie(rng, 100) <= 12) {
    const kind = rollDie(rng, 3)
    if (kind === 1) {
      for (const m of aliveMembers(s)) m.battler.potions = (m.battler.potions ?? 0) + 1
    } else if (kind === 2) s.longRestKits += 1
    else s.castCharges += 3
  }
  for (const m of aliveMembers(s)) {
    if (rollDie(rng, 100) <= 18) {
      const pool = usableGear(m.classKey)
      if (pool.length > 0) equipFoundGear(m, pool[rollDie(rng, pool.length) - 1])
    }
    const choices = drawRewards(rng, s.levelIndex, m.owned)
    if (choices.length === 0) continue
    const best = pickArtifact(choices, lootWeights(m.genes))
    m.owned.push(best.key)
    m.battler = deriveBattler(m, m.battler, false)
  }
}

/** Apply XP-driven level-ups, following the genome's level-up order. */
export function levelUp(m: MemberState, levelsGained: number): void {
  for (let i = 0; i < levelsGained; i++) {
    const idx = charLevelOf(m.spec.classLevels) - m.startLevel
    const wanted = m.genes.levelUpOrder[idx]
    const target = wanted && canTakeLevelIn(wanted, m.spec.classLevels, { ...m.spec.abilityScores }).ok ? wanted : m.classKey
    m.spec.classLevels[target] = (m.spec.classLevels[target] ?? 0) + 1
  }
  m.battler = deriveBattler(m, m.battler, true)
}
