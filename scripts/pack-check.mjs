// Installs the package the way a consumer would and checks that the runtime
// import, the bundled types (NodeNext and Bundler resolution) and the CLI bin
// all work. Run through npm so npm_execpath is set:
//   npm run pack:check -- [--dir <empty dir>] [--from <install spec>]
// Without --from it packs this checkout (`npm pack`); with it, it installs any
// spec instead, e.g. `git+file:///path/to/repo#<sha>` or `github:owner/repo#<sha>`.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('run this through npm: `npm run pack:check`')

const argv = process.argv.slice(2)
const opt = (name) => {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return undefined
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`)
  return v
}
const dir = opt('dir') ? resolve(opt('dir')) : mkdtempSync(join(tmpdir(), 'dungeon-gym-pack-'))
mkdirSync(dir, { recursive: true })

const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
const npm = (args, cwd) => sh(process.execPath, [npmCli, ...args], cwd)
const expect = (ok, what) => {
  if (!ok) throw new Error(`pack:check: ${what}`)
}

let spec = opt('from')
if (!spec) {
  const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', dir], root))
  const files = packed.files.map((f) => f.path)
  process.stdout.write(`packed ${packed.filename}: ${files.length} files, ${packed.size} bytes\n`)
  for (const f of ['dist/index.mjs', 'dist/index.d.ts', 'dist/cli.mjs', 'dist/worker.mjs', 'LICENSE', 'LICENSE-SRD.md']) {
    expect(files.includes(f), `${f} missing from the tarball`)
  }
  expect(!files.some((f) => /^(src|test|cli|scripts)\//.test(f)), 'sources leaked into the tarball')
  spec = join(dir, packed.filename)
}

const app = join(dir, 'consumer')
mkdirSync(app, { recursive: true })
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }, null, 2))
npm(['install', '--no-audit', '--no-fund', spec], app)

writeFileSync(join(app, 'run.mjs'), `
import { CORE_VERSION, BENCHMARK, baselineGenome, benchmarkGenome, serializeGenome } from 'dungeon-gym-core'
import { writeFileSync } from 'node:fs'
const genome = baselineGenome('fighter')
const r = benchmarkGenome(genome, { ...BENCHMARK, seeds: BENCHMARK.seeds.slice(0, 2), depth: 2 })
writeFileSync('fighter.json', serializeGenome(genome))
console.log(JSON.stringify({ coreVersion: CORE_VERSION, score: r.score }))
`)
const ran = JSON.parse(sh(process.execPath, ['run.mjs'], app))
expect(typeof ran.coreVersion === 'string' && Number.isFinite(ran.score), 'runtime import failed')
process.stdout.write(`import ok: CORE_VERSION ${ran.coreVersion}\n`)

writeFileSync(join(app, 'types.ts'), `
import { baselineGenome, playRun, type Genome, type RunResult } from 'dungeon-gym-core'
const genome: Genome = baselineGenome('wizard')
const result: RunResult = playRun({ seed: 1, depth: 1, party: [{ genome }] })
export const won: boolean = result.members[0].won
`)
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
for (const resolution of ['NodeNext', 'Bundler']) {
  const module = resolution === 'NodeNext' ? 'NodeNext' : 'ESNext'
  sh(process.execPath, [tsc, '--noEmit', '--strict', '--types', 'node', '--typeRoots', join(root, 'node_modules', '@types'),
    '--module', module, '--moduleResolution', resolution, '--target', 'ES2022', 'types.ts'], app)
  process.stdout.write(`types ok (${resolution})\n`)
}

const validated = npm(['exec', '--no', '--', 'dungeon-gym', 'validate', 'fighter.json'], app)
expect(/^ok fighter /.test(validated), 'bin `dungeon-gym validate` failed')
process.stdout.write(`bin ok: ${validated}pack:check ok (${dir})\n`)
