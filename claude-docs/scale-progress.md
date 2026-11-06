# Scale plan — session handoff

Handoff between sessions executing `scale-plan.md` (the late-game "TIE fighter" at 20 publishers).
Same protocol as `worker-refactor-progress.md`: read this first, do the phase under **Next**, pass
its gate, rewrite this file.

## Next

Phase A, remaining steps: (a) skip building the per-subscriber arrival index (`subTiming`) and the
`predictedArrival` pushes for subscribers whose consume duration is 0 (nothing reads them once
`shouldReleaseTo` returns early; `index` is 27 ms and `pass2` 18 ms of the 103 ms tick at 20
publishers); (b) the general sorted-index rewrite of `shouldReleaseTo` with the dependency-free
unit test, so meshes with consume durations > 0 scale too; then Gate A. After Gate A do
**Phase A2 (new, see plan): pausing dots through WebGL** — the main thread is now the limit at
20 publishers (72% of it in 2D `drawImage` of ~15k pausing dots per frame).

## State of the tree

- Uncommitted, on top of the Phase 3 worker commit point. Everything since is in the working tree
  together; a sensible split: (1) "ui: sim rate replaces frame rate in stats" (Sidebar, WinScreen,
  `getMinSimTicksPerSec`, `getMinFps` removed); (2) "sim: worker acks inputs so a slow tick is not
  a dead worker" (`busy` message, watchdog); (3) "sim: zero-consume fast paths in release and
  occupancy checks + per-section tick timers" (sim.ts, protocol, worker, bridge stats,
  behavior.mjs); (4) "perf: F scale (TIE fighter) + non-fatal screenshot" (prof.mjs, behavior.mjs,
  README). The user commits.
- `sim.ts`: two exact fast paths, both keyed on `consumeDurationFor(sub) === 0` (fasterConsumption
  ≥ 11): `shouldReleaseTo` returns `true` before building the chain; the subscriber-occupancy
  bucket scan on arrival is skipped. Per-section timers (`tickSections`, `sectionStart`/`sectionEnd`)
  around setup / pass1 / index / pass2 / pass3 / sigs / publish, cumulative ms, carried in the
  tick message (`sections`) and exposed as `window.__sim.stats().sections`; `behavior.mjs` prints
  `sectionMsPerTick`.
- Worker protocol: `busy` ack posted before the tick; the bridge's 3 s watchdog trips only without
  the ack. `manualcheck.mjs` D (terminate the worker) still falls back inline in 3.0 s.
- Harness: scale `F` (`FPUBS=<n>`, `FTHROUGHPUT=<level>` env) builds the TIE fighter: N publishers
  → `webhook-1` (DMR Cluster, 2 bridge slots) → `broker-2`/`broker-3` (DMR Clusters) → the same 4
  queues (`queue-1..4`, buffer 17, 20 subscriber slots, fan-out) → the same 20 subscribers
  (fasterConsumption 11 = 0 ms consume). `FTHROUGHPUT=300` is required to reach the load: at the
  upgrade max the caps drop most of the fan-out (20 pubs: 8.1k consumed/s, 3.4k dropped/s).
  `behavior.mjs` writes its JSON before the screenshot and tolerates a screenshot timeout.
- Labels in `scripts/perf/.out/`: `pa1` (release fast path only), `pa2` (both fast paths; the
  numbers below). `F` runs: `f2`, `f20`, `f20hi` (first layout, not the TIE fighter), `tie2`,
  `tie20`, `pa1`, `pa2`, `pa2-10`, `pa2-2` (TIE fighter). Profiles: `prof-F-*-worker.txt`,
  `prof-F-pa1-noinline.txt`, `prof-F-pa2-main.txt`.
- Lint 23/3, tsc clean, all files CRLF.

## Measured so far (headless, worker mode, `F` with `FTHROUGHPUT=300` unless noted)

| step | pubs | ticks/s | ms/tick | live dots | consumed/s | main fps |
|---|---|---|---|---|---|---|
| Phase 3 build | 20 | 3.9 (worker fell back inline on a >3 s tick) | 5,873 | 95k | 254 | 60 |
| + release fast path (`pa1`) | 20 | 2.1 | 555 | 132k | 30,445 | 24.5 |
| + occupancy fast path (`pa2`) | 20 | 7.0 | 103 | 136k | 136,339 | 21.6 |
| `pa2` | 10 | 18.1 | 43 | 61k | 91,384 | 52.7 |
| `pa2` | 2 (caps at max) | 57.2 | 7.8 | 6.1k | 8,119 | 60 |

Production at 20 publishers is 192k/s (1,200 fires × 160); `pa2` delivers 71% of it, at 10
publishers 95%. `pa2` sections at 20 pubs (ms/tick): setup 11, pass1 32, index 27, pass2 18,
pass3 3, sigs 2. Pass 1 is now 0.23 µs per dot (linear). Main-thread profile at 20 pubs: 72%
`drawImage` (2D front canvas, one call per pausing dot per frame, ~15k pausing), 4% message
handling, 2% GL render, <1% `applyConsumes`.

Gate scales on `pa2` vs `wbase` (consumed/dropped/earned per s): S 8.2/175.9/3245 →
8.2/175.2/3459 (earned +6.6%: at 8 consumes/s the mix of publisher tiers in a 15 s window is
the noise; consumed and dropped exact); M 1440.3/0/745474 → 1440.6/0/745614; L 4323/0/3.104M →
4293/0/3.082M; U 13682/0/9.82M → 13734/0/9.86M (fps 51.9 → 60, 53.9 ticks/s); W 1/9.06/29.97 →
1/9/29.99. dragsmoke M: worker 902 traveling 0/0, inline 900 0/0, no errors. Manual checks A–D
pass in worker mode.

## Findings

- The 6 ticks/s the player saw was two quadratic checks, not dot volume: `shouldReleaseTo`
  rebuilt and re-sorted every dot bound for a subscriber per candidate per fan-out target, and the
  arrival occupancy check scanned every pausing dot at the subscriber per arrival. Both are
  harmless until fan-out multiplies arrivals per subscriber. With 0 ms consume both are provably
  no-ops; with > 0 ms the occupancy rule itself keeps the bucket small, so only the release chain
  needs the general rewrite.
- V8 inlines the frame function into `tick` (Maglev inlining is not covered by
  `--no-turbo-inlining`), so the function-level profile could not separate the passes; the
  section timers could. Keep them.
- With 0 ms consume, dots still spend one tick as `pausing` (consumed on the next tick), so at
  7 ticks/s 15–18k pausing dots exist at any moment and the 2D front canvas draws each with
  `drawImage`. At 60 ticks/s the same mesh would hold ~2k pausing dots, so Phase A's remaining
  steps shrink the problem but do not remove it; Phase A2 does.
- The remaining per-tick cost at 20 publishers after A2 is the dot count itself (~75k at a healthy
  tick rate: 192k/s × ~0.4 s lifetime), which is Phase C (bundles) territory.
- `applyConsumes` is already one aggregated `recentEarnings` entry per batch and ~19k consumes per
  tick cost under 1% of the main thread; the summary's `consumed` entries still carry an unused
  `id` string each (cloned across the worker boundary; trim in Phase C when the entries change).
- The auto-publisher poll caps auto fire at 10/s per publisher regardless of `publishSpeed`
  (see plan Phase B); the F numbers assume that cap.

## History

- 2026-11-05: plan written after the Phase 3 worker gate; `F` scale built; Phase A steps 1 and
  the occupancy fast path done and measured (table above); worker ack watchdog fixed.
