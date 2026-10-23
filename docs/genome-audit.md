# Genome & learning audit (legacy arena → Dungeon Gym core)

Scope: the bot "arena" of the legacy prototype — `arena/strategy.ts`, `botAI.ts`,
`botRun.ts`, `learn.ts`, `population.ts`, `reward.ts`, `champions.ts`, `store.ts`
(paths below are relative to the legacy `code/src/`). The question being answered:
**do the genomes work correctly today, and is the learning logic sound for how
training will work in Dungeon Gym** — deterministic server-side scoring of an
uploaded genome on a fixed seed set, plus local training by the player.

Short answer: the *policy* side (genes → behaviour) mostly works, with a few
dead/mis-specified genes. The *learning* side is not fit for purpose: it is
non-reproducible, mis-attributes results under concurrency, compares
statistically meaningless samples, and crowns champions by a signal that is not
the champion's own score. The genome has no schema version or strict
validation, so it is not yet an uploadable artifact. Everything marked
**Fixed in core** below is implemented and covered by tests in this repo.

Severity: **Critical** = invalidates server scoring or learning results;
**High** = learning is wrong/biased in normal use; **Medium** = wasted
compute / weaker learning / misleading semantics; **Low** = rules fidelity or
hygiene.

## 1. Gene-by-gene check (does each gene reach `botPlayerTurn`?)

| Gene | Read at | Effect | Verdict |
|---|---|---|---|
| `healAtHpFrac` | botAI.ts:268 | self heal/potion threshold | OK |
| `secondWindAtHpFrac` | botAI.ts:252 | Fighter Second Wind threshold | OK (fighter-only) |
| `retreatAtHpFrac` | botAI.ts:233, :316 | retreat threshold, ×(1−0.5·aggression) | OK |
| `kite` | botAI.ts:232, :371 | only through `effKite >= 0.5` | **step function** (A-9) |
| `patientDefenseAdj` | botAI.ts:234, :256 | Monk dodge threshold, −2·protect | OK (monk-only) |
| `openWithRage` | botAI.ts:249 | gates Rage **entirely**, not "first turn" | **mis-specified** (A-12) |
| `inspireBeforeAttack` | botAI.ts:259 | gates Bardic Inspiration entirely | OK-ish (bard-only) |
| `actionSurgeEarly` | botAI.ts:428 | surge immediately vs. only on a low foe | OK (fighter-only) |
| `focusWeakest` | botAI.ts:361, :363 | weakest vs nearest | OK |
| `potionFirst` | botAI.ts:289 | order of potion/spell | OK (only matters with heal spells) |
| `focusCasters` | botAI.ts:359 | `> 0.5` | **step function** (A-9) |
| `slotReserve` | botAI.ts:346 | `> 0.5` | **step function** (A-9) |
| `regroup` | botAI.ts:323 | `> 0.5` | **step function**, party-only (A-9) |
| `healAllies` | botAI.ts:297, :299 | gate `> 0.45` + ally threshold `0.35 + 0.4·g` | OK, healer-only |
| `protectAllies` | botAI.ts:232, :234 | lowers effKite (−0.3·g), lowers dodge threshold | OK, but the "body-block" in the docs does not exist |
| `aggression` | botAI.ts:232, :233 | lowers effKite (−0.4·g), lowers retreat | OK |
| `levelUpOrder` | botRun.ts:652-682 | which class each mid-run level goes into | **partly fake** (A-11) |

`clampStrategy` (strategy.ts:99-125) clamps every numeric gene and filters
`levelUpOrder` to known classes, so ranges are enforced. No gene is ignored
outright, but several are irrelevant for most classes (A-10) and five are
thresholded booleans disguised as continuous genes (A-9).

Role modulation (`mergeTactics`, strategy.ts:239-246; botAI.ts:232-234): the
role genes (from the population) and the tactic genes (from the class learner)
combine **non-linearly** — e.g. `effKite = clamp(kite − 0.4·aggression −
0.3·protect)` and only `effKite >= 0.5` matters. With the default role genes
(0.5/0.5) a baseline kite of 0.4 (rogue) becomes 0.05 and 0.9 (wizard) becomes
0.55, so the meaning of a tactic gene depends on which random individual it was
paired with in that run (A-6).

## 2. Findings

### A-1 · Critical · Learning is not reproducible (unseeded RNG, unrecorded seeds)
- Evidence: `learn.ts:43` and `population.ts:89` use `Math.random`; run seeds
  come from `Math.random` and are never stored (`store.ts:83-85`, `:109`); the
  class-dealing tie-break is `Math.random` (`store.ts:92`); harvest order
  depends on a 110 ms `setInterval` and concurrency (`store.ts:165`, `:179-231`).
  `champions.ts:98` stamps `Date.now()` into persisted state.
