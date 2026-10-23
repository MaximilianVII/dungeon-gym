// Benchmark regression guard for the 12 baseline genomes.
//   node scripts/bench-baseline.mjs check   — fail if scores drift without a CORE_VERSION bump
//   node scripts/bench-baseline.mjs update  — rewrite bench/baseline.json
// Runs against the built library (dist/index.mjs); the npm scripts build first.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const lib = join(root, 'dist', 'index.mjs')
const baselinePath = join(root, 'bench', 'baseline.json')
const inActions = process.env.GITHUB_ACTIONS === 'true'

function fail(message) {
  process.stderr.write(`${inActions ? '::error title=bench:check::' : ''}${message.replaceAll('\n', inActions ? '%0A' : '\n')}\n`)
  process.exit(1)
}

if (!existsSync(lib)) fail(`${lib} not found — run \`npm run build\` first.`)
const core = await import(pathToFileURL(lib).href)

function measure() {
  const genomes = {}
  for (const classKey of core.CLASS_KEYS) {
    const r = core.benchmarkGenome(core.baselineGenome(classKey))
    const scoresHash = core.hashString(r.scores.join(',')).toString(16).padStart(8, '0')
    genomes[classKey] = { genomeHash: r.genomeHash, score: r.score, wins: r.wins, scoresHash }
  }
  return { benchmarkId: core.BENCHMARK.id, coreVersion: core.CORE_VERSION, genomes }
}

function diff(before, after) {
  const rows = []
  for (const classKey of new Set([...Object.keys(before.genomes ?? {}), ...Object.keys(after.genomes)])) {
    const a = before.genomes?.[classKey]
    const b = after.genomes[classKey]
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    const fmt = (e) => (e ? `${e.score.toFixed(3)} (${e.wins} wins, ${e.genomeHash})` : '—')
    rows.push(`  ${classKey.padEnd(10)} ${fmt(a)}  →  ${fmt(b)}`)
  }
  return rows
}

const mode = process.argv[2]
const current = measure()

if (mode === 'update') {
  mkdirSync(dirname(baselinePath), { recursive: true })
  writeFileSync(baselinePath, JSON.stringify(current, null, 2) + '\n')
  process.stdout.write(`wrote bench/baseline.json for ${current.benchmarkId}\n`)
} else if (mode === 'check') {
  if (!existsSync(baselinePath)) fail('bench/baseline.json is missing — run `npm run bench:update` and commit it.')
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const rows = diff(baseline, current)
  if (baseline.coreVersion !== current.coreVersion || baseline.benchmarkId !== current.benchmarkId) {
    fail(
      `Baseline is for ${baseline.benchmarkId}, the code is ${current.benchmarkId} (CORE_VERSION bumped).\n` +
        `Run \`npm run bench:update\` and commit bench/baseline.json.` +
        (rows.length ? `\nChanged scores:\n${rows.join('\n')}` : ''),
    )
  }
  if (rows.length) {
    fail(
      `Benchmark scores changed but CORE_VERSION is still ${current.coreVersion}:\n${rows.join('\n')}\n` +
        'A change that alters any run must bump CORE_VERSION in src/version.ts, then run `npm run bench:update`.',
    )
  }
  process.stdout.write(`bench:check ok — ${Object.keys(current.genomes).length} baseline genomes match ${current.benchmarkId}\n`)
} else {
  fail('usage: node scripts/bench-baseline.mjs <check|update>')
}
