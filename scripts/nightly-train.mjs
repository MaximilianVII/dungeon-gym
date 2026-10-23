// Nightly auto-training: trains every class with the CLI trainer (fixed seed),
// starting from the current champion in genomes/<class>.json (or the baseline
// genome), and keeps the result only if it beats the champion on the official
// benchmark. Writes a markdown report with the scores before and after.
//   node scripts/nightly-train.mjs [--generations 40] [--seed 1] [--classes a,b]
//     [--workers K] [--min-gain 0] [--genomes-dir genomes] [--report <file>]
// Sets `improved=true|false` in $GITHUB_OUTPUT when run in GitHub Actions.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = join(root, 'dist', 'cli.mjs')
const lib = join(root, 'dist', 'index.mjs')
if (!existsSync(cli) || !existsSync(lib)) throw new Error('dist/ not found — run `npm run build` first')
const core = await import(pathToFileURL(lib).href)

const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`)
  return v
}
const int = (name, dflt, min) => {
  const n = Number(opt(name, String(dflt)))
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer ≥ ${min}`)
  return n
}
const generations = int('generations', 40, 1)
const seed = int('seed', 1, 0)
const workers = int('workers', availableParallelism(), 1)
const minGain = Number(opt('min-gain', '0'))
if (!Number.isFinite(minGain) || minGain < 0) throw new Error('--min-gain must be a number ≥ 0')
const classesOpt = opt('classes', '').trim()
const classes = classesOpt ? classesOpt.split(',').map((c) => c.trim()) : [...core.CLASS_KEYS]
for (const c of classes) if (!core.isClassKey(c)) throw new Error(`unknown class "${c}"`)
const genomesDir = resolve(root, opt('genomes-dir', 'genomes'))
const reportPath = resolve(root, opt('report', join(genomesDir, 'TRAINING_REPORT.md')))
const work = mkdtempSync(join(tmpdir(), 'dungeon-gym-nightly-'))

function champion(classKey) {
  const file = join(genomesDir, `${classKey}.json`)
  if (!existsSync(file)) return { genome: core.baselineGenome(classKey), source: 'baseline' }
  const parsed = core.parseGenome(readFileSync(file, 'utf8'))
  if (!parsed.ok) throw new Error(`${file}: invalid genome\n  ${parsed.errors.join('\n  ')}`)
  if (parsed.genome.classKey !== classKey) throw new Error(`${file}: genome is for ${parsed.genome.classKey}`)
  return { genome: parsed.genome, source: `genomes/${classKey}.json` }
}

function train(classKey, init) {
  const initFile = join(work, `${classKey}.init.json`)
  const outFile = join(work, `${classKey}.trained.json`)
  writeFileSync(initFile, core.serializeGenome(init))
  execFileSync(process.execPath, [cli, 'train', '--class', classKey, '--generations', String(generations), '--seed', String(seed),
    '--workers', String(workers), '--init', initFile, '--out', outFile], { stdio: ['ignore', 'ignore', 'inherit'] })
  const parsed = core.parseGenome(readFileSync(outFile, 'utf8'))
  if (!parsed.ok) throw new Error(`trainer wrote an invalid genome for ${classKey}`)
  return parsed.genome
}

const rows = []
for (const classKey of classes) {
  const t0 = Date.now()
  const { genome: before, source } = champion(classKey)
  const after = train(classKey, before)
  const b = core.benchmarkGenome(before)
  const a = core.benchmarkGenome(after)
  const improved = a.score > b.score + minGain
  if (improved) {
    mkdirSync(genomesDir, { recursive: true })
    writeFileSync(join(genomesDir, `${classKey}.json`), core.serializeGenome(after) + '\n')
  }
  rows.push({ classKey, source, before: b, after: a, improved })
  process.stdout.write(`${classKey.padEnd(10)} ${b.score.toFixed(3).padStart(8)} → ${a.score.toFixed(3).padStart(8)}  ${improved ? 'IMPROVED' : 'kept'}  (${((Date.now() - t0) / 1000).toFixed(1)} s)\n`)
}

const sha = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const improvedCount = rows.filter((r) => r.improved).length
const signed = (x) => (x >= 0 ? '+' : '') + x.toFixed(3)
const report = [
  '# Nightly training report',
  '',
  `${improvedCount} of ${rows.length} classes improved on \`${core.BENCHMARK.id}\` (32 seeds × ${core.BENCHMARK.depth} levels).`,
  '',
  '| class | champion | before | after | Δ | wins | genome | result |',
  '|---|---|---:|---:|---:|---|---|---|',
  ...rows.map((r) => `| ${r.classKey} | ${r.source} | ${r.before.score.toFixed(3)} | ${r.after.score.toFixed(3)} | ${signed(r.after.score - r.before.score)} | ${r.before.wins} → ${r.after.wins} | \`${r.before.genomeHash}\` → \`${r.after.genomeHash}\` | ${r.improved ? '**improved**' : 'kept'} |`),
  '',
  '## Reproduce',
  '',
  `- core commit \`${sha}\`, \`CORE_VERSION\` ${core.CORE_VERSION}`,
  `- \`node scripts/nightly-train.mjs --generations ${generations} --seed ${seed}${classesOpt ? ` --classes ${classesOpt}` : ''}${minGain ? ` --min-gain ${minGain}` : ''}\` after \`npm run build\``,
  '- the trainer starts from each champion; the result does not depend on `--workers`',
  '- a candidate replaces the champion only if its benchmark score is strictly higher (plus `--min-gain`)',
  '',
].join('\n')
mkdirSync(resolve(reportPath, '..'), { recursive: true })
writeFileSync(reportPath, report)
process.stdout.write(`\n${improvedCount} improved; report: ${reportPath}\n`)

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `improved=${improvedCount > 0}\n`)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report)
