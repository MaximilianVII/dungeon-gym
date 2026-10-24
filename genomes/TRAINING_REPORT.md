# Nightly training report

7 of 12 classes improved on `dungeon-gym/bench-v1@0.5.0` (32 seeds × 10 levels).

| class | champion | before | after | Δ | wins | genome | result |
|---|---|---:|---:|---:|---|---|---|
| barbarian | baseline | 127.000 | 132.188 | +5.188 | 15 → 16 | `b99664f7` → `612f7fad` | **improved** |
| bard | baseline | 70.906 | 67.375 | -3.531 | 4 → 3 | `f389b0cf` → `a8282412` | kept |
| cleric | baseline | 125.844 | 118.969 | -6.875 | 14 → 12 | `93a83158` → `bb989e3d` | kept |
| druid | baseline | 79.781 | 94.094 | +14.313 | 7 → 7 | `3a15798c` → `a7e41e24` | **improved** |
| fighter | baseline | 152.656 | 150.438 | -2.219 | 22 → 21 | `530853b3` → `fc6f157f` | kept |
| monk | baseline | 95.344 | 92.938 | -2.406 | 8 → 9 | `b8eff4be` → `e1ac8d92` | kept |
| paladin | baseline | 123.188 | 116.594 | -6.594 | 13 → 14 | `6c9519b3` → `24da6231` | kept |
| ranger | baseline | 87.406 | 100.781 | +13.375 | 8 → 9 | `02d9e324` → `bdc2ca06` | **improved** |
| rogue | baseline | 92.500 | 96.281 | +3.781 | 8 → 10 | `aa9c31ce` → `e5b99a12` | **improved** |
| sorcerer | baseline | 64.438 | 67.625 | +3.188 | 2 → 3 | `f8673e62` → `db773ca0` | **improved** |
| warlock | baseline | 81.688 | 95.594 | +13.906 | 4 → 5 | `536d5642` → `1b986123` | **improved** |
| wizard | baseline | 74.594 | 84.281 | +9.688 | 4 → 6 | `c151a419` → `fdf57505` | **improved** |

## Reproduce

- core commit `2ca407c67d07ebb205ad855291becfde9ce7b7b1`, `CORE_VERSION` 0.5.0
- `node scripts/nightly-train.mjs --generations 40 --seed 1` after `npm run build`
- the trainer starts from each champion; the result does not depend on `--workers`
- a candidate replaces the champion only if its benchmark score is strictly higher (plus `--min-gain`)
