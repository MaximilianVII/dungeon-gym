import type { GameMap, Vec2 } from '../game/types'
import { isWalkable } from '../game/map'
import { tileDistance } from '../game/logic'
import { lineOfSight } from '../game/los'
import { rollDamage, rollDie, type DamageDice, type Rng } from '../combat/dice'
import { profBonus } from '../character/progression'
import { resolveAttack, resolveAreaAttack, combatMode } from '../combat/resolve'
import { addCondition, hasCondition, type Battler, type CombatAttack } from '../combat/types'
import { findEffect } from '../combat/subclasses'
import { bardicDie, wildShapeForm } from '../combat/abilities'
import type { Genes } from './genome'
import type { UsageTally } from './usage'

// ---------------------------------------------------------------------------
// Bot combat policy — plays the PLAYER side of a fight, driven by a genome's
// genes instead of hard-coded thresholds:
//   • bonus action: Rage / Bardic Inspiration / Second Wind / Patient Defense /
//     Cunning Action (dash to close) — each gated by a gene.
//   • action: heal (spell or potion) below the heal threshold; mend a wounded
//     ally (party); disengage below the retreat threshold; else attack — keep
//     range with a ranged cantrip/spell when the stance prefers it, else close
//     to melee; weapon attacks repeat with Extra Attack, and a Fighter spends
//     Action Surge (early, or to finish a low foe).
//
// Two RNG streams: `rng` rolls dice (shared with the rest of the fight),
// `decide` draws the policy's own random choices (the probability genes), so
// a policy coin-flip never shifts the dice sequence.
// Pure apart from mutating the battlers and advancing the two RNGs.
// ---------------------------------------------------------------------------

/** What the bot's action did this turn (telemetry): an attack, a heal, a
 *  retreat, only movement, or nothing at all. */
export type TurnKind = 'attack' | 'heal' | 'ability' | 'retreat' | 'move' | 'idle'

/** Bardic Inspiration reaches a creature within 60 ft. */
const INSPIRE_RANGE = 12

function avg(d: DamageDice): number {
  return d.count * (d.sides + 1) / 2 + d.bonus
}

function key(p: Vec2): string {
  return `${p.x},${p.y}`
}

const DIRS: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
]

function occupiedBy(battlers: Battler[], exceptId: string): Set<string> {
  return new Set(battlers.filter((b) => b.id !== exceptId && b.hp > 0).map((b) => key(b.pos)))
}

/** One greedy step toward (or away from) a point, avoiding walls and battlers. */
function step(from: Vec2, toward: Vec2, map: GameMap, occupied: Set<string>, away: boolean): Vec2 | null {
  const sx = Math.sign(toward.x - from.x) * (away ? -1 : 1)
  const sy = Math.sign(toward.y - from.y) * (away ? -1 : 1)
  const candidates: Vec2[] = [
    { x: from.x + sx, y: from.y + sy },
    { x: from.x + sx, y: from.y },
    { x: from.x, y: from.y + sy },
  ].filter((c) => c.x !== from.x || c.y !== from.y)
  for (const c of candidates) {
    if (isWalkable(map, c.x, c.y) && !occupied.has(key(c))) return c
  }
  return null
}

/** BFS first step from `from` toward `goal`, routing AROUND walls and other
 *  battlers (the goal tile itself is allowed). null if unreachable. */
