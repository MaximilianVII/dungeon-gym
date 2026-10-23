// ---------------------------------------------------------------------------
// Biomes — a per-level theme. Generated levels carry a `biome` on their map; it
// names the level and picks the boss of a run's final level. Colours belong to
// a client, not to the core.
// ---------------------------------------------------------------------------

export const BIOMES = ['crypt', 'cave', 'sewer', 'warren', 'vault'] as const
export type Biome = (typeof BIOMES)[number]

/** Human-readable level name per biome (game content). */
export const BIOME_NAMES: Record<Biome, string> = {
  crypt: 'Forgotten Crypt',
  cave: 'Dripping Caverns',
  sewer: 'Sunken Sewers',
  warren: 'Gnawed Warren',
  vault: 'The Black Vault',
}
