import { charLevelOf } from '../combat/setup'
import { getMonster } from '../combat/monsters'
import type { Battler } from '../combat/types'
import { RUN_LENGTH } from '../dungeon/generate'
import { starterSpec, validateCharacterSpec, type CharacterSpec } from '../character/build'
import { deriveSeed, rngOf, seedRng } from '../rng'
import { genomeHash, validateGenome } from './genome'
import { RUN_STATE_SCHEMA, RUN_STATE_VERSION, STEPS_PER_LEVEL, MAX_DEPTH, type RunConfig, type MemberState, type RunState, type MemberResult, type RunResult, type RunSnapshot } from '../run/types'
import { deriveBattler } from '../run/members'
import { finishRun } from '../run/state'
import { combatStep } from '../run/combat'
import { exploreStep } from '../run/explore'

// ---------------------------------------------------------------------------
// A headless dungeon run played by a PARTY of 1–5 bots, as a pure state
// machine over plain JSON:
//
//   const state = createRun({ seed, depth, party: [{ genome }] })
//   while (!isRunDone(state)) stepRun(state)   // or runToEnd(state)
//   const result = runResult(state)
//
// EVERYTHING the run needs lives in `RunState` — the current level, the fight
// in progress, both RNG states, every battler — with no Set/Map/class/closure.
// So `JSON.parse(JSON.stringify(state))` at any step continues identically,
// and the same (seed, party) always produces the same result. Many runs can
// advance side by side (no module-level state).
//
// `stepRun` MUTATES the state it is given (a run is tens of thousands of steps;
// copying per step would dominate the cost). Clone first if you need the old one.
// ---------------------------------------------------------------------------

export { RUN_STATE_SCHEMA, RUN_STATE_VERSION, STEPS_PER_LEVEL, MAX_DEPTH } from '../run/types'
export type { RunPhase, EndReason, DeathCause, PartyMemberInit, RunConfig, GearSlot, MemberState, MemberStats, CombatState, RunState, MemberResult, RunResult, RunSnapshot } from '../run/types'
export { equipFoundGear } from '../run/members'

/** Start a run. Genomes are validated strictly (throws on a malformed one). */
export function createRun(config: RunConfig): RunState {
  if (config.party.length < 1 || config.party.length > 5) throw new Error('createRun: party size must be 1–5')
  if (!Number.isFinite(config.seed)) throw new Error('createRun: seed must be a finite number')
  const depth = config.depth ?? RUN_LENGTH
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) throw new Error(`createRun: depth must be an integer 1–${MAX_DEPTH}`)
  const seed = config.seed >>> 0
  const members: MemberState[] = config.party.map((p, i) => {
    const checked = validateGenome(p.genome)
    if (!checked.ok) throw new Error(`createRun: invalid genome for member ${i}: ${checked.errors.join('; ')}`)
    const genome = checked.genome
    if (p.spec) {
      const specErrors = validateCharacterSpec(p.spec)
      if (specErrors.length > 0) throw new Error(`createRun: invalid character for member ${i}: ${specErrors.join('; ')}`)
    }
    const spec = p.spec ? JSON.parse(JSON.stringify(p.spec)) as CharacterSpec : starterSpec(genome.classKey)
    if (spec.classKey !== genome.classKey) throw new Error(`createRun: member ${i} genome is for ${genome.classKey} but the character is a ${spec.classKey}`)
    const m: MemberState = {
      memberId: i,
      name: p.name ?? spec.name,
      classKey: genome.classKey,
      genomeHash: genomeHash(genome),
      genes: genome.genes,
      spec,
      startLevel: charLevelOf(spec.classLevels),
      equipped: {},
      battler: null as unknown as Battler,
      usage: {},
      owned: [],
      xp: 0,
      hitDice: charLevelOf(spec.classLevels),
      depthReached: 1,
      alive: true,
      damage: 0,
      healing: 0,
      kills: 0,
      stats: { turns: 0, idleTurns: 0, retreatTurns: 0, fights: 0, foesFaced: 0, maxFoes: 0, surprisedTurns: 0, slotsSpent: 0, potionsUsed: 0, damageTaken: 0 },
    }
    m.battler = deriveBattler(m, null, true)
    return m
  })
  return {
    schema: RUN_STATE_SCHEMA,
    version: RUN_STATE_VERSION,
    seed,
    depth,
    enemyScale: members.length,
    rng: seedRng(deriveSeed(seed, 'run')),
    policyRng: seedRng(deriveSeed(seed, 'policy')),
    levelIndex: 0,
    level: null,
    phase: 'explore',
    endReason: null,
    won: false,
    steps: 0,
    maxSteps: depth * STEPS_PER_LEVEL,
    pos: { x: 0, y: 0 },
    remaining: [],
    nextSpawnId: 1,
    traps: [],
    shrines: [],
    seen: [],
    reachable: [],
    reachableFloor: 0,
    seenCount: 0,
    exploreSteps: 0,
    exploreBudget: 0,
    combat: null,
    scrolls: 0,
    longRestKits: 0,
    castCharges: 0,
    shortRestsThisLevel: 0,
    members,
  }
}

