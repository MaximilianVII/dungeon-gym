import { describe, it, expect } from 'vitest'
import { createRun, isRunDone, playRun, runResult, runToEnd, type RunState } from '../src/bot/run'
import { baselineGenome } from '../src/bot/genome'
import { advanceToInput, applyPlayerAction, checkAction, legalActions, pendingInput, type PlayerAction } from '../src/play/manual'
import { isWalkable } from '../src/game/map'
import type { ClassKey } from '../src/character/build'
import type { Battler } from '../src/combat/types'
import { BENCHMARK } from '../src/train/evaluate'

function humanRun(cls: ClassKey, seed: number, depth = 2, mates: ClassKey[] = []): RunState {
  return createRun({ seed, depth, party: [{ genome: baselineGenome(cls), control: 'human' }, ...mates.map((c) => ({ genome: baselineGenome(c) }))] })
}

/** Auto-play until the human has a combat turn; then stand next to the first
 *  living foe, and make every foe tough enough for a long fight. */
function firstCombatTurn(cls: ClassKey, seed: number, mates: ClassKey[] = []): RunState {
  let s = advanceToInput(humanRun(cls, seed, 3, mates))
  while (!isRunDone(s) && pendingInput(s)?.kind !== 'combat') s = applyPlayerAction(s, { kind: 'auto' })
  expect(pendingInput(s)?.kind).toBe('combat')
  const c = s.combat!
  const me = s.members[0].battler
  const foe = c.enemies.find((e) => e.hp > 0)!
  const map = s.level!.map
  const taken = (x: number, y: number): boolean =>
    [...s.members.map((m) => m.battler), ...c.allies, ...c.enemies].some((b) => b.hp > 0 && b !== me && b.pos.x === x && b.pos.y === y)
  const spot = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    .map(([dx, dy]) => ({ x: foe.pos.x + dx, y: foe.pos.y + dy }))
    .find((p) => isWalkable(map, p.x, p.y) && !taken(p.x, p.y))
  if (spot) me.pos = spot
  for (const e of c.enemies) e.hp = e.maxHp = 500
  return s
}

const foeOf = (s: RunState): Battler => s.combat!.enemies.find((e) => e.hp > 0)!

describe('manual play — exploration', () => {
  it('waits for the human leader, offers adjacent moves and never mutates its input', () => {
    const s = advanceToInput(humanRun('fighter', 77))
    expect(pendingInput(s)).toEqual({ kind: 'explore', memberId: 0 })
    const moves = legalActions(s).filter((a): a is Extract<PlayerAction, { kind: 'move' }> => a.kind === 'move')
    expect(moves.length).toBeGreaterThan(0)
    expect(legalActions(s)).toContainEqual({ kind: 'auto' })
    const before = JSON.stringify(s)
    const next = applyPlayerAction(s, moves[0])
    expect(JSON.stringify(s)).toBe(before)
    if (next.phase === 'explore') expect(next.pos).toEqual(moves[0].to)
    expect(() => applyPlayerAction(s, { kind: 'move', to: { x: s.pos.x + 3, y: s.pos.y } })).toThrow(/one tile/)
    expect(() => applyPlayerAction(s, { kind: 'potion' })).toThrow(/illegal/)
    expect(checkAction(s, { kind: 'end-turn' })).toMatch(/only move or auto/)
  })

  it('stepping stops at a human decision; bot-only runs never ask for input', () => {
    const s = humanRun('rogue', 5)
    runToEnd(s)
    expect(isRunDone(s)).toBe(false)
    expect(pendingInput(s)).not.toBeNull()
    const bots = createRun({ seed: 5, depth: 1, party: [{ genome: baselineGenome('rogue') }] })
    expect(legalActions(bots)).toEqual([])
    expect(checkAction(bots, { kind: 'auto' })).toMatch(/no input/)
    expect(() => createRun({ seed: 1, depth: 1, party: [{ genome: baselineGenome('rogue'), control: 'robot' as never }] })).toThrow(/control/)
  })
})

