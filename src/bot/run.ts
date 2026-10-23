import type { GameMap, Vec2 } from '../game/types'
import { isWalkable } from '../game/map'
import { tileDistance } from '../game/logic'
import { lineOfSight, visibleTiles } from '../game/los'
import { rollDamage, rollDie, type Rng } from '../combat/dice'
import { buildPlayerBattler, buildEnemyBattler, charLevelOf, cloneAttack, rollInitiative } from '../combat/setup'
import { getMonster } from '../combat/monsters'
import { resolveAttack, combatMode, tickConditions, rollDeathSave } from '../combat/resolve'
import { planEnemyTurn } from '../combat/ai'
import { bossTurn } from '../combat/boss'
import { canTakeLevelIn } from '../combat/multiclass'
import { isOutOfFight, removeCondition, type Battler, type CombatAttack } from '../combat/types'
import { generateLevelForRun, RUN_LENGTH } from '../dungeon/generate'
import type { Level } from '../dungeon/levels'
import { applyXp, monsterXp } from '../dungeon/leveling'
import { drawRewards, effectScore, getArtifact, pickArtifact, type ArtifactEffect, type LootWeights } from '../items/artifacts'
import { GEAR, usableGear, type GearItem } from '../items/gear'
import { buildCharacter, starterSpec, validateCharacterSpec, type CharacterSpec, type ClassKey } from '../character/build'
import { casterSlots, profBonus } from '../character/progression'
import { deriveSeed, rngOf, seedRng, type RngState } from '../rng'
import { genomeHash, lootWeights, validateGenome, type Genes, type Genome } from './genome'
import { botPlayerTurn } from './policy'
import { maxResources, restoreResources } from '../combat/abilities'
import type { UsageTally } from './usage'

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

export const RUN_STATE_SCHEMA = 'dungeon-gym/run'
export const RUN_STATE_VERSION = 1

const ENGAGE_RADIUS = 4
const TRAP_DAMAGE = { count: 2, sides: 4, bonus: 0 }
const SHRINE_FRAC = 0.4
/** Step budget per dungeon level (the cap is depth × this); hitting it is a loss. */
export const STEPS_PER_LEVEL = 8000
/** Deepest allowed run. */
export const MAX_DEPTH = 50
/** A fight dragging past this many rounds is resolved by who's still standing. */
const COMBAT_ROUND_CAP = 60
/** Exploration: how far the party sees while sweeping a level. */
const VISION_RADIUS = 6
const STARTING_POTIONS = 1
/** Found-gear weapon numbers assume a +3 proficiency (level 5); higher levels add the difference. */
const GEAR_BASE_PROF = 3
/** The held cast-wand a bot fires as a bonus action while it has charges. */
const BOT_WAND: CombatAttack = { name: 'Wand', toHit: 6, damage: { count: 2, sides: 6, bonus: 0 }, damageType: 'fire', range: 24, source: 'spell' }

export type RunPhase = 'explore' | 'combat' | 'done'
/** won = cleared the last level · wiped = party dead · step-cap = budget spent · stuck = no path. */
export type EndReason = 'won' | 'wiped' | 'step-cap' | 'stuck'
/** stalled = the run ended by step cap / no path while the member was still up. */
export type DeathCause = 'combat' | 'trap' | 'stalled'

export interface PartyMemberInit {
  genome: Genome
  /** The character; defaults to the class's starting character. */
  spec?: CharacterSpec
  name?: string
}

export interface RunConfig {
  seed: number
  /** Number of dungeon levels (default 5). */
  depth?: number
  party: PartyMemberInit[]
}

interface Spawn {
  id: number
  key: string
  pos: Vec2
}

/** Equipment slots for found gear (a ring fits either ring slot). */
export type GearSlot = 'mainHand' | 'offHand' | 'armor' | 'helmet' | 'legs' | 'boots' | 'ring1' | 'ring2' | 'amulet'

export interface MemberState {
  memberId: number
  name: string
  classKey: ClassKey
  genomeHash: string
  genes: Genes
  /** The character; its classLevels grow with level-ups. */
  spec: CharacterSpec
  startLevel: number
  /** Found gear by slot (keys of items/gear). One item per slot — no stacking. */
  equipped: Partial<Record<GearSlot, string>>
  battler: Battler
  usage: UsageTally
  /** Artifact keys picked so far (their bonuses stack — each is unique). */
  owned: string[]
  xp: number
  depthReached: number
  alive: boolean
  deathLevel?: number
  deathCause?: DeathCause
  damage: number
  healing: number
  kills: number
}