- Impact: no training session can be replayed or audited; a server cannot
  re-derive a result; bugs cannot be bisected.
- Fix in core: every random choice goes through a seeded mulberry32 whose state
  is a plain number stored in the owning JSON state (`RunState.rng`,
  `TrainerState.rng`). No `Math.random` / `Date.now` anywhere in `src/` (a test
  greps for them). **Fixed in core.**

### A-2 · Critical · In-flight results are silently mis-attributed (class learner)
- Evidence: a bot records only the *string* `'current' | 'candidate'`
  (`store.ts:105-107`, `learn.ts:80-84`). When the candidate is promoted or
  re-rolled (`learn.ts:93-100`), every run still in flight with the **old**
  candidate/current is later credited to the **new** one
  (`learn.ts:87-92`). With up to 24 concurrent parties × 5 members this is the
  common case, not an edge case.
- Impact: the mean of a fresh candidate is polluted by runs of a different
  genome; promotions are partially random.
- Fix in core: every evaluation task carries `(generation, individualId)`;
  `submitScores` rejects stale or unknown keys explicitly (returns a reason)
  instead of crediting whatever currently occupies the slot. **Fixed in core.**

### A-3 · High · In-flight results are silently dropped (population)
- Evidence: `evolve` reuses the losers' objects and reassigns `m.id`
  (`population.ts:159-169`, id at `:161`); `recordRun` then finds no member
  and returns without a trace (`population.ts:212-214`). Survivors' in-flight
  runs from the previous generation are added to the new generation's
  accumulator (their `fitSum` was just reset, `:154-157`).
- Impact: wasted compute and a cross-generation mix in survivors' means. (No
  mis-attribution to a different genome, because ids are never reused.)
- Fix in core: ids are immutable; children always get fresh ids; an
  evaluation is keyed by generation, so a late result is rejected, not merged.
  **Fixed in core.**

### A-4 · Critical · Champion is crowned by the class EMA, not by its own score
- Evidence: `champions.ts:88-91` updates one EMA per **class** over every run
  of that class (any tactic variant, any role genome) and, when that EMA sets a
  new high, stores the genome of **the single run that happened to push it
  over** (`:94`) with the EMA as its "fitness" (`:95`).
- Impact: the Hall of Fame genome is essentially a random recent genome of a
  class that was doing well on average; its recorded fitness is not its own.
  Unusable as an "official best" for upload or leaderboards.
- Fix in core: `considerForHallOfFame` **recomputes the genome's own
  benchmark score** (mean over the fixed, frozen benchmark seed set) — it
  never accepts a score from the caller, so it cannot be forged — and keeps
  the best per class. **Fixed in core.**

### A-5 · High · Reward changes mid-training mix incompatible fitnesses
- Evidence: the reward is read at harvest time from the live store
  (`store.ts:199`, `:210`); `configureReward` (`store.ts:150-154`) does not
  reset `learn`/`population`/`champions` accumulators, which keep summing
  fitness computed under different weights. The same applies to changing
  `partySize` (enemy scaling, `botRun.ts:223`) or `runDepth` mid-training.
- Fix in core: reward and depth are frozen in an immutable `TrainerConfig`
  and shipped inside every evaluation task, so changing them means starting a
  new trainer. The trainer evaluates solo runs (party training is phase 2).
  **Fixed in core.**

### A-6 · High · Class tactics are evaluated under random role genes and random party
- Evidence: `spawnParty` pairs the class's current/candidate tactics with a
  random population individual (`store.ts:98-107`), whose role genes change the
  meaning of the tactic genes (see §1); party size and teammates are random;
  the population's fitness for one role genome mixes all 12 classes
  (`store.ts:100`, `population.ts:182-191`).
- Impact: both layers see each other as noise; the role layer mostly learns
  "which classes I happened to be dealt".
- Recommendation (applied): the uploadable unit is **one self-contained genome
  per class** (tactics + role genes + level-up order). Training evaluates that
  exact genome; party training, if wanted later, should evaluate fixed teams of
  complete genomes, not recombine layers per run.

