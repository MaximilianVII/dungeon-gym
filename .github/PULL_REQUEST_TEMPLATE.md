## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `npm run check` is green (typecheck, tests with coverage, `bench:check`, CLI smoke)
- [ ] If this changes the outcome of any run (rules, generator, policy, reward): `CORE_VERSION` is bumped in `src/version.ts` and `bench/baseline.json` is regenerated with `npm run bench:update`
- [ ] Game content is SRD 5.1 only (no names or mechanics from outside the SRD); `LICENSE-SRD.md` lists any new changes to SRD material
- [ ] No `Math.random`, `Date.now` or module-level mutable state in `src/`
- [ ] Commits follow Conventional Commits (`feat:`, `fix:`, `docs:` …)

## Benchmark impact

<!-- Paste `node dist/cli.mjs bench` lines or the bench:check diff if scores changed. -->