export interface CombatState {
  /** Members that started this fight (dead ones stay listed). */
  memberIds: number[]
  enemies: Battler[]
  /** Battler ids in initiative order. */
  order: string[]
  turn: number
  round: number
  /** Explore-triggered fights surprise the party: it loses round 1. */
  surprised: boolean
  /** Spawn ids taking part in this fight. */
  engaged: number[]
}

export interface RunState {
  schema: typeof RUN_STATE_SCHEMA
  version: typeof RUN_STATE_VERSION
  seed: number
  depth: number
  enemyScale: number
  /** Dice / loot / initiative stream. */
  rng: RngState
  /** The bots' own policy coin-flips (see bot/policy). */
  policyRng: RngState
  levelIndex: number
  /** The current level (null between levels). */
  level: Level | null
  phase: RunPhase
  endReason: EndReason | null
  won: boolean
  steps: number
  maxSteps: number
  /** The party's lead position during exploration. */
  pos: Vec2
  remaining: Spawn[]
  nextSpawnId: number
  traps: { pos: Vec2; armed: boolean }[]
  shrines: { pos: Vec2; used: boolean }[]
  /** Per-tile flags (index x + y·width) for the current level. */
  seen: number[]
  reachable: number[]
  reachableFloor: number
  seenCount: number
  exploreSteps: number
  exploreBudget: number
  combat: CombatState | null
  /** Scrolls of Resurrection held (auto-used to revive the fallen). */
  scrolls: number
  /** Long-rest kits held (a short rest becomes a long one). */
  longRestKits: number
  /** Charges on a found cast-wand. */
  castCharges: number
  members: MemberState[]
}

/** One party member's outcome. */
export interface MemberResult {
  memberId: number
  name: string
  classKey: ClassKey
  genomeHash: string
  classLevels: Record<string, number>
  depthReached: number
  charLevel: number
  won: boolean
  alive: boolean
  deathLevel?: number
  deathCause?: DeathCause
  usage: UsageTally
  damage: number
  healing: number
  kills: number
}

export interface RunResult {
  seed: number
  depth: number
  won: boolean
  endReason: EndReason | null
  depthReached: number
  partySize: number
  steps: number
  members: MemberResult[]
}

export interface RunSnapshot {
  level: number
  charLevel: number
  partySize: number
  phase: RunPhase
  alive: boolean
  won: boolean
  map: GameMap | null
  players: { pos: Vec2; classKey: string; name: string; hp: number; maxHp: number; alive: boolean }[]
  enemies: { pos: Vec2; glyph: string; hp: number; maxHp: number }[]
}

const DIRS: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
]

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

const isWeapon = (a: CombatAttack): boolean => !a.source || a.source === 'weapon'

function gearByKey(key: string): GearItem | undefined {
  return GEAR.find((g) => g.key === key)
}

/**
 * Derive a member's battler from its character spec + found gear + bonuses.
 * With `prev`, live state carries over (HP shifted by any max-HP change,
 * conditions, death saves, potions, position, per-fight flags); spell slots
 * carry over unless `refillSlots` (a level-up refills them).
 */
type Totals = Required<ArtifactEffect>

/** Flat bonuses from the member's artifacts and worn trinkets (not weapon/armour). */
function flatBonus(m: MemberState): Totals {
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

function deriveBattler(m: MemberState, prev: Battler | null, refillSlots: boolean): Battler {
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
    b.resources = { rage: keep('rage'), secondWind: keep('secondWind'), actionSurge: keep('actionSurge'), inspiration: keep('inspiration') }
  }
  if (prev.inspirationDie !== undefined) b.inspirationDie = prev.inspirationDie
  return b
}

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
      depthReached: 1,
      alive: true,
      damage: 0,
      healing: 0,
      kills: 0,
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
    members,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function aliveMembers(s: RunState): MemberState[] {
  return s.members.filter((m) => m.alive)
}

function memberById(s: RunState, id: number): MemberState {
  const m = s.members.find((x) => x.memberId === id)
  if (!m) throw new Error(`run: no member ${id}`)
  return m
}

function currentLevel(s: RunState): Level {
  if (!s.level) throw new Error('run: no level loaded')
  return s.level
}

/** The fight's battlers: participating members first, then enemies (stable order). */
function combatBattlers(s: RunState, c: CombatState): Battler[] {
  return [...c.memberIds.map((id) => memberById(s, id).battler), ...c.enemies]
}

