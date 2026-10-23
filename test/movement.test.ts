import { describe, it, expect } from 'vitest'
import { testMap, isWalkable } from '../src/game/map'
import { tryStep, tileDistance } from '../src/game/logic'
import { Tile } from '../src/game/types'

describe('test map', () => {
  it('has a walkable spawn and waypoint', () => {
    expect(isWalkable(testMap, testMap.spawn.x, testMap.spawn.y)).toBe(true)
    expect(isWalkable(testMap, testMap.waypoint.x, testMap.waypoint.y)).toBe(true)
  })

  it('is bordered by walls', () => {
    for (let x = 0; x < testMap.width; x++) {
      expect(testMap.tiles[0][x]).toBe(Tile.Wall)
      expect(testMap.tiles[testMap.height - 1][x]).toBe(Tile.Wall)
    }
  })
})

describe('tryStep', () => {
  const spawn = testMap.spawn // (1, 1)

  it('walks onto adjacent floor', () => {
    expect(tryStep(testMap, spawn, 1, 0)).toEqual({ x: spawn.x + 1, y: spawn.y })
    expect(tryStep(testMap, spawn, 0, 1)).toEqual({ x: spawn.x, y: spawn.y + 1 })
  })

  it('bumps into a wall and stays put', () => {
    // North of spawn is the top border wall.
    expect(tryStep(testMap, spawn, 0, -1)).toEqual(spawn)
  })

  it('treats a diagonal as a single step', () => {
    expect(tryStep(testMap, spawn, 1, 1)).toEqual({ x: spawn.x + 1, y: spawn.y + 1 })
  })

  it('no-ops a zero move', () => {
    expect(tryStep(testMap, spawn, 0, 0)).toBe(spawn)
  })
})

describe('tileDistance', () => {
  it('uses Chebyshev distance (diagonal = 1)', () => {
    expect(tileDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(4)
    expect(tileDistance({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(2)
    expect(tileDistance({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0)
  })
})
