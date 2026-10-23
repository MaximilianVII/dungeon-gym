import type { Battler } from '../combat/types'
import type { Level } from '../dungeon/levels'
import type { EndReason, DeathCause, MemberState, CombatState, RunState } from './types'

// ---------------------------------------------------------------------------
// Small accessors and terminal transitions over a RunState.
// ---------------------------------------------------------------------------

export function aliveMembers(s: RunState): MemberState[] {
  return s.members.filter((m) => m.alive)
}

export function memberById(s: RunState, id: number): MemberState {
  const m = s.members.find((x) => x.memberId === id)
  if (!m) throw new Error(`run: no member ${id}`)
  return m
}

export function currentLevel(s: RunState): Level {
  if (!s.level) throw new Error('run: no level loaded')
  return s.level
}

/** The fight's battlers: participating members first, then allied summons,
 *  then enemies (stable order). */
export function combatBattlers(s: RunState, c: CombatState): Battler[] {
  return [...c.memberIds.map((id) => memberById(s, id).battler), ...c.allies, ...c.enemies]
}

/** Mark a member dead (once), recording where and — for combat — by whom. */
export function killMember(s: RunState, m: MemberState, cause: DeathCause): void {
  m.alive = false
  if (m.deathLevel !== undefined) return
  m.deathLevel = s.levelIndex + 1
  m.deathCause = cause
  if (cause === 'trap') m.stats.killedBy = 'trap'
  else if (cause === 'combat' && m.stats.lastHitBy !== undefined) m.stats.killedBy = m.stats.lastHitBy
}

export function finishRun(s: RunState, won: boolean, reason: EndReason): void {
  s.phase = 'done'
  s.won = won
  s.endReason = reason
  s.combat = null
  if (won) return
  for (const m of s.members) {
    if (m.alive) killMember(s, m, reason === 'wiped' ? 'combat' : 'stalled')
  }
}