function bfsNextStep(map: GameMap, from: Vec2, goal: Vec2): Vec2 | null {
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

/** Free tiles fanning out from the party's tile (BFS through walkable floor
 *  only, never through walls or onto a foe), to spread the party for a fight. */
function spreadPositions(map: GameMap, center: Vec2, n: number, blocked: Set<string>): Vec2[] {
  const out: Vec2[] = []
  const seen = new Set<string>([`${center.x},${center.y}`])
  const q: Vec2[] = [center]
  let head = 0
  while (head < q.length && out.length < n) {
    const p = q[head++]
    out.push(p)
    for (const [dx, dy] of DIRS) {
      const nx = p.x + dx
      const ny = p.y + dy
      const k = `${nx},${ny}`
      if (seen.has(k) || blocked.has(k) || !isWalkable(map, nx, ny)) continue
      seen.add(k)
      q.push({ x: nx, y: ny })
    }
  }
  while (out.length < n) out.push({ ...center })
  return out
}

/** 8-connected reachable floor from a start, as a 0/1 flag array. */
function reachableFrom(map: GameMap, from: Vec2): { flags: number[]; count: number } {
  const W = map.width
  const flags = new Array<number>(W * map.height).fill(0)
  flags[from.x + from.y * W] = 1
  let count = 1
  const q: Vec2[] = [from]
  let head = 0
  while (head < q.length) {
    const p = q[head++]
    for (const [dx, dy] of DIRS) {
      const nx = p.x + dx
      const ny = p.y + dy
      if (!isWalkable(map, nx, ny)) continue
      const i = nx + ny * W
      if (flags[i]) continue
      flags[i] = 1
      count++
      q.push({ x: nx, y: ny })
    }
  }
  return { flags, count }
}

/** Reveal the field of view around a point (only reachable floor counts). */
function reveal(s: RunState, map: GameMap, at: Vec2): void {
  for (const t of visibleTiles(map, at, VISION_RADIUS)) {
    const i = t.x + t.y * map.width
    if (s.reachable[i] && !s.seen[i]) {
      s.seen[i] = 1
      s.seenCount++
    }
  }
}

/** The nearest UNSEEN reachable tile (BFS frontier), or null. */
function nearestUnseen(s: RunState, map: GameMap): Vec2 | null {
  const W = map.width
  const H = map.height
  const visited = new Uint8Array(W * H)
  const q: Vec2[] = [s.pos]
  visited[s.pos.x + s.pos.y * W] = 1
  let head = 0
  while (head < q.length) {
    const p = q[head++]
    if (!s.seen[p.x + p.y * W] && !(p.x === s.pos.x && p.y === s.pos.y)) return p
    for (const [dx, dy] of DIRS) {
      const nx = p.x + dx
      const ny = p.y + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const ni = nx + ny * W
      if (visited[ni] || !isWalkable(map, nx, ny)) continue
      visited[ni] = 1
      q.push({ x: nx, y: ny })
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Level flow
// ---------------------------------------------------------------------------

function loadLevel(s: RunState): void {
  const lvl = generateLevelForRun(s.seed, s.levelIndex, s.levelIndex === s.depth - 1, { enemyScale: s.enemyScale })
  s.level = lvl
  s.pos = { ...lvl.map.spawn }
  s.remaining = lvl.enemies.map((e) => ({ id: s.nextSpawnId++, key: e.key, pos: { ...e.pos } }))
  s.traps = lvl.traps.map((p) => ({ pos: { ...p }, armed: true }))
  s.shrines = lvl.shrines.map((p) => ({ pos: { ...p }, used: false }))
  for (const m of s.members) {
    if (!m.alive) continue
    m.battler.pos = { ...s.pos }
    m.depthReached = Math.max(m.depthReached, s.levelIndex + 1)
  }
  const reach = reachableFrom(lvl.map, s.pos)
  s.reachable = reach.flags
  s.reachableFloor = reach.count
  s.seen = new Array<number>(reach.flags.length).fill(0)
  s.seenCount = 0
  s.exploreSteps = 0
  s.exploreBudget = Math.min(3000, Math.max(200, s.reachableFloor * 2))
  reveal(s, lvl.map, s.pos)
}

function finishRun(s: RunState, won: boolean, reason: EndReason): void {
  s.phase = 'done'
  s.won = won
  s.endReason = reason
  s.combat = null
  if (won) return
  for (const m of s.members) {
    if (!m.alive) continue
    m.alive = false
    if (m.deathLevel === undefined) {
      m.deathLevel = s.levelIndex + 1
      m.deathCause = reason === 'wiped' ? 'combat' : 'stalled'
    }
  }
}

/** Camp between levels: survivors rest (long = full HP + all slots). */
function restParty(s: RunState, long: boolean): void {
  for (const m of s.members) {
    if (!m.alive) continue
    const b = m.battler
    b.resources = restoreResources(b.resources ?? maxResources(m.spec.classLevels, m.spec.abilityScores.cha), m.spec.classLevels, m.spec.abilityScores.cha, long)
    if (long) {
      b.hp = b.maxHp
      b.spellSlots = [...buildCharacter(m.spec).spellSlots]
      continue
    }
    // Short rest: top up to ~3/4 HP (Hit Dice); a warlock regains its Pact
    // Magic slots (added back, capped at the build's full table).
    b.hp = Math.max(b.hp, Math.floor(b.maxHp * 0.75))
    const warlockLv = m.spec.classLevels.warlock ?? 0
    const pact = warlockLv > 0 ? casterSlots('warlock', warlockLv) : null
    if (pact) {
      const full = buildCharacter(m.spec).spellSlots
      const slots = [...(b.spellSlots ?? [])]
      for (let i = 0; i < pact.length; i++) slots[i] = Math.min(full[i] ?? 0, (slots[i] ?? 0) + pact[i])
      b.spellSlots = slots
    }
  }
}

function avgDamage(a: CombatAttack): number {
  return (a.damage.count * (a.damage.sides + 1)) / 2 + a.damage.bonus
}

function gearEffectScore(key: string | undefined, w: LootWeights): number {
  const item = key ? gearByKey(key) : undefined
  return item?.effect ? effectScore(item.effect, w) : -Infinity
}

/** The slot a found item would go into (a ring takes a free or the weaker ring slot). */
function slotFor(m: MemberState, item: GearItem, w: LootWeights): GearSlot {
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
function grantReward(s: RunState, rng: Rng): void {
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

function nextLevel(s: RunState): void {
  s.levelIndex++
  if (s.levelIndex >= s.depth) {
    finishRun(s, true, 'won')
    return
  }
  let longRest = (s.levelIndex + 1) % 5 === 0
  if (!longRest && s.longRestKits > 0) {
    s.longRestKits--
    longRest = true
  }
  restParty(s, longRest)
  s.level = null
}

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

function spotted(s: RunState, map: GameMap): Spawn | null {
  for (const e of s.remaining) {
    const mon = getMonster(e.key)
    if (!mon) continue
    if (tileDistance(s.pos, e.pos) > mon.visionRadius) continue
    if (!lineOfSight(map, e.pos, s.pos)) continue
    return e
  }
  return null
}

function startCombat(s: RunState, spotter: Spawn, rng: Rng): void {
  const map = currentLevel(s).map
  const engaged = s.remaining.filter(
    (e) => e.id === spotter.id || (tileDistance(s.pos, e.pos) <= ENGAGE_RADIUS && lineOfSight(map, e.pos, s.pos)),
  )
  const alive = aliveMembers(s)
  const spots = spreadPositions(map, s.pos, alive.length, new Set(engaged.map((e) => `${e.pos.x},${e.pos.y}`)))
  alive.forEach((m, i) => {
    const b = m.battler
    b.pos = { ...spots[i] }
    b.conditions = []
    b.condTimers = {}
    b.deathSaves = { successes: 0, failures: 0, stable: false, dead: false }
    // Once-per-fight features refresh with every fight.
    b.darkOneLuckUsed = false
  })
  const enemies = engaged
    .map((e) => {
      const mon = getMonster(e.key)
      return mon ? buildEnemyBattler(mon, `${e.key}-${e.id}`, e.pos, s.levelIndex) : null
    })
    .filter((b): b is Battler => b !== null)
  const combat: CombatState = {
    memberIds: alive.map((m) => m.memberId),
    enemies,
    order: [],
    turn: 0,
    round: 1,
    surprised: true,
    engaged: engaged.map((e) => e.id),
  }
  combat.order = rollInitiative(rng, combatBattlers(s, combat)).order.map((b) => b.id)
  s.combat = combat
  s.phase = 'combat'
}

function gotoNext(c: CombatState): void {
  c.turn++
  if (c.turn >= c.order.length) {
    c.turn = 0
    c.round++
  }
}

function runEnemyTurn(s: RunState, enemy: Battler, battlers: Battler[], rng: Rng): void {
  if (bossTurn(rng, enemy, battlers).consumed) return
  const plan = planEnemyTurn(enemy, battlers, currentLevel(s).map)
  if (plan.moves.length > 0) enemy.pos = plan.finalPos
  if (plan.heal) {
    const ally = battlers.find((b) => b.id === plan.heal!.targetId)
    if (ally && ally.hp > 0) ally.hp = Math.min(ally.maxHp, ally.hp + rollDamage(rng, plan.heal.dice).total)
  } else if (plan.attack) {
    const target = battlers.find((b) => b.id === plan.attack!.targetId)
    if (target) {
      const mode = combatMode(enemy, target, plan.attack.attack)
      for (let i = 0; i < Math.max(1, enemy.attacksPerAction); i++) {
        if (target.hp <= 0) break
        resolveAttack(rng, enemy, plan.attack.attack, target, mode)
      }
    }
  }
}

/** Win when all enemies are down; lose when no party member is still in it
 *  (a downed member rolling death saves still counts). */
function outcome(battlers: Battler[]): 'won' | 'lost' | 'ongoing' {
  if (!battlers.some((b) => b.team === 'enemy' && b.hp > 0)) return 'won'
  if (!battlers.some((b) => b.team === 'player' && b.deathSaves && !b.deathSaves.dead)) return 'lost'
  return 'ongoing'
}

/** Apply XP-driven level-ups, following the genome's level-up order. */
function levelUp(m: MemberState, levelsGained: number): void {
  for (let i = 0; i < levelsGained; i++) {
    const idx = charLevelOf(m.spec.classLevels) - m.startLevel
    const wanted = m.genes.levelUpOrder[idx]
    const target = wanted && canTakeLevelIn(wanted, m.spec.classLevels, { ...m.spec.abilityScores }).ok ? wanted : m.classKey
    m.spec.classLevels[target] = (m.spec.classLevels[target] ?? 0) + 1
  }
  m.battler = deriveBattler(m, m.battler, true)
}

function finishCombat(s: RunState, won: boolean): void {
  const c = s.combat
  if (!c) return
  if (!won) {
    for (const m of aliveMembers(s)) {
      m.alive = false
      m.deathLevel = s.levelIndex + 1
      m.deathCause = 'combat'
    }
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
    // Downed-but-not-dead survivors stabilise at 1 HP.
    if (m.battler.hp <= 0 && m.battler.deathSaves && !m.battler.deathSaves.dead) m.battler.hp = 1
    removeCondition(m.battler, 'unconscious')
    const prog = applyXp(charLevelOf(m.spec.classLevels), m.xp, gain)
    m.xp = prog.xp
    if (prog.levelsGained > 0) levelUp(m, prog.levelsGained)
  }
  // Spend Scrolls of Resurrection to bring fallen teammates back at 1 HP.
  while (s.scrolls > 0) {
    const dead = s.members.find((m) => !m.alive)
    if (!dead) break
    s.scrolls--
    dead.alive = true
    delete dead.deathLevel
    delete dead.deathCause
    dead.battler.hp = 1
    dead.battler.deathSaves = { successes: 0, failures: 0, stable: false, dead: false }
    removeCondition(dead.battler, 'unconscious')
  }
  s.remaining = s.remaining.filter((e) => !c.engaged.includes(e.id))
  s.combat = null
  s.phase = 'explore'
}

function sumHp(battlers: Battler[], team: 'player' | 'enemy'): number {
  return battlers.reduce((sum, b) => (b.team === team ? sum + Math.max(0, b.hp) : sum), 0)
}

function enemiesUp(battlers: Battler[]): number {
  return battlers.filter((b) => b.team === 'enemy' && b.hp > 0).length
}

/** Members whose battler died outright (e.g. massive damage) leave the party. */
function syncDeaths(s: RunState, c: CombatState): void {
  for (const id of c.memberIds) {
    const m = memberById(s, id)
    if (m.alive && m.battler.deathSaves?.dead) {
      m.alive = false
      m.deathLevel = s.levelIndex + 1
      m.deathCause = 'combat'
    }
  }
}

function combatStep(s: RunState, c: CombatState, rng: Rng, decide: Rng): void {
  syncDeaths(s, c)
  const battlers = combatBattlers(s, c)
  const o = outcome(battlers)
  if (o !== 'ongoing') {
    finishCombat(s, o === 'won')
    return
  }
  if (c.round > COMBAT_ROUND_CAP) {
    finishCombat(s, battlers.some((b) => b.team === 'player' && b.hp > 0))
    return
  }
  const actor = battlers.find((b) => b.id === c.order[c.turn])
  if (!actor || isOutOfFight(actor)) {
    gotoNext(c)
    return
  }
  if (actor.team === 'enemy') {
    removeCondition(actor, 'dodging')
    tickConditions(actor)
    runEnemyTurn(s, actor, battlers, rng)
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
    if (actor.deathSaves?.dead) {
      member.alive = false
      member.deathLevel = s.levelIndex + 1
      member.deathCause = 'combat'
    }
    gotoNext(c)
    return
  }
  if (c.surprised && c.round === 1) {
    gotoNext(c)
    return
  }
  removeCondition(actor, 'dodging')
  tickConditions(actor)
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
  botPlayerTurn(actor, battlers, currentLevel(s).map, rng, decide, member.genes, member.usage)
  member.damage += Math.max(0, enemyHpBefore - sumHp(battlers, 'enemy'))
  member.healing += Math.max(0, sumHp(battlers, 'player') - partyHpBefore)
  member.kills += Math.max(0, upBefore - enemiesUp(battlers))
  gotoNext(c)
}

// ---------------------------------------------------------------------------
// Exploration
// ---------------------------------------------------------------------------

function exploreStep(s: RunState, rng: Rng): void {
  if (!s.level) {
    loadLevel(s)
    return
  }
  const map = s.level.map
  if (s.pos.x === map.waypoint.x && s.pos.y === map.waypoint.y) {
    grantReward(s, rng)
    nextLevel(s)
    return
  }
  // Sweep toward the nearest unseen tile until the leader's coverage target is
  // met or the per-level budget is spent, then head for the exit.
  const leader = aliveMembers(s)[0]
  const coverage = leader ? leader.genes.exploreCoverage : 0
  const covered = s.reachableFloor > 0 && s.seenCount / s.reachableFloor >= coverage
  const budgetSpent = s.exploreSteps >= s.exploreBudget
  let target: Vec2 = map.waypoint
  let toExit = true
  if (!covered && !budgetSpent) {
    const frontier = nearestUnseen(s, map)
    if (frontier) {
      target = frontier
      toExit = false
    }
  }
  let next = bfsNextStep(map, s.pos, target)
  if (!next && !toExit) next = bfsNextStep(map, s.pos, map.waypoint)
  if (!next) {
    finishRun(s, false, 'stuck')
    return
  }
  s.pos = next
  s.exploreSteps++
  for (const m of aliveMembers(s)) m.battler.pos = { ...next }
  reveal(s, map, s.pos)
  // Trap underfoot — hits the member leading the march.
  const trap = s.traps.find((t) => t.armed && t.pos.x === next.x && t.pos.y === next.y)
  if (trap) {
    trap.armed = false
    const victim = aliveMembers(s)[0]
    if (victim) {
      victim.battler.hp = Math.max(0, victim.battler.hp - rollDamage(rng, TRAP_DAMAGE).total)
      if (victim.battler.hp <= 0) {
        victim.alive = false
        victim.deathLevel = s.levelIndex + 1
        victim.deathCause = 'trap'
      }
    }
    if (aliveMembers(s).length === 0) {
      finishRun(s, false, 'wiped')
      return
    }
  }
  // Healing shrine underfoot — mend the whole party once.
  const shrine = s.shrines.find((sh) => !sh.used && sh.pos.x === next.x && sh.pos.y === next.y)
  if (shrine) {
    shrine.used = true
    for (const m of aliveMembers(s)) m.battler.hp = Math.min(m.battler.maxHp, m.battler.hp + Math.round(m.battler.maxHp * SHRINE_FRAC))
  }
  const spotter = spotted(s, map)
  if (spotter) startCombat(s, spotter, rng)
}

// ---------------------------------------------------------------------------
// Public stepping API
// ---------------------------------------------------------------------------

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
  if (s.phase === 'combat' && s.combat) {
    enemies = s.combat.enemies.filter((b) => b.hp > 0).map((b) => ({ pos: { ...b.pos }, glyph: b.glyph, hp: b.hp, maxHp: b.maxHp }))
  } else if (map) {
    enemies = s.remaining.map((e) => ({ pos: { ...e.pos }, glyph: getMonster(e.key)?.glyph ?? '?', hp: 1, maxHp: 1 }))
  }
  return {
    level: s.levelIndex + 1,
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
