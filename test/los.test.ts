import { describe, it, expect } from 'vitest'
import { lineOfSight, visibleTiles } from '../src/game/los'
import { testMap } from '../src/game/map'

// testMap row 4 ("#..........#") is open floor; column x=5 (rows 1–3) is wall.

describe('lineOfSight', () => {
  it('is clear across an open row', () => {
    expect(lineOfSight(testMap, { x: 1, y: 4 }, { x: 10, y: 4 })).toBe(true)
  })

  it('is blocked by a wall between the points', () => {
    expect(lineOfSight(testMap, { x: 1, y: 1 }, { x: 8, y: 1 })).toBe(false)
    expect(lineOfSight(testMap, { x: 5, y: 4 }, { x: 5, y: 1 })).toBe(false)
  })

  it('is clear up to (but not through) the wall', () => {
    expect(lineOfSight(testMap, { x: 1, y: 1 }, { x: 4, y: 1 })).toBe(true)
  })

  it('is symmetric', () => {
    const a = { x: 1, y: 1 }
    const b = { x: 8, y: 1 }
    expect(lineOfSight(testMap, a, b)).toBe(lineOfSight(testMap, b, a))
  })
})

describe('visibleTiles', () => {
  it('includes the origin and nearby open floor', () => {
    const vis = visibleTiles(testMap, { x: 1, y: 4 }, 2)
    const has = (x: number, y: number) => vis.some((t) => t.x === x && t.y === y)
    expect(has(1, 4)).toBe(true)
    expect(has(2, 4)).toBe(true)
    expect(has(3, 4)).toBe(true)
  })

  it('stays within the radius', () => {
    const r = 2
    const vis = visibleTiles(testMap, { x: 4, y: 4 }, r)
    for (const t of vis) {
      expect(Math.max(Math.abs(t.x - 4), Math.abs(t.y - 4))).toBeLessThanOrEqual(r)
    }
  })
})