export function pathStep(map: GameMap, from: Vec2, goal: Vec2, occupied: Set<string>): Vec2 | null {
  if (from.x === goal.x && from.y === goal.y) return null
  const W = map.width
  const H = map.height
  const startIdx = from.x + from.y * W
  const goalIdx = goal.x + goal.y * W
  const visited = new Uint8Array(W * H)
  const prev = new Int32Array(W * H).fill(-1)
  const q: number[] = [startIdx]
  visited[startIdx] = 1
  let head = 0
  while (head < q.length) {
    const idx = q[head++]
    if (idx === goalIdx) break
    const cx = idx % W
    const cy = (idx / W) | 0
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const ni = nx + ny * W
      if (visited[ni] || !isWalkable(map, nx, ny)) continue
      if (ni !== goalIdx && occupied.has(`${nx},${ny}`)) continue
      visited[ni] = 1
      prev[ni] = idx
      q.push(ni)
    }
  }
  if (!visited[goalIdx]) return null
  let cur = goalIdx
  while (prev[cur] !== -1 && prev[cur] !== startIdx) cur = prev[cur]
  if (prev[cur] === -1) return null
  return { x: cur % W, y: (cur / W) | 0 }
}

function livingEnemies(battlers: Battler[]): Battler[] {
  return battlers.filter((b) => b.team === 'enemy' && b.hp > 0)
}

function nearest(from: Vec2, list: Battler[]): Battler | undefined {
  let best: Battler | undefined
  let bestD = Infinity
  for (const b of list) {
    const d = tileDistance(from, b.pos)
    if (d < bestD) {
      bestD = d
      best = b
    }
  }
  return best
}

function weakest(list: Battler[]): Battler | undefined {
  let best: Battler | undefined
  for (const b of list) if (!best || b.hp < best.hp) best = b
  return best
}

/** Living party-mates other than this bot. */
function livingAllies(battlers: Battler[], selfId: string): Battler[] {
  return battlers.filter((b) => b.team === 'player' && b.hp > 0 && b.id !== selfId)
}

/** The ally with the lowest HP fraction. */
function mostWounded(list: Battler[]): Battler | undefined {
  let best: Battler | undefined
  let bestRatio = Infinity
  for (const b of list) {
    const r = b.maxHp > 0 ? b.hp / b.maxHp : 1
    if (r < bestRatio) {
      bestRatio = r
      best = b
    }
  }
  return best
}

function adjacentFoes(pos: Vec2, battlers: Battler[]): number {
  return livingEnemies(battlers).filter((e) => tileDistance(pos, e.pos) <= 1).length
}

function hasShotFrom(pos: Vec2, battlers: Battler[], map: GameMap, range: number): boolean {
  return livingEnemies(battlers).some((e) => tileDistance(pos, e.pos) <= range && lineOfSight(map, pos, e.pos))
}

/** Shoot-and-scoot: ONE adjacent step that reduces melee threats while keeping a
 *  clear shot, or null (fleeing at equal speed never breaks contact). */
function kiteShotTile(bot: Battler, battlers: Battler[], map: GameMap, range: number): Vec2 | null {
  const here = adjacentFoes(bot.pos, battlers)
  if (here === 0) return null
  const occupied = occupiedBy(battlers, bot.id)
  let best: Vec2 | null = null
  let bestAdj = here
  for (const [dx, dy] of DIRS) {
    const c = { x: bot.pos.x + dx, y: bot.pos.y + dy }
    if (!isWalkable(map, c.x, c.y) || occupied.has(key(c))) continue
    if (!hasShotFrom(c, battlers, map, range)) continue
    const adj = adjacentFoes(c, battlers)
    if (adj < bestAdj) {
      bestAdj = adj
      best = c
    }
  }
  return best
}

const has = (b: Battler, k: string): boolean => !!b.abilities?.includes(k)

function burstCount(c: Vec2, battlers: Battler[], radius: number): number {
  return livingEnemies(battlers).filter((e) => tileDistance(c, e.pos) <= radius).length
}

/** Among reachable targets, the one whose burst catches the MOST foes. */
function bestBurstTarget(cands: Battler[], battlers: Battler[], radius: number): Battler {
  let best = cands[0]
  let bestN = -1
  for (const t of cands) {
    const n = burstCount(t.pos, battlers, radius)
    if (n > bestN) {
      bestN = n
      best = t
    }
  }
  return best
}

