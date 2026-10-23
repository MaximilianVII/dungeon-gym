import { hashString } from '../rng'
import type { ClassKey } from '../character/build'
import { baselineGenome, MAX_GENOME_CHARS, serializeGenome, validateGenome, type Genome } from './genome'

// ---------------------------------------------------------------------------
// A TEAM is the uploadable artifact of party training: a fixed line-up of
// full genomes (one per party member, in order). A team is always evaluated
// whole — the same members play every run; nothing is recombined per run.
//
//   { "schema": "dungeon-gym/team", "version": 1, "members": [ <genome>, … ] }
//
// Validation is as strict as for a single genome (an upload is untrusted):
// unknown keys, wrong schema/version, 0 or more than MAX_TEAM_SIZE members, or
// any invalid member genome reject the whole team.
// ---------------------------------------------------------------------------

export const TEAM_SCHEMA = 'dungeon-gym/team'
export const TEAM_VERSION = 1
/** Party size limit (the run supports 1–5 members). */
export const MAX_TEAM_SIZE = 5
/** Upper bound on an uploaded team's JSON text. */
export const MAX_TEAM_CHARS = MAX_GENOME_CHARS * MAX_TEAM_SIZE + 256

export interface Team {
  schema: typeof TEAM_SCHEMA
  version: typeof TEAM_VERSION
  members: Genome[]
}

export type TeamParseResult = { ok: true; team: Team } | { ok: false; errors: string[] }

/** A team of the given genomes (validated; throws on a bad one). */
export function makeTeam(members: readonly Genome[]): Team {
  const res = validateTeam({ schema: TEAM_SCHEMA, version: TEAM_VERSION, members })
  if (!res.ok) throw new Error(`makeTeam: ${res.errors.join('; ')}`)
  return res.team
}

/** The baseline genome of each class, in order. */
export function baselineTeam(classKeys: readonly ClassKey[]): Team {
  return makeTeam(classKeys.map(baselineGenome))
}

/** The classes of a team's members, in order. */
export function teamClasses(team: Team): ClassKey[] {
  return team.members.map((g) => g.classKey)
}

/** Strictly validate an untrusted value as a team (members are migrated like genomes). */
export function validateTeam(value: unknown): TeamParseResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, errors: ['team: expected an object'] }
  const v = value as Record<string, unknown>
  const errors: string[] = []
  for (const k of Object.keys(v)) if (!['schema', 'version', 'members'].includes(k)) errors.push(`team: unknown key "${k}"`)
  if (v.schema !== TEAM_SCHEMA) errors.push(`team.schema: expected "${TEAM_SCHEMA}"`)
  if (v.version !== TEAM_VERSION) errors.push(`team.version: expected ${TEAM_VERSION}`)
  if (!Array.isArray(v.members) || v.members.length < 1 || v.members.length > MAX_TEAM_SIZE) {
    errors.push(`team.members: expected 1–${MAX_TEAM_SIZE} genomes`)
    return { ok: false, errors }
  }
  const members: Genome[] = []
  v.members.forEach((m, i) => {
    const r = validateGenome(m)
    if (r.ok) members.push(r.genome)
    else errors.push(...r.errors.map((e) => `team.members[${i}].${e}`))
  })
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, team: { schema: TEAM_SCHEMA, version: TEAM_VERSION, members } }
}

/** Parse + validate team JSON text (size-limited). */
export function parseTeam(text: string): TeamParseResult {
  if (typeof text !== 'string') return { ok: false, errors: ['team: expected JSON text'] }
  if (text.length > MAX_TEAM_CHARS) return { ok: false, errors: [`team: payload exceeds ${MAX_TEAM_CHARS} characters`] }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return { ok: false, errors: [`team: invalid JSON (${err instanceof Error ? err.message : 'parse error'})`] }
  }
  return validateTeam(value)
}

/** Canonical JSON (each member in canonical genome form). */
export function serializeTeam(team: Team): string {
  return `{"schema":${JSON.stringify(team.schema)},"version":${team.version},"members":[${team.members.map(serializeGenome).join(',')}]}`
}

/** Stable short id of a team's canonical form (FNV-1a, hex). Not cryptographic. */
export function teamHash(team: Team): string {
  return hashString(serializeTeam(team)).toString(16).padStart(8, '0')
}
