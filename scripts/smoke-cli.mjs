// Smoke test of the built CLI: a short `train` → `validate` → `bench`.
// Usage: node scripts/smoke-cli.mjs [path/to/cli.mjs]   (default: dist/cli.mjs)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = resolve(process.argv[2] ?? join(root, 'dist', 'cli.mjs'))
if (!existsSync(cli)) throw new Error(`${cli} not found — run \`npm run build\` first`)

const dir = mkdtempSync(join(tmpdir(), 'dungeon-gym-smoke-'))
const run = (...args) => {
  process.stdout.write(`$ dungeon-gym ${args.join(' ')}\n`)
  const out = execFileSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' })
  process.stdout.write(out)
  return out
}
const expect = (ok, what) => {
  if (!ok) throw new Error(`smoke: ${what}`)
}

const genome = join(dir, 'fighter.json')
run('train', '--class', 'fighter', '--generations', '2', '--population', '4', '--seeds', '2', '--depth', '2',
  '--validate-seeds', '4', '--workers', '2', '--seed', '7', '--out', genome, '--curve', join(dir, 'curve.csv'))
expect(/^ok fighter [0-9a-f]{8}/.test(run('validate', genome)), 'validate did not accept the trained genome')
const bench = JSON.parse(run('bench', genome, '--workers', '2'))
expect(bench.classKey === 'fighter' && Number.isFinite(bench.score), 'bench did not return a score')
process.stdout.write(`smoke ok (${dir})\n`)