### A-7 · High · (1+1)-ES compares means of 6–14 noisy, unpaired runs
- Evidence: `PROMOTE_MIN = 6`, `REJECT_MAX = 14` (`learn.ts:25-26`); promotion
  fires the **first** time the candidate mean exceeds the current mean anywhere
  between n = 6 and 14 (`learn.ts:93`) — repeated peeking. Runs use different
  random seeds (no common random numbers), different teammates and role genes.
  After promotion the new `current` inherits the candidate's (selected, hence
  optimistically biased) mean (`learn.ts:96`).
- Measured: see §3 — per-run fitness noise is large relative to the effect of
  a ±0.12 gene nudge, and the peeking rule promotes a candidate that is
  *exactly as good* as the current far more often than 50 %.
- Fix in core: generational trainer with **common random numbers** — all
  individuals of a generation are scored on the *same* seed set drawn from the
  trainer RNG; elites are **re-evaluated** on fresh seeds every generation (no
  stale optimistic means); selection is on the paired mean. A fixed
  `BENCHMARK_SEEDS` set is used for champion/upload scoring. **Fixed in core.**

### A-8 · Medium · Population GA: no crossover, unequal sampling, unscored members culled
- Evidence: `evolve` = truncation + mutation only (`population.ts:149-173`);
  parties are drawn at random (`population.ts:182-191`), so after
  `genInterval` member-runs individuals have unequal sample counts; a member
  that was never drawn has mean `-Infinity` (`population.ts:146`) and is
  culled without evaluation.
- Fix in core: every individual of a generation is scored on the same seed
  set before selection; children are produced by uniform crossover of two
  tournament-selected parents + mutation. **Fixed in core.**

### A-9 · Medium · Five "continuous" genes are thresholded booleans
- Evidence: `focusCasters > 0.5` (botAI.ts:359), `slotReserve > 0.5` (:346),
  `regroup > 0.5` (:323), `effKite >= 0.5` (:371), `healAllies > 0.45` gate
  (:297). Mutation jiggles them by ±0.12 (strategy.ts:200-208), so most
  mutations are behavioural no-ops (neutral drift) and the optimiser has no
  gradient.
- Fix in core: `focusCasters`, `slotReserve`, `regroup` are now
  **probabilities per decision**, drawn from the run RNG (deterministic given
  the seed), so the value is meaningful across its whole range; `kite` keeps
  its threshold role but is documented as such. **Fixed in core** (genome v1).

### A-10 · Medium · Mutations of class-irrelevant genes waste evaluations
- Evidence: `mutateTactics` (strategy.ts:196-236) mutates e.g.
  `openWithRage`/`inspireBeforeAttack`/`actionSurgeEarly`/`patientDefenseAdj`
  for every class. For a wizard a mutation that only flips `openWithRage` yields
  an identical policy, which then costs 6–14 runs and is "promoted" or not by
  pure noise.
- Fix in core: `relevantGenes(classKey)` restricts mutation to genes the class
  can express. **Fixed in core.**

### A-11 · Medium · `levelUpOrder` is only partly real
- Evidence: a level taken in another class grants its hit die, shared spell
  slots and Extra Attack (botRun.ts:671-709) but **not** that class's
  abilities (Rage, Second Wind, Cunning Action… — `battler.abilities` is never
  updated), and a martial that dips into a caster gets slots but **no spells**
  (`baseToHit` is undefined when it has no spell attacks, botRun.ts:702-703).
  Only the *target* class prerequisite is checked (botRun.ts:661-666); 5e also
  requires the *current* class prerequisite. The mutation operator can seed
  1–4 entries or replace one, but never shortens or lengthens a non-empty
  order (strategy.ts:226-234), so "monoclass" is unreachable once left.
- Fix in core: on entering a new class the bot gains that class's signature
  abilities and its spells (spell attack bonus from the new class's casting
  ability); prerequisites are checked for both classes; mutation can insert,
  delete or replace entries. **Fixed in core.**

### A-12 · Medium · `openWithRage` means "never rage" when false
- Evidence: botAI.ts:249 — Rage is only ever entered when `openWithRage` is
  true; documented as "enter Rage on the first turn". Rage also has no
  per-rest use limit, and Second Wind / Action Surge refresh every fight
  (botRun.ts:564) instead of per short rest.
- Fix in core: the gene keeps its name but is documented as "uses Rage"; rage,
  second wind and action surge stay per-fight resources (documented rules
  simplification). Rules fidelity beyond that is deferred.

### A-13 · Medium · Hitting `MAX_STEPS` on the last level counts as a win
- Evidence: botRun.ts:873-874 `finishRun(this.levelIndex >= this.levels.length - 1)`.
  A stalled party on the boss level is scored as winners (+`win`, alive
  survivors keep `survive`). Normal runs stay far below the cap (§3), so this
  bites in stalls — exactly the case that must not score as a win.
