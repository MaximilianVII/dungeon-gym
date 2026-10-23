import { tileDistance } from '../game/logic'
import { lineOfSight } from '../game/los'
import { rollDamage, rollDie, type Rng } from '../combat/dice'
import { buildEnemyBattler, charLevelOf, rollInitiative } from '../combat/setup'
import { getMonster } from '../combat/monsters'
import { resolveAttack, combatMode, tickConditions, rollDeathSave, endWildShape } from '../combat/resolve'
import { planEnemyTurn } from '../combat/ai'
import { bossTurn } from '../combat/boss'
import { hasCondition, isOutOfFight, removeCondition, type Battler } from '../combat/types'
import { endOfTurnSaves, enforceConcentration, isIncapacitated } from '../combat/control'
import { applyXp, monsterXp } from '../dungeon/leveling'
import { abilityMod } from '../character/build'
import { botPlayerTurn, type TurnContext } from '../bot/policy'
import { ENGAGE_RADIUS, COMBAT_ROUND_CAP, BOT_WAND, type Spawn, type CombatState, type MemberState, type RunState } from './types'
import { aliveMembers, memberById, currentLevel, combatBattlers, killMember, finishRun } from './state'
import { spreadPositions } from './grid'
import { shortRestAfterFight, levelUp } from './members'

// ---------------------------------------------------------------------------
// The fight loop of a run: starting a fight, one combat turn per step (bots,
// summoned beasts, monsters), and closing the fight.
// ---------------------------------------------------------------------------

/**
 * SRD surprise: the party is surprised only if the foe that spotted it beats
 * the party's best passive Perception (10 + WIS modifier) with a Dexterity
 * (Stealth) check. Otherwise both sides start the fight normally.
 */
export function partyIsSurprised(s: RunState, spotter: Spawn, rng: Rng): boolean {
  const mon = getMonster(spotter.key)
  const passive = Math.max(...aliveMembers(s).map((m) => 10 + abilityMod(m.spec.abilityScores.wis)))
  return rollDie(rng, 20) + (mon?.initiativeMod ?? 0) > passive
}

export function startCombat(s: RunState, spotter: Spawn, rng: Rng): void {
  const map = currentLevel(s).map
  // The spotter's whole group joins, plus anyone else close by in sight.
  const engaged = s.remaining.filter(
    (e) => e.group === spotter.group || (tileDistance(s.pos, e.pos) <= ENGAGE_RADIUS && lineOfSight(map, e.pos, s.pos)),
  )
  const alive = aliveMembers(s)
  const spots = spreadPositions(map, s.pos, alive.length, new Set(engaged.map((e) => `${e.pos.x},${e.pos.y}`)))
  alive.forEach((m, i) => {
    const b = m.battler
    b.pos = { ...spots[i] }
    b.conditions = []
    b.condTimers = {}
    b.deathSaves = { successes: 0, failures: 0, stable: false, dead: false }
    delete b.concentration
    delete b.condSource
    delete b.saveEnds
    // Once-per-fight features refresh with every fight.
    b.darkOneLuckUsed = false
    endWildShape(b)
  })
  const enemies = engaged
    .map((e) => {
      const mon = getMonster(e.key)
      return mon ? buildEnemyBattler(mon, `${e.key}-${e.id}`, e.pos, s.levelIndex) : null
    })
    .filter((b): b is Battler => b !== null)
  const combat: CombatState = {
    memberIds: alive.map((m) => m.memberId),
    allies: [],
    nextAllyId: 0,
    enemies,
    order: [],
    turn: 0,
    round: 1,
    surprised: partyIsSurprised(s, spotter, rng),
    engaged: engaged.map((e) => e.id),
  }
  combat.order = rollInitiative(rng, combatBattlers(s, combat)).order.map((b) => b.id)
  for (const m of alive) {
    m.stats.fights++
    m.stats.foesFaced += enemies.length
    m.stats.maxFoes = Math.max(m.stats.maxFoes, enemies.length)
  }
  s.combat = combat
  s.phase = 'combat'
}

