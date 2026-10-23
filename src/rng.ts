// ---------------------------------------------------------------------------
// Serializable randomness. Every random choice in the core goes through a
// mulberry32 generator whose ENTIRE state is one uint32 kept in a plain object
// (`RngState`). The owner (a run, a trainer) stores that object in its JSON
// state, so a state can be saved mid-run, parsed back and continued with the
// exact same random sequence. No `Math.random` / `Date.now` anywhere in core.
//
// The arithmetic is integer-only (Math.imul, shifts) plus one division by 2^32,
// all exactly specified by IEEE-754, so sequences are bit-identical on every JS
// engine.
// ---------------------------------------------------------------------------

/** A draw in [0, 1). Created from an RngState with `rngOf`. */
export type Rng = () => number

/** The whole generator state — keep it inside your JSON state. */
export interface RngState {
  s: number
}

/** A fresh generator state from any number (coerced to uint32). */
export function seedRng(seed: number): RngState {
  return { s: seed >>> 0 }
}

/** Advance the state and return the next float in [0, 1). Mutates `st`. */
export function nextFloat(st: RngState): number {
  const a = (st.s + 0x6d2b79f5) | 0
  st.s = a >>> 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** An `Rng` view over a state object: each call advances `st` in place. */
export function rngOf(st: RngState): Rng {
  return () => nextFloat(st)
}

/** Convenience: a standalone seeded `Rng` (tests, one-off rolls). */
export function makeRng(seed: number): Rng {
  return rngOf(seedRng(seed))
}

/** Integer in [min, max] (inclusive). */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

/** FNV-1a hash of a string → uint32. */
export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Mix a base seed with a salt into a decorrelated uint32 seed. */
export function deriveSeed(seed: number, salt: string | number): number {
  const saltHash = typeof salt === 'number' ? salt >>> 0 : hashString(salt)
  let h = (seed >>> 0) ^ Math.imul(saltHash, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}