describe('manual play — determinism', () => {
  it('a human who always picks auto plays exactly the bot run', () => {
    for (const cls of ['fighter', 'wizard', 'druid'] as ClassKey[]) {
      const seed = BENCHMARK.seeds[3]
      let s = advanceToInput(humanRun(cls, seed, 3))
      while (!isRunDone(s)) s = applyPlayerAction(s, { kind: 'auto' })
      expect(runResult(s)).toEqual(playRun({ seed, depth: 3, party: [{ genome: baselineGenome(cls) }] }))
    }
  })

  it('the same state and action always give the same next state, also through JSON', () => {
    const s = firstCombatTurn('fighter', BENCHMARK.seeds[0])
    const act = legalActions(s).find((a) => a.kind === 'attack')!
    const a = applyPlayerAction(s, act)
    const b = applyPlayerAction(JSON.parse(JSON.stringify(s)) as RunState, act)
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })
})

describe('manual play — a combat turn', () => {
  it('Extra Attack swings, Action Surge, Second Wind, then end-turn', () => {
    let s = firstCombatTurn('fighter', BENCHMARK.seeds[0])
    const swing: PlayerAction = { kind: 'attack', attack: 'Longsword', target: foeOf(s).id }
    s = applyPlayerAction(s, swing)
    expect(pendingInput(s)?.turn).toMatchObject({ actionUsed: true, attacksLeft: 1 })
    s = applyPlayerAction(s, swing)
    expect(checkAction(s, swing)).toMatch(/action is used/)
    expect(checkAction(s, { kind: 'potion' })).toMatch(/action is used/)
    s = applyPlayerAction(s, { kind: 'feature', feature: 'action-surge' })
    expect(pendingInput(s)?.turn).toMatchObject({ actionUsed: false, surged: true })
    expect(checkAction(s, { kind: 'feature', feature: 'action-surge' })).not.toBeNull()
    s = applyPlayerAction(s, swing)
    s = applyPlayerAction(s, { kind: 'feature', feature: 'second-wind' })
    expect(checkAction(s, { kind: 'feature', feature: 'second-wind' })).toMatch(/Second Wind/)
    expect(s.members[0].usage.Longsword).toBe(3)
    const turnsBefore = s.members[0].stats.turns
    s = applyPlayerAction(s, { kind: 'end-turn' })
    expect(s.members[0].stats.turns).toBe(turnsBefore + 1)
  })

  it('moves one tile at a time within the movement budget; Cunning Action dashes or hides', () => {
    const s = firstCombatTurn('rogue', BENCHMARK.seeds[1])
    const move = legalActions(s).find((a): a is Extract<PlayerAction, { kind: 'move' }> => a.kind === 'move')!
    const next = applyPlayerAction(s, move)
    expect(next.members[0].battler.pos).toEqual(move.to)
    expect(pendingInput(next)?.turn?.movementLeft).toBe(s.members[0].battler.speedTiles - 1)
    const dash = applyPlayerAction(s, { kind: 'feature', feature: 'dash' })
    expect(pendingInput(dash)?.turn?.movementLeft).toBe(2 * s.members[0].battler.speedTiles)
    expect(applyPlayerAction(s, { kind: 'feature', feature: 'hide' }).members[0].usage.Hide).toBe(1)
    expect(checkAction(s, { kind: 'feature', feature: 'rage' })).toMatch(/rage/)
  })

  it('casters: a bonus-action heal limits the action to a cantrip; area spells spend a slot', () => {
    let s = firstCombatTurn('cleric', BENCHMARK.seeds[2])
    const me = s.members[0].battler
    me.hp = 5
    s = applyPlayerAction(s, { kind: 'heal', spell: 'Healing Word', target: me.id })
    expect(s.members[0].battler.hp).toBeGreaterThan(5)
    const foe = foeOf(s)
    expect(checkAction(s, { kind: 'attack', attack: 'Inflict Wounds', target: foe.id })).toMatch(/only a cantrip/)
    expect(checkAction(s, { kind: 'attack', attack: 'Sacred Flame', target: foe.id })).toBeNull()
    expect(checkAction(s, { kind: 'heal', spell: 'Healing Word', target: me.id })).toMatch(/bonus action/)
    const w = firstCombatTurn('wizard', BENCHMARK.seeds[2])
    const area = legalActions(w).find((a) => a.kind === 'area')!
    expect(applyPlayerAction(w, area).members[0].stats.slotsSpent).toBe(w.members[0].stats.slotsSpent + 1)
  })

  it('control spells: Conjure Animals brings beasts in; Hold Person needs a humanoid target', () => {
    const d = firstCombatTurn('druid', BENCHMARK.seeds[4])
    const conj = applyPlayerAction(d, { kind: 'cast', spell: 'Conjure Animals' })
    expect(conj.members[0].usage['Conjure Animals']).toBe(1)
    const b = firstCombatTurn('bard', BENCHMARK.seeds[0])
    const foe = foeOf(b)
    foe.creatureType = 'humanoid'
    expect(checkAction(b, { kind: 'cast', spell: 'Hold Person', targets: [foe.id] })).toBeNull()
    expect(checkAction(b, { kind: 'cast', spell: 'Hold Person', targets: [] })).toMatch(/targets/)
    expect(checkAction(b, { kind: 'cast', spell: 'Nope' })).toMatch(/no such spell/)
    expect(applyPlayerAction(b, { kind: 'cast', spell: 'Hold Person', targets: [foe.id] }).members[0].usage['Hold Person']).toBe(1)
  })

  it('auto plays the turn with the genome, only from a fresh turn; Rage takes the bonus action', () => {
    const s = firstCombatTurn('barbarian', BENCHMARK.seeds[0])
    expect(checkAction(s, { kind: 'auto' })).toBeNull()
    expect(checkAction(s, { kind: 'attack', attack: 'Greataxe', target: foeOf(s).id, bonus: true })).toMatch(/no bonus attack/)
    const raged = applyPlayerAction(s, { kind: 'feature', feature: 'rage' })
    expect(checkAction(raged, { kind: 'auto' })).toMatch(/start of a turn/)
    // Frenzy's swing is a bonus action too — not on the turn the rage started.
    expect(checkAction(raged, { kind: 'attack', attack: 'Greataxe', target: foeOf(raged).id, bonus: true })).toMatch(/bonus action is used/)
    expect(applyPlayerAction(s, { kind: 'auto' }).members[0].stats.turns).toBe(s.members[0].stats.turns + 1)
  })

  it('class features and items from the turn menu', () => {
    const d = firstCombatTurn('druid', BENCHMARK.seeds[4])
    const shaped = applyPlayerAction(d, { kind: 'feature', feature: 'wild-shape' })
    expect(shaped.members[0].battler.wildShape).toBeDefined()
    expect(checkAction(shaped, { kind: 'cast', spell: 'Conjure Animals' })).toMatch(/Wild Shape/)
    const m = firstCombatTurn('monk', BENCHMARK.seeds[1])
    expect(applyPlayerAction(m, { kind: 'feature', feature: 'patient-defense' }).members[0].battler.conditions).toContain('dodging')
    const r = firstCombatTurn('ranger', BENCHMARK.seeds[1])
    const marked = applyPlayerAction(r, { kind: 'cast', spell: "Hunter's Mark", targets: [foeOf(r).id] })
    expect(marked.combat!.enemies.some((e) => e.condSource?.marked === 'p0')).toBe(true)
    r.members[0].battler.potions = 1
    r.castCharges = 2
    const drank = applyPlayerAction(r, { kind: 'potion' })
    expect(drank.members[0].battler.potions).toBe(0)
    const zapped = applyPlayerAction(r, { kind: 'wand', target: foeOf(r).id })
    expect(zapped.castCharges).toBe(1)
    const b = firstCombatTurn('bard', BENCHMARK.seeds[0], ['fighter'])
    const mate = b.members[1].battler
    mate.pos = { ...b.members[0].battler.pos }
    b.members[0].battler.resources!.inspiration = 2 // Cutting Words may have spent them already
    const inspired = applyPlayerAction(b, { kind: 'feature', feature: 'inspire', target: mate.id })
    expect(inspired.members[1].battler.conditions).toContain('inspired')
  })

  it('a human can play beside bot party-mates', () => {
    const s = firstCombatTurn('paladin', BENCHMARK.seeds[5], ['cleric'])
    expect(s.members[1].control).toBeUndefined()
    const next = applyPlayerAction(s, { kind: 'end-turn' })
    expect(isRunDone(next) || pendingInput(next) !== null).toBe(true)
  })
})