- Fix in core: a step cap is always a loss with `endReason: 'step-cap'`, and
  the cap scales with depth. **Fixed in core** (regression test).

### A-14 · Medium · Diversity bonus is computed from the wrong genome
- Evidence: `memberRole(m.memberId)` (store.ts:200) looks up the population's
  *current* genome (which may have been replaced, see A-3) instead of the genome
  that played; `roleOf` includes `kite` (strategy.ts:255-261), but in the
  population genome `kite` is inert and never mutated (`mutateRole`,
  strategy.ts:182-193), so the "skirmisher" role only appears when all three
  role genes fall below 0.5.
- Fix in core: `roleOf` is computed from the genome that actually played. The
  diversity bonus is not part of the solo benchmark.

### A-15 · Low · Dead code
- `fitnessOf` (population.ts:194-203) and `mutate` (strategy.ts:142-170) have
  no callers. Not ported.

### A-16 · Medium · Exploration and loot are hard-coded, not genome-driven
- Evidence: exploration stops at `EXPLORE_COVERAGE = 0.65` (botRun.ts:58, :814);
  the artifact pick is a fixed score (botRun.ts:455-464); gear is auto-equipped
  if "better" (botRun.ts:499-538).
- Impact: depth/XP trade-offs (explore more for XP vs. descend safely) — a big
  lever on fitness — are not learnable.
- Fix in core: new `exploreCoverage` gene (0.3–0.95) read by the run loop.
  Loot choice stays a fixed heuristic (recommended as a v2 gene: per-stat
  weights).

### A-17 · Medium · Reward is exploitable by healing/damage farming
- Evidence: `healing` and `damage` are rewarded per point (reward.ts:112-113)
  with no cost for damage taken; a policy that heals earlier simply earns more.
  `damage` grows with depth-scaled monster HP.
- Recommendation (applied): keep the default weights for local training, but
  the **benchmark** (server score) uses a progression-only reward
  (`BENCHMARK_REWARD`: depth, win, survival, character level) so uploads
  compete on outcomes, not on farming.

### A-18 · Low · Same seed feeds the dungeon generator and the run RNG
- Evidence: botRun.ts:222-223 seed both `makeRng(seed)` and `generateRun(seed)`;
  level 0's generator stream equals the combat stream.
- Fix in core: the run RNG is seeded from a hash of `(seed, "run")`.
  **Fixed in core.**

### A-19 · Low · Shared mutable attack objects between source and battler
- Evidence: `buildPlayerBattler` puts the source's spell objects into the
  battler (`combat/setup.ts`, `[...weapons, ...(src.spells ?? [])]`); later
  in-place edits (`atk.toHit +=`, botRun.ts:476-478, :690) only touch weapons
  today, so it does not leak — by luck.
- Fix in core: battlers deep-copy their attacks. **Fixed in core.**

### A-20 · Low · Rules oddities that shape what genes learn
- Bardic Inspiration targets the bard itself (botAI.ts:259-261); Second Wind
  heals a flat 1d10+5 (botAI.ts:253) instead of 1d10 + fighter level; ally
  heals have no range (botAI.ts:297-312); a Frenzy swing set on a ranged turn
  stays pending (botAI.ts:245-248, :436).
- Fixed in core: Second Wind uses fighter level; ally healing requires a
  touch-range spell's target to be adjacent (Healing Word keeps its range);
  a pending Frenzy swing is cleared at end of turn. Self-inspiration is kept as
  a documented simplification.

### A-21 · Medium · Half-casters lose spell slots after the first rest or level-up
- Evidence: `casterSlotsMulti` (arena/progression.ts:124-140) always uses the
  *shared multiclass* table, even for a single spellcasting class. A lone
  Paladin 5 / Ranger 5 gets `[3]` instead of its class table `[4, 2]`. It is
  called on every long rest (botRun.ts:415) and level-up (botRun.ts:698), so
  paladins and rangers silently drop to fewer, lower slots mid-run — their
  tactics were learned against a nerfed body. Pact Magic was merged with
  `max` instead of being added.
- Fix in core: one spellcasting class → its own table; two or more → shared
  table; Pact Magic slots are added on top. **Fixed in core** (the test
  expecting `[4, 2]` failed on the legacy function).

### A-22 · Low · "Once per fight" features were once per run
- Evidence: `startCombat` resets conditions, death saves and fight flags
  (botRun.ts:559-565) but not `darkOneLuckUsed` / `cuttingWordsUsed`, so the
  Fiend's and the Lore bard's features fire once per *run*.