export function gotoNext(c: CombatState): void {
  c.turn++
  if (c.turn >= c.order.length) {
    c.turn = 0
    c.round++
  }
}

/** The monster key of an enemy battler id (`${key}-${spawnId}`). */
export function monsterKeyOf(enemy: Battler): string {
  const i = enemy.id.lastIndexOf('-')
  return i > 0 ? enemy.id.slice(0, i) : enemy.id
}

/** A conjured beast's turn (monster AI against the enemies); its damage and
 *  kills count for the member who summoned it. */
export function runSummonTurn(s: RunState, beast: Battler, battlers: Battler[], rng: Rng): void {
  const before = sumHp(battlers, 'enemy')
  const upBefore = enemiesUp(battlers)
  enemyAct(s, beast, battlers, rng)
  const owner = s.members.find((m) => m.battler.id === beast.summoner)
  if (!owner) return
  owner.damage += Math.max(0, before - sumHp(battlers, 'enemy'))
  owner.kills += Math.max(0, upBefore - enemiesUp(battlers))
}

/** The turn context a member's bot gets: summoned beasts join the fight and
 *  act right after their summoner, from this round on. */
export function turnContext(c: CombatState): TurnContext {
  return {
    summonId: (i) => `ally-${c.nextAllyId + i}`,
    addSummons: (beasts) => {
      c.nextAllyId += beasts.length
      c.allies.push(...beasts)
      c.order.splice(c.turn + 1, 0, ...beasts.map((b) => b.id))
    },
  }
}

export function runEnemyTurn(s: RunState, enemy: Battler, battlers: Battler[], rng: Rng): void {
  const hpBefore = battlers.map((b) => b.hp)
  enemyAct(s, enemy, battlers, rng)
  battlers.forEach((b, i) => {
    if (b.team !== 'player' || b.hp >= hpBefore[i]) return
    const m = s.members.find((x) => x.battler.id === b.id)
    if (!m) return
    m.stats.damageTaken += hpBefore[i] - Math.max(0, b.hp)
    m.stats.lastHitBy = monsterKeyOf(enemy)
  })
}

export function enemyAct(s: RunState, enemy: Battler, battlers: Battler[], rng: Rng): void {
  // Recharge X–6: each spent attack comes back on a d6 roll ≥ X.
  if (enemy.spent && enemy.spent.length > 0) {
    enemy.spent = enemy.spent.filter((name) => {
      const atk = enemy.attacks.find((a) => a.name === name)
      return !(atk?.recharge && rollDie(rng, 6) >= atk.recharge)
    })
  }
  if (bossTurn(rng, enemy, battlers).consumed) return
  const plan = planEnemyTurn(enemy, battlers, currentLevel(s).map)
  if (plan.moves.length > 0) enemy.pos = plan.finalPos
  if (plan.heal) {
    const ally = battlers.find((b) => b.id === plan.heal!.targetId)
    if (ally && ally.hp > 0) ally.hp = Math.min(ally.maxHp, ally.hp + rollDamage(rng, plan.heal.dice).total)
  } else if (plan.attack) {
    const target = battlers.find((b) => b.id === plan.attack!.targetId)
    if (target) {
      const atk = plan.attack.attack
      const mode = combatMode(enemy, target, atk)
      // A Recharge attack is a single use per recharge (no Multiattack repeats).
      const swings = atk.recharge ? 1 : Math.max(1, enemy.attacksPerAction)
      for (let i = 0; i < swings; i++) {
        if (target.hp <= 0) break
        resolveAttack(rng, enemy, atk, target, mode, battlers)
      }
      if (atk.recharge) enemy.spent = [...(enemy.spent ?? []), atk.name]
    }
  }
}

/** Win when all enemies are down; lose when no one on the party's side can
 *  still act or come back: every member is dead or down-and-stable (a member
 *  still rolling death saves may roll a 20) and no summoned beast is left. */
export function outcome(battlers: Battler[]): 'won' | 'lost' | 'ongoing' {
  if (!battlers.some((b) => b.team === 'enemy' && b.hp > 0)) return 'won'
  const inIt = (b: Battler): boolean =>
    b.team === 'player' && (b.summoner !== undefined ? b.hp > 0 : !!b.deathSaves && !b.deathSaves.dead && (b.hp > 0 || !b.deathSaves.stable))
  if (!battlers.some(inIt)) return 'lost'
  return 'ongoing'
}

