import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { deriveSeed, hashString, makeRng, nextFloat, randInt, rngOf, seedRng } from '../src/rng'
import { ARTIFACTS, artifactScore, drawRewards, getArtifact } from '../src/items/artifacts'
import { GEAR, canUseArmor, usableGear } from '../src/items/gear'
import { applyXp, monsterXp, xpToNext, MAX_LEVEL } from '../src/dungeon/leveling'
import { BIOMES, BIOME_NAMES } from '../src/game/biomes'

const SRC = join(__dirname, '..', 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : []
  })
}

const files = sourceFiles(SRC).map((p) => ({ p, text: readFileSync(p, 'utf8') }))

describe('core purity', () => {
  it('has no ambient nondeterminism, browser globals or UI framework', () => {
    const banned = [/Math\.random/, /Date\.now/, /new Date\b/, /performance\.now/, /localStorage/, /sessionStorage/, /import\.meta/, /\bwindow\./, /\bdocument\./, /from 'react'/, /from 'zustand'/, /from 'node:/, /require\(/]
    for (const { p, text } of files) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      for (const re of banned) expect(re.test(code), `${p} matches ${re}`).toBe(false)
    }
  })

  it('has no module-level mutable state (let at top level)', () => {
    for (const { p, text } of files) expect(/^let /m.test(text), `${p} has a top-level let`).toBe(false)
  })

  it('carries no non-SRD content names or trademarked branding', () => {
    const banned = [
      'D&D', 'Dungeons & Dragons', 'Forge', 'Witch Bolt', 'Chromatic Orb', 'Arms of Hadar', 'Hunger of Hadar', 'Synaptic Static',
      'Thunderous Smite', 'Hail of Thorns', 'Battle Master', 'Eldritch Knight', 'Assassin', 'Arcane Trickster', 'Totem Warrior',
      'Storm Herald', 'Wild Magic', 'School of Abjuration', 'School of Conjuration', 'School of Divination', 'School of Necromancy',
      'School of Transmutation', 'Light Domain', 'Knowledge Domain', 'Nature Domain', 'Tempest Domain', 'Trickery Domain', 'War Domain',
      'Circle of the Moon', 'Oath of the Ancients', 'Oath of Vengeance', 'Beast Master', 'Gloom Stalker', 'Way of Shadow',
      'Four Elements', 'Archfey', 'Great Old One', 'Hexblade', 'College of Valor', 'Sharpshooter', 'Great Weapon Master', 'War Caster',
    ]
    for (const { p, text } of files) for (const name of banned) expect(text.includes(name), `${p} mentions ${name}`).toBe(false)
  })
})

describe('rng', () => {
  it('is reproducible and its state is a plain serializable number', () => {
    const a = seedRng(42)
    const xs = [nextFloat(a), nextFloat(a), nextFloat(a)]
    const b = JSON.parse(JSON.stringify(seedRng(42))) as { s: number }
    expect([nextFloat(b), nextFloat(b), nextFloat(b)]).toEqual(xs)
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
    const st = seedRng(7)
    const r = rngOf(st)
    r()
    const snapshot = { ...st }
    const next = r()
    expect(rngOf(snapshot)()).toBe(next)
    expect(makeRng(1)()).toBe(makeRng(1)())
  })

  it('pins the mulberry32 sequence (changing it would change every benchmark score)', () => {
    const r = makeRng(1)
    expect([r(), r()].map((x) => Math.floor(x * 1e6))).toEqual([627073, 2735])
  })

  it('randInt / hashString / deriveSeed', () => {
    const r = makeRng(3)
    for (let i = 0; i < 100; i++) {
      const v = randInt(r, 2, 4)
      expect(v).toBeGreaterThanOrEqual(2)
      expect(v).toBeLessThanOrEqual(4)
    }
    expect(hashString('abc')).toBe(hashString('abc'))
    expect(hashString('abc')).not.toBe(hashString('abd'))
    expect(deriveSeed(1, 'run')).not.toBe(deriveSeed(1, 'policy'))
    expect(deriveSeed(1, 5)).toBe(deriveSeed(1, 5))
    expect(deriveSeed(1, 'x')).toBeGreaterThanOrEqual(0)
  })
})

describe('items + leveling', () => {
  it('draws distinct, unowned artifacts by depth tier', () => {
    const picks = drawRewards(makeRng(1), 0, [])
    expect(picks).toHaveLength(3)
    expect(new Set(picks.map((p) => p.key)).size).toBe(3)
    const owned = ARTIFACTS.slice(0, 7).map((a) => a.key)
    for (const p of drawRewards(makeRng(2), 9, owned)) expect(owned).not.toContain(p.key)
    expect(drawRewards(makeRng(1), 2, ARTIFACTS.map((a) => a.key))).toEqual([])
    expect(getArtifact('whetstone')?.effect.damageBonus).toBe(1)
    expect(getArtifact('nope')).toBeUndefined()
    expect(artifactScore(getArtifact('bracers-defense')!)).toBe(12)
  })

  it('gates armour by class proficiency', () => {
    const plate = GEAR.find((g) => g.key === 'plate-shard')!
    expect(canUseArmor('fighter', plate)).toBe(true)
    expect(canUseArmor('wizard', plate)).toBe(false)
    expect(canUseArmor('cleric', plate)).toBe(false)
    expect(canUseArmor('rogue', GEAR.find((g) => g.key === 'leather-jerkin')!)).toBe(true)
    expect(usableGear('wizard').every((g) => !g.armorClass)).toBe(true)
    expect(usableGear('paladin').length).toBe(GEAR.length)
  })

  it('XP curve and level-ups', () => {
    expect(xpToNext(1)).toBe(40)
    expect(xpToNext(5)).toBe(150)
    expect(monsterXp(7)).toBe(11)
    expect(monsterXp(2)).toBe(5)
    expect(monsterXp(60, 'boss')).toBe(270)
    expect(monsterXp(10, 'elite')).toBe(23)
    expect(applyXp(5, 0, 149)).toEqual({ xp: 149, levelsGained: 0 })
    expect(applyXp(5, 100, 230)).toEqual({ xp: 10, levelsGained: 2 })
    expect(applyXp(MAX_LEVEL, 0, 1e6).levelsGained).toBe(0)
    expect(BIOMES.map((b) => BIOME_NAMES[b])).toHaveLength(5)
  })
})
