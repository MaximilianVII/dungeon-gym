// Dungeon Gym core — public API.

export { CORE_VERSION } from './version'

// Randomness
export { seedRng, nextFloat, rngOf, makeRng, randInt, hashString, deriveSeed, type Rng, type RngState } from './rng'

// Genome (the uploadable artifact)
export {
  GENOME_SCHEMA, GENOME_VERSION, MAX_GENOME_CHARS, MAX_LEVEL_UP_ORDER, DEFAULT_GENES, GENE_ORDER, NUMERIC_GENES, BOOLEAN_GENES, LOOT_GENES,
  migrateGenesV1, lootWeights, type GenesV1,
  baselineGenome, makeGenome, clampGenes, validateGenome, parseGenome, serializeGenome, genomeHash,
  relevantGenes, mutateGenome, crossoverGenomes, roleOf, describeGenes,
  type Genes, type Genome, type GeneKey, type GenomeParseResult, type MutateOptions, type RelevanceContext, type Role,
} from './bot/genome'

// Runs
export {
  RUN_STATE_SCHEMA, RUN_STATE_VERSION, STEPS_PER_LEVEL, MAX_DEPTH,
  createRun, stepRun, runToEnd, playRun, isRunDone, runResult, runSnapshot, cloneRunState, equipFoundGear,
  type RunConfig, type RunState, type RunResult, type MemberResult, type RunSnapshot, type PartyMemberInit, type EndReason, type RunPhase, type DeathCause, type GearSlot,
} from './bot/run'
export { botPlayerTurn } from './bot/policy'
export { maxResources, restoreResources, rageUses, bardicDie, type ClassResources } from './combat/abilities'
export { DEFAULT_REWARD, BENCHMARK_REWARD, REWARD_PRESETS, clampReward, memberFitness, diversityBonus, type RewardConfig, type FitnessInput } from './bot/reward'
export { mergeUsage, type UsageTally } from './bot/usage'
export { aggregate, totals, resultsCSV, type ClassStat, type Totals } from './bot/stats'

// Training
export { evaluateGenome, benchmarkGenome, scoreRun, mean, BENCHMARK, type Benchmark, type BenchmarkResult, type Evaluation, type EvaluateOptions } from './train/evaluate'
export {
  TRAINER_SCHEMA, TRAINER_VERSION, MAX_ABS_SCORE, makeTrainerConfig, createTrainer, pendingTasks, evaluateTask, submitScores, isGenerationComplete,
  rankPopulation, advanceGeneration, lastBest, trainGenerations,
  type TrainerConfig, type TrainerState, type Individual, type EvalTask, type ScoreSubmission, type SubmitError, type SubmitOutcome, type GenerationSummary,
} from './train/trainer'
export { considerForHallOfFame, type HallOfFame, type HallOfFameEntry, type HallOfFameUpdate, type HallOfFameRejection } from './train/hallOfFame'

// Characters
export {
  CLASS_KEYS, STARTING_LEVEL, MAX_CHARACTER_LEVEL, WEAPONS, ARMOR, isClassKey, validateCharacterSpec, buildCharacter, starterSpec, starterCharacter, spellsForBuild, abilityMod,
  type ClassKey, type CharacterSpec,
} from './character/build'
export type { PlayerSource, AbilityScores } from './combat/setup'

// World & rules (for clients that render or extend the game)
export { Tile, type GameMap, type Vec2 } from './game/types'
export { generateRun, generateLevelForRun, RUN_LENGTH } from './dungeon/generate'
export type { Level, EnemySpawn } from './dungeon/levels'
export { MONSTERS, getMonster, type MonsterBlock } from './combat/monsters'
export { ARTIFACTS, DEFAULT_LOOT_WEIGHTS, effectScore, pickArtifact, type Artifact, type ArtifactEffect, type LootWeights } from './items/artifacts'
export { GEAR, type GearItem } from './items/gear'
export { SUBCLASS_CATALOGUE } from './combat/subclasses'
export { SPELL_NAMES } from './combat/spells'
export type { Battler, CombatAttack, Condition } from './combat/types'