export function finishCombat(s: RunState, won: boolean, rng: Rng): void {
  const c = s.combat
  if (!c) return
  if (!won) {
    for (const m of aliveMembers(s)) killMember(s, m, 'combat')
    finishRun(s, false, 'wiped')
    return
  }
  // XP only for foes actually killed (a fight stopped by the round cap leaves
  // survivors, who simply wander off).
  let gain = 0
  for (const id of c.engaged) {
    const spawn = s.remaining.find((e) => e.id === id)
    const mon = spawn ? getMonster(spawn.key) : undefined
    const killed = spawn ? c.enemies.some((b) => b.id === `${spawn.key}-${spawn.id}` && b.hp <= 0) : false
    if (mon && killed) gain += monsterXp(mon.maxHp, mon.role)
  }
  for (const m of aliveMembers(s)) {
    delete m.battler.concentration
    // Downed-but-not-dead survivors stabilise at 1 HP.
    if (m.battler.hp <= 0 && m.battler.deathSaves && !m.battler.deathSaves.dead) m.battler.hp = 1
    removeCondition(m.battler, 'unconscious')
    const prog = applyXp(charLevelOf(m.spec.classLevels), m.xp, gain)
    m.xp = prog.xp
    if (prog.levelsGained > 0) {
      levelUp(m, prog.levelsGained)
      m.hitDice += prog.levelsGained
    }
  }
  // Spend Scrolls of Resurrection to bring fallen teammates back at 1 HP.
  while (s.scrolls > 0) {
    const dead = s.members.find((m) => !m.alive)
    if (!dead) break
    s.scrolls--
    dead.alive = true
    delete dead.deathLevel
    delete dead.deathCause
    delete dead.stats.killedBy
    dead.battler.hp = 1
    dead.battler.deathSaves = { successes: 0, failures: 0, stable: false, dead: false }
    removeCondition(dead.battler, 'unconscious')
  }
  s.remaining = s.remaining.filter((e) => !c.engaged.includes(e.id))
  shortRestAfterFight(s, rng)
  s.combat = null
  s.phase = 'explore'
}

/** Total HP of a side (summoned beasts excluded: they are not party HP). */
export function sumHp(battlers: Battler[], team: 'player' | 'enemy'): number {
  return battlers.reduce((sum, b) => (b.team === team && b.summoner === undefined ? sum + Math.max(0, b.hp) : sum), 0)
}

export function enemiesUp(battlers: Battler[]): number {
  return battlers.filter((b) => b.team === 'enemy' && b.hp > 0).length
}

/** Members whose battler died outright (e.g. massive damage) leave the party. */
export function syncDeaths(s: RunState, c: CombatState): void {
  for (const id of c.memberIds) {
    const m = memberById(s, id)
    if (m.alive && m.battler.deathSaves?.dead) killMember(s, m, 'combat')
  }
}

/** Close a human member's turn: end-of-turn saves, then the next battler. */
export function endHumanTurn(s: RunState, c: CombatState, rng: Rng): void {
  const turn = c.humanTurn
  if (!turn) return
  const member = memberById(s, turn.memberId)
  member.stats.turns++
  endOfTurnSaves(rng, member.battler)
  member.battler.frenzyAttackPending = false
  delete c.humanTurn
  gotoNext(c)
}

