// Bundles the core library for package consumers: dist/index.mjs (ESM, no
// runtime dependencies) and dist/index.d.ts (one self-contained declaration
// file, so it resolves under both "Bundler" and "NodeNext" consumers).
import { build } from 'esbuild'
import dts from 'dts-bundle-generator'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outdir = `${root}/dist`

await build({
  entryPoints: [`${root}/src/index.ts`],
  outfile: `${outdir}/index.mjs`,
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
  logLevel: 'warning',
})

const [types] = dts.generateDtsBundle(
  [{ filePath: `${root}/src/index.ts`, output: { noBanner: true, exportReferencedTypes: false } }],
  { preferredConfigPath: `${root}/tsconfig.build.json` },
)
mkdirSync(outdir, { recursive: true })
writeFileSync(`${outdir}/index.d.ts`, types)
