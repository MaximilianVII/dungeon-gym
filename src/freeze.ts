/**
 * Recursively freeze a plain-data constant so exported tables (benchmark,
 * rewards, catalogues) cannot be mutated by a caller and silently change the
 * behaviour of every run in the process.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v)
  }
  return value
}