- Fix in core: both are reset at the start of every fight. **Fixed in core.**

### A-23 · Medium · Found gear stacked without limit (found during the core review)
- Evidence: legacy `tryEquip` (botRun.ts:499-538) adds every non-armour find
  on top of the last (two Round Shields = +4 AC, on a fighter who already
  carries a shield), and found armour adds its AC *on top of* the sheet's
  armour (a Leather Jerkin gave a chain-mail fighter +2 AC).
- Fix in core: one item per slot; found armour replaces the sheet's armour
  (counts only where it beats it); a found shield is ignored when the
  character already carries one. **Fixed in core** (`equipFoundGear`, tests).

## 3. Measurements

Measured with the ported core (`src/`), same seeds for every variant (common
random numbers), 200 seeds per number unless noted.

| Quantity | Value |
|---|---|
| Per-run fitness, fighter baseline, legacy default reward, depth 25 | mean 490, **sd 187** |
| Per-run fitness, barbarian / wizard (same setup) | mean 336 / 34, sd 188 / 40 |
| \|Δ mean fitness\| of one mutation vs. its parent (fighter, 30 mutants) | median 2.5, p90 20 |
| Legacy promotion rule, candidate *identical* to current (simulated, 20 000 trials) | promoted **63 %** (current n = 6) … **70 %** (current n = 50) |
| Run cost | 3–9 ms for 5 levels; ≤ 60 ms for 25 levels |
| Official benchmark (32 seeds × 10 levels) | ≈ 0.2 s per genome |
| Steps used by the longest observed 20-level run | ≈ 8 900 (legacy cap: 60 000) |

Reading:
- With unpaired samples of 6, the standard error of a mean difference is
  ≈ 187·√(2/6) ≈ 108 — about 40× the median effect of a mutation. The
  legacy (1+1)-ES (A-7) is therefore choosing between candidates essentially
  at random, and promotes a no-better candidate about two times in three.
- The fitness spread is dominated by the `damage` term (deep survivors farm
  depth-scaled monster HP), which confirms A-17: the benchmark must be
  outcome-only. (Before the gear fix below, stacked shields/armour pushed the
  fighter's per-run sd to ≈ 3 000.)
- Legacy runs stay far below the 60 000-step cap in normal play, so A-13 bites
  only in stalls — still a correctness bug (a stall must not score as a win),
  hence Medium rather than Critical.
- Baseline balance (benchmark, depth 10): no baseline genome clears all 10
  levels; fighters, barbarians and paladins go deepest, full casters and
  rogues die on levels 2–4. That is a game-balance issue for phase 2, not a
  genome bug, but it means the benchmark currently ranks mostly by depth
  reached.


## 4. Is the genome fit as an upload artifact?

Legacy: **no**.
- No schema id / version (strategy.ts:14-64); old saves are "migrated" by
  spreading defaults (`population.ts:121`), so meaning silently changes.
- `clampStrategy` coerces garbage instead of rejecting it (NaN → lower bound,
  unknown classes silently dropped, booleans via `!!`), which is right for UI
  sliders but wrong for an upload: two different payloads score identically,
  and a malformed upload is not reported.
- No size limit on import (`learn.ts:161`, `champions.ts:148`).
- Evaluation is deterministic *per run* (seeded generator + run RNG), but the
  seed set is not defined anywhere, so "the score of a genome" is undefined.

Core (this repo):
- `Genome = { schema: 'dungeon-gym/genome', version: 1, classKey, genes }`.
- `parseGenome(text)` is strict: rejects unknown/missing fields, wrong types,
  out-of-range values, unknown classes and oversize payloads (> 4 KiB);
  returns a typed error list. `serializeGenome` emits canonical JSON (fixed key
  order) so the same genome always hashes the same.
- `clampGenes` remains for UI/mutation paths only.
- `benchmarkGenome(genome)` = mean fitness over the fixed `BENCHMARK_SEEDS`
  with `BENCHMARK_REWARD` and a fixed depth — identical on every machine for
  the same `CORE_VERSION`. Any rules change must bump `CORE_VERSION`, because
  it invalidates stored scores.
- The simulation only uses integer ops and IEEE-exact `Math` functions
  (`floor/round/min/max/abs/sign/sqrt/imul`), so scores do not depend on the JS
  engine. Training mutation uses sums of uniforms rather than Box–Muller
  (`Math.log/cos` are not guaranteed bit-identical across engines).
