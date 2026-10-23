// Bundles the Node CLI and its worker into dist/ (the core itself ships as
// TypeScript source; see package.json "exports"). Optional arg: output dir.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outdir = process.argv[2] ?? `${root}/dist`

await build({
  entryPoints: { cli: `${root}/cli/main.ts`, worker: `${root}/cli/worker.ts` },
  outdir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
})
