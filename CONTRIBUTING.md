# Contributing to Dungeon Gym core

## Setup and checks

Node 20 or newer.

```bash
npm ci              # also builds dist/ through the `prepare` script
npm run check       # everything CI runs: typecheck, tests + coverage, bench:check, CLI smoke
```

Individual steps:

| Command | What it does |
|---|---|
| `npm test` | vitest |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run coverage` | tests with coverage; fails under 80 % (thresholds in `vitest.config.ts`) |
| `npm run build` | `dist/cli.mjs` + worker, `dist/index.mjs` + `dist/index.d.ts` |
| `npm run smoke` | short `train` → `validate` → `bench` against the built CLI |
| `npm run bench:check` | rebuilds and compares the 12 baseline genomes with `bench/baseline.json` |
| `npm run bench:update` | rebuilds and rewrites `bench/baseline.json` |
| `npm run pack:check` | `npm pack`, installs the tarball into a scratch project, checks import, types and the `dungeon-gym` bin |

CI runs the same steps on Ubuntu and Windows with Node 20 and 22
(`.github/workflows/ci.yml`).

## The rule-change rule

Every `(seed, genome)` must give the same run on every machine, and stored
benchmark scores are only comparable within one `CORE_VERSION`. So:

1. **Change rules** — anything that can alter a run's outcome: combat math,
   dungeon generator, bot policy, reward, monsters, items, class features.
2. **Bump `CORE_VERSION`** in `src/version.ts` (the benchmark id includes it).
3. **Run `npm run bench:update`** and commit `bench/baseline.json` together
   with the change.

`bench:check` (and CI) fails when baseline scores change while `CORE_VERSION`
stays the same, and also when `CORE_VERSION` was bumped but the baseline was
not regenerated. A pure refactor must leave `bench:check` green without
touching the baseline.

## Content: SRD 5.1 only

Game content (classes, subclasses, spells, monsters, items, rules text) may come
only from the System Reference Document 5.1 (CC-BY-4.0). No names, monsters,
settings or mechanics from outside the SRD; `test/purity.test.ts` rejects known
non-SRD names and branding, but review is what really enforces this. When you
adapt SRD material, record the change in `LICENSE-SRD.md`.

## Determinism

- No `Math.random`, `Date.now`, globals or module-level mutable state in `src/`
  (`test/purity.test.ts`).
- RNG state lives inside the run / trainer state.
- Only IEEE-exact arithmetic in the simulation.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`,
  `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`.
- Fill in the PR template checklist; paste benchmark changes if scores moved.
- Trained genomes in `genomes/` are updated by the nightly training workflow
  (`.github/workflows/nightly-train.yml`), which opens a PR with a report.