/** The lowest slot level that can cast `a` (a spell may use any higher slot —
 *  e.g. a warlock's 3rd-level Pact Magic slots cast 1st/2nd-level spells). */
function castingSlotIndex(bot: Battler, a: CombatAttack): number {
  const slots = bot.spellSlots ?? []
  for (let i = (a.slotLevel ?? 1) - 1; i < slots.length; i++) if ((slots[i] ?? 0) > 0) return i
  return -1
}

function slotAvailable(bot: Battler, a: CombatAttack): boolean {
  return castingSlotIndex(bot, a) >= 0
}

function spendSlot(bot: Battler, a: CombatAttack): void {
  const i = castingSlotIndex(bot, a)
  if (i >= 0 && bot.spellSlots) bot.spellSlots[i] -= 1
}

function makeAttack(rng: Rng, bot: Battler, atk: CombatAttack, target: Battler, battlers: Battler[], rec: (label: string) => void): void {
  if (atk.source === 'spell') {
    if (!slotAvailable(bot, atk)) return
    spendSlot(bot, atk)
  }
  rec(atk.name)
  if (atk.area) resolveAreaAttack(rng, bot, atk, target.pos, battlers, atk.area)
  else resolveAttack(rng, bot, atk, target, combatMode(bot, target, atk), battlers)
}

/** Healing from a heal action, with the Life domain bonus. */
function healAmount(rng: Rng, bot: Battler, h: CombatAttack): number {
  let healed = rollDamage(rng, h.heal ?? { count: 0, sides: 0, bonus: 0 }).total
  const hb = findEffect(bot, 'healingBonus')
  if (hb) healed += hb.n + (h.slotLevel ?? 1)
  return healed
}

/** Play the bot's whole turn (mutates battlers + both RNGs), driven by its genes.
 *  Limited-use features are spent from `bot.resources`. `tally` counts each
 *  named action used, for usage statistics. */
export function botPlayerTurn(
  bot: Battler,
  battlers: Battler[],
  map: GameMap,
  rng: Rng,
  decide: Rng,
  genes: Genes,
  tally?: UsageTally,
): TurnKind {
  try {
    return playTurn(bot, battlers, map, rng, decide, genes, tally)
  } finally {
    // A Frenzy swing not spent this turn (e.g. a ranged turn) is lost.
    bot.frenzyAttackPending = false
  }
}

/** The nearest living ally within reach that holds no inspiration yet. */
function inspireTarget(bot: Battler, battlers: Battler[]): Battler | undefined {
  const cands = livingAllies(battlers, bot.id).filter((a) => !hasCondition(a, 'inspired') && tileDistance(bot.pos, a.pos) <= INSPIRE_RANGE)
  return nearest(bot.pos, cands)
}

