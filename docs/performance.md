# Simulation throughput (CORE_VERSION 0.3.0)

`node dist/cli.mjs speed --workers K --runs N`: full benchmark-depth runs
(10 floors, all 12 baseline genomes in turn), after a warm-up batch.

Machine: AMD Ryzen 9 9950X3D (16 cores / 32 threads, `availableParallelism`
16), Windows 11, Node 24.20.

| workers | runs | seconds | runs / s | speed-up |
|---|---|---|---|---|
| 1 | 96 | 2.02 | 47.5 | 1.0× |
| 2 | 192 | 1.96 | 97.9 | 2.1× |
| 4 | 384 | 2.05 | 186.9 | 3.9× |
| 8 | 768 | 2.67 | 287.4 | 6.1× |
| 16 | 1536 | 4.04 | 380.3 | 8.0× |

- One 10-floor run costs ≈ 21 ms on one core; the official benchmark (32
  runs) ≈ 0.7 s single-threaded, ≈ 0.1 s on 16 workers.
- A 30-generation training of one class (8 × 12 runs per generation + 32
  hold-out runs per candidate) is ≈ 3 900 runs ≈ 10–15 s on 16 workers.
- Scaling is near-linear to 4 workers and flattens after 8 (SMT siblings,
  memory bandwidth, structured-clone cost of each genome message).

**Rust/WASM?** Not needed yet: a training run is seconds, and a server
re-scoring an upload costs < 1 s of CPU. The hot spots are the per-step BFS
(path/frontier, allocates typed arrays per call) and `visibleTiles`; caching
those in TypeScript is the cheaper next step. A port would only pay off for
much larger training budgets (≥ 10⁶ runs per session).
