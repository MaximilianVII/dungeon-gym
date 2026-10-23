# Dungeon Gym — core

[![CI](https://github.com/MaximilianVII/dungeon-gym/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MaximilianVII/dungeon-gym/actions/workflows/ci.yml)

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
npm run check       # all of CI: typecheck, coverage, bench:check, CLI smoke
```

Node 20+. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rule-change rule
(`CORE_VERSION` → `npm run bench:update`) and the SRD-only content policy.

## Install as a dependency

The package ships a bundled ESM build (`dist/index.mjs`, no runtime
dependencies) with one self-contained `dist/index.d.ts`, plus the
`dungeon-gym` CLI bin. `prepare` builds `dist/` on install from git or a
fresh clone.

```bash
npm install github:MaximilianVII/dungeon-gym#<commit-sha>
```

```bash
npm install file:../dungeon-gym
```

`file:` links the folder, so build it there first (`npm ci` does, via
`prepare`). For a git dependency npm builds `dist/` while packing the checkout;
npm 11's install-scripts notice about `dungeon-gym-core (prepare)` is harmless.
Trained genomes are importable as
`dungeon-gym-core/genomes/<class>.json` once the nightly workflow has produced them.

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

### Play by hand

A human can play any party member on the same deterministic engine: create
the member with `control: 'human'` (its genome still picks loot and
level-ups). The functions below are pure — they return a new state and never
touch their input — and the state stays plain JSON with the RNG inside, so a
browser client can save, send or replay a game; the same state and action
always give the same next state.

```ts
import { createRun, baselineGenome, advanceToInput, pendingInput, legalActions, applyPlayerAction, isRunDone, runResult } from 'dungeon-gym-core'

let s = advanceToInput(createRun({ seed: 42, depth: 5, party: [
  { genome: baselineGenome('fighter'), control: 'human' },
  { genome: baselineGenome('cleric') },                // a bot ally
] }))
while (!isRunDone(s)) {
  const input = pendingInput(s)       // { kind: 'explore' | 'combat', memberId, turn? }
  const options = legalActions(s)     // every legal PlayerAction right now
  s = applyPlayerAction(s, pick(input, options))   // bots and monsters play on to the next decision
}
console.log(runResult(s))
```

- **Exploration** (when the party's leader — its first living member — is
  human): `{ kind: 'move', to }` one tile, or `{ kind: 'auto' }` for one step
  of the genome's own sweep. Traps, shrines, spotting and the exit work as for
  bots.
- **Combat** (each turn of a human member): build the turn from actions and
  close it with `{ kind: 'end-turn' }` — `move` (one tile, within the speed
  budget), `attack` (a weapon swing within the Attack action, Extra Attack
  included; `bonus: true` for a Frenzy or Martial Arts swing; or a cantrip /
  damage spell), `area` (an area spell at a `center`), `cast` (Hold Person
  `targets`, Sleep / Hypnotic Pattern `center`, Conjure Animals, Hunter's Mark),
  `heal` (Healing Word is a bonus action), `potion`, `feature` (`rage`,
  `second-wind`, `action-surge`, `patient-defense`, `hide`, `dash`,
  `wild-shape`, `inspire`), `wand`. `{ kind: 'auto' }` at the start of a turn
  lets the genome play it — a run where the human always picks `auto` is
  exactly the bot run.
- `checkAction(s, action)` explains why an action is not legal;
  `applyPlayerAction` throws on one. While input is pending, `stepRun` does
  nothing and `runToEnd` returns.

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
| `src/bot/` | genome and team schemas, bot combat policy and tactics, the run API (`bot/run`), reward |
| `src/run/` | the run state machine: state types, exploration, fights, party members |
| `src/train/` | evaluation, benchmark, trainer, party trainer and party benchmark, hall of fame |
| `docs/genome-audit.md` | audit of the legacy genome/learning logic and what changed |
| `docs/balance.md` | per-class benchmark and telemetry across rules versions |
| `cli/` | Node CLI and `worker_threads` pool |
| `bench/baseline.json` | benchmark scores of the 12 baseline genomes (regression guard) |
| `genomes/` | trained champion genomes, maintained by the nightly workflow |
| `scripts/` | build, CLI smoke test, `bench:check`/`bench:update`, `pack:check`, nightly training |
| `.github/` | CI, nightly training, Dependabot, issue and PR templates |

## Determinism contract

- No `Math.random`, `Date.now`, globals or module-level mutable state in
  `src/` (enforced by `test/purity.test.ts`).
- RNG state lives inside the run / trainer state.
- Only IEEE-exact arithmetic in the simulation.
- `CORE_VERSION` must be bumped whenever a rules change can alter any run's
  outcome; benchmark ids include it. `npm run bench:check` (run in CI)
  fails if the baseline scores move without a bump; after a bump, run
  `npm run bench:update` and commit `bench/baseline.json`.

## Automation

| Workflow | When | What |
|---|---|---|
| `ci.yml` | push to `main`, every PR, manual | Ubuntu + Windows × Node 20, 22: `npm ci`, typecheck, tests with ≥ 80 % coverage, build, CLI smoke (`train` → `validate` → `bench`), `bench:check`; plus `npm pack` + consumer install and `actionlint` |
| `nightly-train.yml` | daily 03:23 UTC, manual (`generations`, `seed`, `classes`, `min-gain`) | trains all 12 classes with the CLI trainer (fixed seed 1) from the current champions, re-scores before/after on the benchmark and, if any class improved, opens or updates the PR `automation/nightly-train` with `genomes/*.json` and `genomes/TRAINING_REPORT.md` |
| Dependabot | weekly, Monday | npm dev dependencies (grouped) and GitHub Actions |

The training job only has `contents: read`; a separate job with
`contents: write` + `pull-requests: write` opens the PR. Every run is
reproducible from the commit, seed and generations in the report. Because the
seed is fixed, a night only finds something new when `genomes/` or the rules
changed since the last run; start it by hand with another `seed` to explore.

### Repository settings needed

1. **Settings → Actions → General → Workflow permissions**: keep the default
   *Read repository contents* and tick **Allow GitHub Actions to create and
   approve pull requests** (otherwise the nightly PR step fails with 403).
2. **Settings → Branches → add a rule (or ruleset) for `main`**: require a pull
   request and the status checks `test (ubuntu-latest, node 20)`,
   `test (ubuntu-latest, node 22)`, `test (windows-latest, node 20)`,
   `test (windows-latest, node 22)`, `package (npm pack + consumer install)` and
   `lint workflows (actionlint)` (they appear after the first CI run).
3. **Settings → Code security → Dependabot**: enable *Dependabot alerts* and
   *security updates* (version updates come from `.github/dependabot.yml`).
4. Optional: PRs opened with `GITHUB_TOKEN` do **not** trigger CI. To get
   checks on the nightly PR, add a secret `NIGHTLY_PR_TOKEN` (fine-grained PAT
   for this repo with *Contents* and *Pull requests* read/write, or a GitHub App
   token); the workflow uses it automatically. Without it, close and reopen the
   PR to start CI.
5. Scheduled workflows are paused after 60 days without repository activity;
   re-enable *Nightly training* under **Actions** if that happens.

## License

Code: MIT (`LICENSE`). Game-rules content derived from the SRD 5.1:
CC-BY-4.0 — see `LICENSE-SRD.md` for the attribution and the list of changes.
Dungeon Gym is not affiliated with Wizards of the Coast.