function playTurn(bot: Battler, battlers: Battler[], map: GameMap, rng: Rng, decide: Rng, genes: Genes, tally?: UsageTally): TurnKind {
  if (bot.hp <= 0) return 'idle'
  const enemies = livingEnemies(battlers)
  if (enemies.length === 0) return 'idle'
  const bossFight = enemies.some((e) => e.role === 'boss')
  const rec = (label: string): void => {
    if (tally) tally[label] = (tally[label] ?? 0) + 1
  }

  // Role genes modulate the base knobs: aggression and protect push toward
  // melee + less retreat (around their 0.5 midpoint); protect also makes the
  // bot dodge sooner.
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))
  const effKite = clamp01(genes.kite - (genes.aggression - 0.5) * 0.4 - (genes.protectAllies - 0.5) * 0.3)
  const effRetreatFrac = genes.retreatAtHpFrac * (1 - genes.aggression * 0.5)
  const effPatientAdj = Math.max(1, Math.round(genes.patientDefenseAdj - genes.protectAllies * 2))
  // Probability genes: one policy draw per turn each.
  const preferCasters = decide() < genes.focusCasters
  const reserveSlots = decide() < genes.slotReserve
  const regroupNow = decide() < genes.regroup
  const rangedStance = decide() < effKite
  const res = bot.resources ?? { rage: 0, secondWind: 0, actionSurge: 0, inspiration: 0, wildShape: 0 }

  let movement = hasCondition(bot, 'restrained') ? 0 : bot.speedTiles
  const adjCount = (): number => adjacentFoes(bot.pos, battlers)

  // --- Bonus action: one signature class ability (gated by genes + uses) ---
  const bonusAction = (): void => {
    if (findEffect(bot, 'frenzyHaste') && hasCondition(bot, 'raging')) {
      bot.frenzyAttackPending = true
      rec('Frenzy')
      return
    }
    if (has(bot, 'rage') && !hasCondition(bot, 'raging') && res.rage > 0 && (genes.openWithRage || bossFight)) {
      addCondition(bot, 'raging')
      res.rage -= 1
      rec('Rage')
      return
    }
    if (has(bot, 'second-wind') && res.secondWind > 0 && bot.hp < bot.maxHp * genes.secondWindAtHpFrac) {
      const fighterLevel = bot.classLevels?.fighter ?? 1
      bot.hp = Math.min(bot.maxHp, bot.hp + rollDamage(rng, { count: 1, sides: 10, bonus: fighterLevel }).total)
      res.secondWind -= 1
      rec('Second Wind')
      return
    }
    if (has(bot, 'patient-defense') && adjCount() >= effPatientAdj) {
      addCondition(bot, 'dodging')
      rec('Patient Defense')
      return
    }
    // Monk Martial Arts: an unarmed strike as a bonus action after attacking.
    if ((bot.classLevels?.monk ?? 0) > 0) {
      martialArts = true
      return
    }
    if (has(bot, 'inspire') && res.inspiration > 0 && genes.inspireBeforeAttack) {
      const ally = inspireTarget(bot, battlers)
      if (ally) {
        addCondition(ally, 'inspired')
        ally.inspirationDie = bardicDie(bot.classLevels?.bard ?? 1)
        res.inspiration -= 1
        rec('Bardic Inspiration')
        return
      }
    }
    if (has(bot, 'cunning-dash')) {
      // Cunning Action: Hide when a foe is already within reach of an attack
      // (a hidden attacker has advantage, which enables Sneak Attack), else Dash.
      const reach = Math.max(1, ...bot.attacks.filter((a) => (a.source ?? 'weapon') === 'weapon').map((a) => a.range))
      if (livingEnemies(battlers).some((e) => tileDistance(bot.pos, e.pos) <= reach && lineOfSight(map, bot.pos, e.pos))) {
        const perception = Math.max(...livingEnemies(battlers).map((e) => e.passivePerception ?? 10))
        const stealth = rollDie(rng, 20) + (bot.initiativeMod) + 2 * profBonus(bot.charLevel ?? 1) // Expertise
        if (stealth > perception) addCondition(bot, 'hidden')
        rec('Hide')
        return
      }
      movement += bot.speedTiles
      rec('Cunning Action')
    }
  }
  let martialArts = false
  bot.sneakAttackUsed = false
  bot.colossusSlayerUsed = false
  bonusAction()

  // The strongest usable heal that reaches (Cure Wounds over Healing Word on
  // yourself; Healing Word when only it reaches an ally).
  const healSpell = (range: number): CombatAttack | undefined => {
    const usableHeals = bot.attacks.filter((a) => a.source === 'heal' && !!a.heal && a.range >= range && slotAvailable(bot, a))
    let best: CombatAttack | undefined
    for (const h of usableHeals) if (!best || avg(h.heal!) > avg(best.heal!)) best = h
    return best
  }

  // --- Heal self below the threshold (spell / potion order per genes) ---
  if (bot.hp < bot.maxHp * genes.healAtHpFrac && !bot.wildShape) {
    const tryPotion = (): boolean => {
      if ((bot.potions ?? 0) <= 0) return false
      bot.potions = (bot.potions ?? 0) - 1
      bot.hp = Math.min(bot.maxHp, bot.hp + rollDamage(rng, { count: 2, sides: 4, bonus: 2 }).total)
      rec('Healing Potion')
      return true
    }
    const trySpell = (): boolean => {
      const h = healSpell(0)
      if (!h) return false
      spendSlot(bot, h)
      bot.hp = Math.min(bot.maxHp, bot.hp + healAmount(rng, bot, h))
      rec(h.name)
      return true
    }
    const healed = genes.potionFirst ? tryPotion() || trySpell() : trySpell() || tryPotion()
    if (healed) return 'heal'
  }

  // --- Support: mend the most-wounded ally within the spell's range ---
  if (genes.healAllies > 0.45 && !bot.wildShape) {
    const ally = mostWounded(livingAllies(battlers, bot.id))
    if (ally && ally.hp < ally.maxHp * (0.35 + genes.healAllies * 0.4)) {
      const h = healSpell(tileDistance(bot.pos, ally.pos))
      if (h) {
        spendSlot(bot, h)
        ally.hp = Math.min(ally.maxHp, ally.hp + healAmount(rng, bot, h))
        rec(`${h.name} (ally)`)
        return 'heal'
      }
    }
  }

  // --- Druid Wild Shape (an action): take beast form while uses remain. The
  // form's HP soaks damage first; in form the druid fights with the beast's
  // attacks and cannot cast.
  const druidLevel = bot.classLevels?.druid ?? 0
  if (!bot.wildShape && res.wildShape > 0 && druidLevel >= 2) {
    const form = wildShapeForm(druidLevel)
    if (form) {
      bot.wildShape = { form, hp: form.hp, formerAc: bot.ac }
      bot.ac = form.ac
      res.wildShape -= 1
      rec(`Wild Shape (${form.name})`)
      return 'ability'
    }
  }

  // --- Retreat when critically low and unable to heal — but only toward a
  // living ally who can cover. With no opportunity attacks and no way to leave
  // a fight, a lone bot that backs off just gets chased and loses its action.
  if (bot.hp < bot.maxHp * effRetreatFrac && livingAllies(battlers, bot.id).length > 0) {
    rec('Retreat')
    const ally = regroupNow ? nearest(bot.pos, livingAllies(battlers, bot.id)) : undefined
    while (movement > 0) {
      const foe = nearest(bot.pos, livingEnemies(battlers))
      if (!foe) break
      const next = ally
        ? step(bot.pos, ally.pos, map, occupiedBy(battlers, bot.id), false)
        : step(bot.pos, foe.pos, map, occupiedBy(battlers, bot.id), true)
      if (!next) break
      bot.pos = next
      movement--
    }
    return 'retreat'
  }

  // --- Attack: only options the bot can pay for (a leveled spell needs a slot). ---
  const usable = (a: CombatAttack): boolean => a.source !== 'spell' || slotAvailable(bot, a)
  const kit = bot.wildShape ? [bot.wildShape.form.attack] : bot.attacks
  const perAction = Math.max(1, bot.wildShape?.form.attacksPerAction ?? bot.attacksPerAction)
  const damaging = kit.filter((a) => a.source !== 'heal' && (a.damage.count > 0 || a.damage.bonus > 0) && usable(a))
  if (damaging.length === 0) return 'idle'
  // Slot reserve: hold leveled spells for the boss.
  let pool = damaging
  if (reserveSlots && !bossFight) {
    const cheap = damaging.filter((a) => a.source !== 'spell')
    if (cheap.length > 0) pool = cheap
  }
  const ranged = pool.filter((a) => a.range > 1).sort((a, b) => avg(b.damage) - avg(a.damage))
  const melee = pool.filter((a) => a.range <= 1).sort((a, b) => avg(b.damage) - avg(a.damage))
  const isPriorityFoe = (b: Battler): boolean =>
    b.role === 'caster' || b.role === 'healer' ||
    b.attacks.some((a) => a.source === 'heal' || a.source === 'spell' || a.source === 'cantrip')
  const pick = (cands: Battler[]): Battler => {
    if (preferCasters) {
      const threats = cands.filter(isPriorityFoe)
      if (threats.length > 0) return genes.focusWeakest ? weakest(threats)! : nearest(bot.pos, threats)!
    }
    return genes.focusWeakest ? weakest(cands)! : nearest(bot.pos, cands)!
  }
  // Keep range when the best ranged option clearly out-damages melee, or when
  // the (role-modulated) stance says so.
  const bestRangedAvg = ranged.length ? avg(ranged[0].damage) : 0
  const bestMeleeAvg = melee.length ? avg(melee[0].damage) : 0
  const prefersRanged = ranged.length > 0 && (melee.length === 0 || bestRangedAvg > bestMeleeAvg * 1.15 || rangedStance)

  if (prefersRanged) {
    const r = ranged[0]
    if (movement > 0) {
      const spot = kiteShotTile(bot, battlers, map, r.range)
      if (spot) {
        bot.pos = spot
        movement--
      }
    }
    const inShot = (e: Battler): boolean => tileDistance(bot.pos, e.pos) <= r.range && lineOfSight(map, bot.pos, e.pos)
    let cands = livingEnemies(battlers).filter(inShot)
    if (cands.length === 0) {
      // Close just enough to get a clear shot.
      let tgt = nearest(bot.pos, livingEnemies(battlers))!
      while (movement > 0 && !inShot(tgt)) {
        const nx = pathStep(map, bot.pos, tgt.pos, occupiedBy(battlers, bot.id))
        if (!nx) break
        bot.pos = nx
        movement--
        tgt = nearest(bot.pos, livingEnemies(battlers)) ?? tgt
      }
      cands = livingEnemies(battlers).filter(inShot)
    }
    if (cands.length > 0) {
      const target = r.area ? bestBurstTarget(cands, battlers, r.area) : pick(cands)
      makeAttack(rng, bot, r, target, battlers, rec)
    }
    return cands.length > 0 ? 'attack' : 'move'
  }

  // Melee: close to an adjacent foe and swing (Extra Attack + Action Surge).
  const m = melee[0]
  let tgt = pick(livingEnemies(battlers))
  while (movement > 0 && tileDistance(bot.pos, tgt.pos) > 1) {
    const nx = pathStep(map, bot.pos, tgt.pos, occupiedBy(battlers, bot.id))
    if (!nx) break
    bot.pos = nx
    movement--
    tgt = pick(livingEnemies(battlers))
  }
  const adjacent = (): Battler[] => livingEnemies(battlers).filter((e) => tileDistance(bot.pos, e.pos) <= 1)
  const swing = (): boolean => {
    const adj = adjacent()
    if (adj.length === 0) return false
    makeAttack(rng, bot, m, pick(adj), battlers, rec)
    return true
  }
  let any = false
  for (let i = 0; i < perAction; i++) {
    if (!swing()) break
    any = true
  }
  if (any && has(bot, 'action-surge') && res.actionSurge > 0) {
    const adj = adjacent()
    const lowAdj = adj.some((e) => e.hp < e.maxHp * 0.35)
    if (adj.length > 0 && (genes.actionSurgeEarly || lowAdj)) {
      res.actionSurge -= 1
      rec('Action Surge')
      for (let i = 0; i < perAction; i++) if (!swing()) break
    }
  }
  // Berserker Frenzy: the bonus-action swing fires once after the Attack action.
  if (any && bot.frenzyAttackPending) {
    bot.frenzyAttackPending = false
    swing()
  }
  if (any && martialArts) swing()
  return any ? 'attack' : 'move'
}