export function combatStep(s: RunState, c: CombatState, rng: Rng, decide: Rng): void {
  syncDeaths(s, c)
  const battlers = combatBattlers(s, c)
  enforceConcentration(battlers)
  const o = outcome(battlers)
  if (o !== 'ongoing') {
    finishCombat(s, o === 'won', rng)
    return
  }
  if (c.round > COMBAT_ROUND_CAP) {
    finishCombat(s, c.memberIds.some((id) => memberById(s, id).battler.hp > 0), rng)
    return
  }
  const actor = battlers.find((b) => b.id === c.order[c.turn])
  if (!actor || isOutOfFight(actor)) {
    gotoNext(c)
    return
  }
  if (actor.team === 'enemy' || actor.summoner !== undefined) {
    removeCondition(actor, 'dodging')
    tickConditions(actor)
    if (!isIncapacitated(actor)) {
      if (actor.summoner !== undefined) runSummonTurn(s, actor, battlers, rng)
      else runEnemyTurn(s, actor, battlers, rng)
    }
    endOfTurnSaves(rng, actor)
    gotoNext(c)
    return
  }
  const member = s.members.find((m) => m.battler.id === actor.id)
  if (!member) {
    gotoNext(c)
    return
  }
  if (actor.hp <= 0) {
    const ds = actor.deathSaves
    if (ds && !ds.dead && !ds.stable) rollDeathSave(rng, actor)
    if (actor.deathSaves?.dead) killMember(s, member, 'combat')
    gotoNext(c)
    return
  }
  if (c.surprised && c.round === 1) {
    member.stats.surprisedTurns++
    gotoNext(c)
    return
  }
  removeCondition(actor, 'dodging')
  tickConditions(actor)
  if (isIncapacitated(actor)) {
    endOfTurnSaves(rng, actor)
    gotoNext(c)
    return
  }
  if (member.control === 'human') {
    // Wait for the human: play/manual applies the turn and calls endHumanTurn.
    actor.sneakAttackUsed = false
    actor.colossusSlayerUsed = false
    const stuck = hasCondition(actor, 'restrained') || hasCondition(actor, 'grappled')
    c.humanTurn = { memberId: member.memberId, movementLeft: stuck ? 0 : actor.speedTiles, actionUsed: false, bonusUsed: false, attacksLeft: 0, bonusSpell: false, surged: false }
    return
  }
  botMemberTurn(s, c, actor, member, battlers, rng, decide)
}

/** A member's turn played by its genome's bot: the cast-wand bonus action,
 *  the bot policy, telemetry, end-of-turn saves; then the next battler. */
export function botMemberTurn(s: RunState, c: CombatState, actor: Battler, member: MemberState, battlers: Battler[], rng: Rng, decide: Rng): void {
  // Bonus-action item: fire a held cast-wand at the weakest foe.
  if (s.castCharges > 0) {
    const foes = battlers.filter((b) => b.team === 'enemy' && b.hp > 0)
    if (foes.length > 0) {
      const tgt = foes.reduce((w, b) => (b.hp < w.hp ? b : w), foes[0])
      const before = tgt.hp
      resolveAttack(rng, actor, BOT_WAND, tgt, combatMode(actor, tgt, BOT_WAND))
      s.castCharges--
      member.damage += Math.max(0, before - tgt.hp)
      if (before > 0 && tgt.hp <= 0) member.kills++
      member.usage['Wand (item)'] = (member.usage['Wand (item)'] ?? 0) + 1
    }
  }
  const enemyHpBefore = sumHp(battlers, 'enemy')
  const partyHpBefore = sumHp(battlers, 'player')
  const upBefore = enemiesUp(battlers)
  const slotsBefore = (actor.spellSlots ?? []).reduce((a, b) => a + b, 0)
  const potionsBefore = actor.potions ?? 0
  const kind = botPlayerTurn(actor, battlers, currentLevel(s).map, rng, decide, member.genes, member.usage, turnContext(c))
  member.stats.turns++
  if (kind === 'move' || kind === 'idle') member.stats.idleTurns++
  if (kind === 'retreat') member.stats.retreatTurns++
  member.stats.slotsSpent += Math.max(0, slotsBefore - (actor.spellSlots ?? []).reduce((a, b) => a + b, 0))
  member.stats.potionsUsed += Math.max(0, potionsBefore - (actor.potions ?? 0))
  member.damage += Math.max(0, enemyHpBefore - sumHp(battlers, 'enemy'))
  member.healing += Math.max(0, sumHp(battlers, 'player') - partyHpBefore)
  member.kills += Math.max(0, upBefore - enemiesUp(battlers))
  endOfTurnSaves(rng, actor)
  gotoNext(c)
}