export function isRunDone(s: RunState): boolean {
  return s.phase === 'done'
}

/** Advance the run by one unit (an exploration step or one combat turn). Mutates `s`. */
export function stepRun(s: RunState): void {
  if (s.phase === 'done') return
  if (s.steps >= s.maxSteps) {
    finishRun(s, false, 'step-cap')
    return
  }
  s.steps++
  const rng = rngOf(s.rng)
  if (s.phase === 'combat' && s.combat) combatStep(s, s.combat, rng, rngOf(s.policyRng))
  else exploreStep(s, rng)
}

/** Step until done (or `maxSteps` more steps) and return the result. */
export function runToEnd(s: RunState, maxSteps: number = Infinity): RunResult {
  for (let i = 0; i < maxSteps && s.phase !== 'done'; i++) stepRun(s)
  return runResult(s)
}

/** Convenience: create + play a whole run. */
export function playRun(config: RunConfig): RunResult {
  return runToEnd(createRun(config))
}

export function runResult(s: RunState): RunResult {
  return {
    seed: s.seed,
    depth: s.depth,
    won: s.won,
    endReason: s.endReason,
    depthReached: s.members.reduce((mx, m) => Math.max(mx, m.depthReached), 1),
    partySize: s.members.length,
    steps: s.steps,
    members: s.members.map((m) => {
      const r: MemberResult = {
        memberId: m.memberId,
        name: m.name,
        classKey: m.classKey,
        genomeHash: m.genomeHash,
        classLevels: { ...m.spec.classLevels },
        depthReached: m.depthReached,
        charLevel: charLevelOf(m.spec.classLevels),
        won: s.won && m.alive,
        alive: m.alive,
        usage: { ...m.usage },
        damage: m.damage,
        healing: m.healing,
        kills: m.kills,
        stats: { ...m.stats },
      }
      if (m.deathLevel !== undefined) r.deathLevel = m.deathLevel
      if (m.deathCause !== undefined) r.deathCause = m.deathCause
      return r
    }),
  }
}

/** A light view for rendering a run (positions, HP, the current map). */
export function runSnapshot(s: RunState): RunSnapshot {
  const map = s.level ? s.level.map : null
  let enemies: RunSnapshot['enemies'] = []
  let allies: RunSnapshot['allies'] = []
  const view = (b: Battler): RunSnapshot['enemies'][number] => ({ pos: { ...b.pos }, glyph: b.glyph, hp: b.hp, maxHp: b.maxHp })
  if (s.phase === 'combat' && s.combat) {
    enemies = s.combat.enemies.filter((b) => b.hp > 0).map(view)
    allies = s.combat.allies.filter((b) => b.hp > 0).map(view)
  } else if (map) {
    enemies = s.remaining.map((e) => ({ pos: { ...e.pos }, glyph: getMonster(e.key)?.glyph ?? '?', hp: 1, maxHp: 1 }))
  }
  return {
    level: s.levelIndex + 1,
    allies,
    charLevel: s.members.reduce((mx, m) => Math.max(mx, charLevelOf(m.spec.classLevels)), 1),
    partySize: s.members.length,
    phase: s.phase,
    alive: s.members.some((m) => m.alive),
    won: s.won,
    map,
    players: s.members.map((m) => ({
      pos: s.phase === 'combat' ? { ...m.battler.pos } : { ...s.pos },
      classKey: m.classKey,
      name: m.name,
      hp: Math.max(0, m.battler.hp),
      maxHp: m.battler.maxHp,
      alive: m.alive,
    })),
    enemies,
  }
}

/** Deep copy of a run state (it is plain JSON). */
export function cloneRunState(s: RunState): RunState {
  return JSON.parse(JSON.stringify(s)) as RunState
}
