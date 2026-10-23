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

// A genome is the uploadable artifact (versioned, strictly validated).
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
const { hall } = considerForHallOfFame({}, genome, score)
```

For distributed training, use `pendingTasks` → `evaluateTask` (anywhere, e.g. a
worker) → `submitScores` → `advanceGeneration`; late or duplicate results are
rejected, never mis-credited.

## Layout

| Path | What |
|---|---|
| `src/rng.ts` | serializable mulberry32 RNG |
| `src/game/`, `src/dungeon/` | grid, line of sight, procedural levels, XP |
| `src/combat/` | dice, attack resolution, monsters, spells, subclasses, multiclassing, enemy and boss AI |
| `src/character/` | SRD-table character builder and the 12 starting characters |
| `src/bot/` | genome schema, bot combat policy, the run state machine, reward |
| `src/train/` | evaluation, benchmark, trainer, hall of fame |
| `docs/genome-audit.md` | audit of the legacy genome/learning logic and what changed |

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
