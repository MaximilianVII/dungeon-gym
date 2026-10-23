# Dungeon Gym — core

The deterministic, headless engine of **Dungeon Gym**: a turn-based dungeon
roguelite (SRD 5.1 rules subset) where you train bots instead of playing by
hand. A bot's behaviour is a small **genome**; parties of bots crawl
procedurally generated dungeons; a trainer evolves genomes; a fixed benchmark
gives every genome an official, reproducible score.

This package is pure TypeScript logic — no UI, no DOM, no storage, no ambient
randomness. The same `(seed, genome)` produces the same run on every machine,
and every run/trainer state is plain JSON you can save and resume.

## Run the tests

```bash
npm install
npm test            # vitest
npm run typecheck   # tsc --noEmit (strict)
npm run coverage    # coverage report (core ≥ 80 %)
```

Node 20+.

## Use the core

```ts
import {
  baselineGenome, parseGenome, serializeGenome,
  createRun, stepRun, isRunDone, runResult, runSnapshot, playRun,
  createTrainer, trainGenerations, lastBest,
  benchmarkGenome, considerForHallOfFame,
} from 'dungeon-gym-core'

// A genome is the uploadable artifact (schema version 2, strictly validated;
// version-1 payloads are accepted and migrated). Genes cover combat tactics,
// role leanings, exploration, loot preferences and the level-up class order.
const genome = baselineGenome('wizard')
const text = serializeGenome(genome)            // canonical JSON
const parsed = parseGenome(text)                // { ok, genome } | { ok: false, errors }

// Play one run, step by step (e.g. to render it) …
const run = createRun({ seed: 42, depth: 5, party: [{ genome }] })
while (!isRunDone(run)) {
  stepRun(run)                                   // mutates `run` (plain JSON)
  const view = runSnapshot(run)                  // positions, HP, map
}
console.log(runResult(run))

// … or all at once.
playRun({ seed: 42, depth: 5, party: [{ genome }] })

// Train: a deterministic GA with common random numbers.
let trainer = createTrainer({ classKey: 'wizard', seed: 1, populationSize: 8, seedsPerGeneration: 6 })
trainer = trainGenerations(trainer, 10)
console.log(lastBest(trainer))

// Official score: 32 fixed seeds × 10 levels, outcome-only reward.
const score = benchmarkGenome(genome)
const { hall } = considerForHallOfFame({}, genome)   // re-scores the genome itself
```

For distributed training, use `pendingTasks` → `evaluateTask` (anywhere, e.g. a
worker) → `submitScores` → `advanceGeneration`; late or duplicate results are
rejected, never mis-credited.

### Parties

A **team** is a fixed line-up of full genomes (`{ schema: 'dungeon-gym/team',
version: 1, members: [genome, …] }`, 1–5 members, strictly validated). Party
training selects whole teams: every member plays every run, nothing is
re-mixed per run; breeding mutates each member and crosses two teams slot by
slot.

```ts
import { baselineTeam, createPartyTrainer, trainPartyGenerations, lastBestTeam, benchmarkTeam } from 'dungeon-gym-core'

const team = baselineTeam(['fighter', 'cleric', 'wizard', 'rogue'])
let party = createPartyTrainer({ classKeys: ['fighter', 'cleric', 'wizard', 'rogue'], seed: 1 })
party = trainPartyGenerations(party, 10)       // or pendingPartyTasks → submitPartyScores → advancePartyGeneration
console.log(lastBestTeam(party), benchmarkTeam(team).score)
```

The party benchmark (`PARTY_BENCHMARK`, id `dungeon-gym/party-bench-v1@…`) is
32 fixed seeds × 15 levels; a team's score is its members' mean fitness. Role
genes act in a party: `healAllies` (heal and pick up downed party-mates, Healing
Word as a bonus action), `protectAllies` (go for foes on a badly hurt
party-mate), `aggression` (stance and retreat), and Bardic Inspiration (the
die rescues a missed attack or a failed save).

## Train from the command line

```bash
npm run build
```

```bash
node dist/cli.mjs train --class wizard --generations 30 --workers 8 --seed 1 --out wizard.json --curve wizard.csv
```

```bash
node dist/cli.mjs bench wizard.json
```

```bash
node dist/cli.mjs validate wizard.json
```

```bash
node dist/cli.mjs train-party --classes fighter,cleric,wizard,rogue --generations 20 --workers 8 --seed 1 --out party.json
```

```bash
node dist/cli.mjs bench-party party.json
```

`train` and `train-party` run on `worker_threads`; their results depend only on
their options, never on `--workers`. `bench` without a file scores the 12
baseline genomes, `bench-party` without a file the baseline team of
`--classes` (default fighter, cleric, wizard, rogue), `validate` checks a genome
or a team, `speed` measures runs per second and `report` prints the balance telemetry
(see `docs/balance.md`, `docs/performance.md`).

## Layout

| Path | What |
|---|---|
| `src/rng.ts` | serializable mulberry32 RNG |
| `src/game/`, `src/dungeon/` | grid, line of sight, procedural levels, XP |
| `src/combat/` | dice, attack resolution, monsters, spells, control spells and concentration, spell slots, subclasses, multiclassing, monster and boss AI |
| `src/character/` | SRD-table character builder and the 12 starting characters |
| `src/bot/` | genome schema, bot combat policy and tactics, the run state machine, reward |
| `src/train/` | evaluation, benchmark, trainer, party trainer and party benchmark, hall of fame |
| `docs/genome-audit.md` | audit of the legacy genome/learning logic and what changed |
| `docs/balance.md` | per-class benchmark and telemetry across rules versions |

## Determinism contract

- No `Math.random`, `Date.now`, globals or module-level mutable state in
  `src/` (enforced by `test/purity.test.ts`).
- RNG state lives inside the run / trainer state.
- Only IEEE-exact arithmetic in the simulation.
- `CORE_VERSION` must be bumped whenever a rules change can alter any run's
  outcome; benchmark ids include it.

## License

Code: MIT (`LICENSE`). Game-rules content derived from the SRD 5.1:
CC-BY-4.0 — see `LICENSE-SRD.md` for the attribution and the list of changes.
Dungeon Gym is not affiliated with Wizards of the Coast.
