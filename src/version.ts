/**
 * Version of the simulation rules. Bump it whenever a change alters any run's
 * outcome for a given (seed, genome) — combat math, generator, policy, reward —
 * because stored benchmark scores are only comparable within one version.
 */
export const CORE_VERSION = '0.3.0'
