# Scale plan — session handoff

Handoff between sessions executing `scale-plan.md` (the late-game "TIE fighter" at 20 publishers).
Same protocol as `worker-refactor-progress.md`: read this first, do the phase under **Next**, pass
its gate, rewrite this file.

## Next

**Phase A2: pausing dots through WebGL.** Phase A is complete and gated (table below). At 20
publishers the main thread now bounds the sim: the worker is idle 26% of the time at 13.9 ticks/s
while the page renders at 31.6 fps, and the last main-thread profile (`prof-F-pa2-main.txt`) had
72% of its time in 2D `drawImage` on the front canvas, one call per pausing dot per frame (12k
pausing dots at 13.9 ticks/s; ~2k at 60). Steps and gate as in the plan: the front canvas gets
its own WebGL context with the existing point-sprite renderer and a clip uniform that splits the
one buffer upload by `glow` (back `< 1.5`, front `≥ 1.5`); the 2D `drawEntry` path stays as the
fallback for both canvases. Gate A2: main-thread profile at `F` 20 publishers without `drawImage`
in the top entries and render fps ≥ 50; `.out/pausecheck.mjs` and `.out/canvascheck.mjs`
(`--disable-webgl`) pass; S, M, L, U, W unchanged (sim untouched). Profile the main thread with
`FTHROUGHPUT=300 node scripts/perf/prof.mjs F` (no `--worker`).

Queued after the tick-speed phases (A2–D): **Phase F, fork where routes diverge** (real DMR relay
accounting, user decision 2026-11-05; the plan has the steps and gate). It is a rule change, with
the throughput multiplier going 1.25 → 1.4 in the same commit.

## State of the tree

- Uncommitted, on top of commit `40fd51c` ("run the simulation in a Web Worker, fix fan-out hot
  spots"). One commit: "sim: release check in log time per candidate". Files: `src/sim/releaseIndex.ts`
  (new), `src/sim/__tests__/release.test.ts` (new), `src/sim/sim.ts`, `tsconfig.test.json` (new),
  `tsconfig.json`, `tsconfig.app.json`, `claude-docs/scale-plan.md` (steps marked done), this file.
  Plus one balance change the user asked for after the gate (not part of Phase A, sim untouched):
  `CLUSTER_THROUGHPUT_MULTIPLIER` 2.0 → 1.25 in `upgradeConfig.ts` (`claude-docs/upgrades.md`
  updated) so the TIE fighter's throughput levels (~65 ingestion, ~45 per bridged cluster) cost
  ~$130B instead of ~$5e21. The user commits.
- `src/sim/releaseIndex.ts`: dependency-free `ArrivalIndex` per subscriber (`pausingRemaining`,
  ascending `arrivals`, prefix `busy[i]`, `lastBad`), with `createArrivalIndex`,
  `finalizeArrivalIndex` (one sort + prefix per subscriber per tick, after the index loop),
  `insertArrival` (binary insert, prefix rebuilt from the insert point; O(1) at the end) and
  `canAcceptArrival` (the release check in O(log n)). The derivation is in the file header.
- `src/sim/sim.ts` Pass 2 / index section: `consumeDurationBySub` + `anyTimedSubscriber` computed
  once per tick in setup; the index loop runs only when some subscriber takes time and skips dots
  bound for a 0 ms subscriber (step 1c); `shouldReleaseTo` is `canAcceptArrival(timingFor(id), t, D)`
  after the 0 ms early return; releases insert into the index only for timed subscribers. Also
  (exact, beyond the plan's numbered steps, needed for the ≤ 60 ms gate): the pausing occupancy
  buckets are not filed for 0 ms subscribers (the only reader skips them; "1d"), the two setup
  passes over all dots for the DMQ count and the queue backlog are one pass ("1e"), and the
  per-target release constants (release path, speed, stagger progress-per-ms) are built once per
  queue per tick (`entryFor`/`fanOutData`) with one object spread per released dot instead of two
  ("1f"). `buildReleasePath` and `shouldReleaseTo` are defined once per queue, not per candidate.
- `src/sim/__tests__/release.test.ts`: the old chain walk verbatim as the reference; 4 tests,
  >100k random checks (ties, both rejection halves, consume 0 and > 0, mid-list and end inserts,
  index after inserts equal to a fresh finalize). Run: `npx tsc -b && node --test
  src/sim/__tests__/release.test.ts` (Node 24 strips the types; imports use `.ts` extensions).
- `tsconfig.test.json` (Node types, `include: ["src/**/__tests__"]`) is referenced from
  `tsconfig.json`; `tsconfig.app.json` excludes `src/**/__tests__`. Reason: the app project's
  `types: ["vite/client"]` hides `node:test`, and adding `node` to it would change `setTimeout`
  typing for the app. The three pre-existing tsconfig files are LF in the repo; the new one is CRLF.
- Labels in `scripts/perf/.out/`: `pa3` (S, M, L, U, W, F), `pa3-2` and `pa3-10` (`F` with
  `FPUBS=2`/`10`, both with `FTHROUGHPUT=300`). `prof-F-pa3-worker.txt` is the worker profile of the
  intermediate build (index rewrite + 1c only, before 1d–1f).
- Lint 23/3, tsc clean, all touched files CRLF except the pre-existing LF `tsconfig.json`/`tsconfig.app.json`.

## Measured so far (headless, worker mode, `F` with `FTHROUGHPUT=300` unless noted)

| step | pubs | ticks/s | ms/tick | live dots | consumed/s | main fps |
|---|---|---|---|---|---|---|
| Phase 3 build | 20 | 3.9 (worker fell back inline on a >3 s tick) | 5,873 | 95k | 254 | 60 |
| + release fast path (`pa1`) | 20 | 2.1 | 555 | 132k | 30,445 | 24.5 |
| + occupancy fast path (`pa2`) | 20 | 7.0 | 103 | 136k | 136,339 | 21.6 |
| + sorted index, 1c (intermediate) | 20 | 9.7 | 68.5 | 134k | 163,741 | 23.8 |
| + 1d–1f (`pa3`, Gate A) | 20 | 13.9 | 47.2 | 122k | 170,121 | 31.6 |
| `pa3-10` | 10 | 39.3 | 19.2 | 55k | 89,573 | 58.5 |
| `pa3-2` | 2 | 59.4 | 3.8 | 11.1k | 19,160 | 59.8 |
| `pa2` | 10 | 18.1 | 43 | 61k | 91,384 | 52.7 |
| `pa2` | 2 (caps at max, no `FTHROUGHPUT`) | 57.2 | 7.8 | 6.1k | 8,119 | 60 |

Production is 192k/s at 20 publishers (89% delivered in `pa3`), 96k at 10 (93%), 19.2k at 2
(100%). `pa3` sections at 20 pubs (ms/tick): setup 6.0, pass1 20.9, index 0.13, pass2 7.1, pass3
3.2, sigs 1.8 (sum 39; the harness `tickMs` also covers `fillPositions` and `buildSummary`, ~8 ms).
The intermediate build had setup 10.7 (5.1 of it the two full-array queued-count passes, 3.1 the
pausing-bucket seeding), pass1 26.5, index 0.2, pass2 14.5. Worker profile of the intermediate
build: idle 26%, frame function 28.6%, `tick` self 11.6%, GC 8.0%, `fillPositions` 8.7%,
`onmessage` 4.5%, `getPathInfo` 4.3%, `buildReleasePath` 1.8%, `shouldReleaseTo` 0.2%.

Gate A scales, `pa3` vs `wbase` (consumed/dropped/earned per s): S 8.2/175.88/3244.6 →
8.2/175.13/3168.76 (earned −2.3%, this scale's known run noise; consumed and dropped exact);
M 1440.3/0/745474 → 1439.6/0/745052; L 4323/0/3.104M → 4325.5/0/3.105M; U 13682/0/9.82M →
14405.7/0/10.34M (fps 51.9 → 59.8, 59.5 ticks/s; the +5% is the established ticks/s correlation,
`pa2` had 13734 at 53.9 ticks/s); W 1/9.06/29.97 → 1/9.06/29.98. dragsmoke M: worker 890
traveling 0 off-path 0 dangling, inline 880 0/0, no errors. Manual checks A–D pass in worker mode
(D: inline fallback after 3052 ms). Unit test 4/4. tsc clean, lint 23/3.

## Findings

- **The plan's step 2 formulation is heavier than needed** (`scale-plan.md` Phase A step 2, the
  "suffix slack" recurrence). With the candidate placed after the `k` arrivals ≤ t, the reference
  walk's second half reduces to: `arrivals[k] ≥ t + D` for the next arrival and `arrivals[i] ≥
  arrivals[i-1] + D` for every later pair, because once an arrival does not collide its `busyUntil`
  is exactly `arrival + D` again (the chain re-synchronizes). The later-pair condition is a property
  of the list alone (`lastBad`), so no suffix array is needed. Quirk preserved on purpose: the
  reference rejects a candidate when a collision exists further down the chain even though that
  collision happens with or without the candidate.
- **Same-tick releases do not always ascend** (plan step 3 "assert, don't assume"): releases from
  one queue ascend by the stagger, but two queues releasing to the same subscriber in one tick
  have different path lengths, so the second queue's arrivals can land before the first's.
  `insertArrival` therefore binary-inserts and rebuilds the prefix from the insert point; appends
  stay O(1). The unit test covers mid-list inserts (>500 of them).
- The 60 ms gate needed more than steps 1c–3: after the index rewrite the tick was 68.5 ms and the
  index section was already 0.2 ms. The remaining time was the dot count (pass 1, 0.2 µs per dot,
  linear) and per-candidate bookkeeping in Pass 2 (two object spreads per released dot, 20 cache-key
  string concatenations and 40 speed computations per candidate), plus 5 ms of two full-array
  passes in setup. 1d–1f are exact and took it to 47 ms; they are listed in State of the tree.
- The harness `tickMs` (worker `performance.now()` around tick + `fillPositions` + summary) is ~8 ms
  above the sum of the sections at 20 publishers. Quote both when reporting.
- At 20 publishers the worker idles 26% waiting for the main thread (31.6 fps, 44% of inputs late):
  Phase A2 is the bottleneck now. GC is 8% of the worker thread there (3.9% in the earlier variant):
  one spread copy per arriving dot (`pausingDot`, 12–20k per tick) and one per released dot; Phase
  C's bundles cut both counts.
- `avgQueued` 6–7 at `W` in every label since `p3` (Phase 3) is pre-existing, not from this session.
- The `F` 2-publisher row in the earlier table (`pa2`, 8.1k/s) ran without `FTHROUGHPUT`; `pa3-2`
  runs with it (19.2k/s, 100% of production). Compare like with like.
- `CLAUDE.md`'s file structure does not list `src/sim/*` yet (worker-refactor Phase 4, still
  pending); `releaseIndex.ts` and the test directory belong in that update.
- The auto-publisher poll caps auto fire at 10/s per publisher regardless of `publishSpeed`
  (see plan Phase B); the F numbers assume that cap.

## History

- 2026-11-05: plan written after the Phase 3 worker gate; `F` scale built; Phase A steps 1 and
  the occupancy fast path done and measured (table above); worker ack watchdog fixed.
- 2026-11-05: Phase A finished (1c, 2, 3 + exact 1d–1f) and gated: `F` 20 pubs 103 → 47.2 ms/tick,
  136k → 170k consumed/s; S/M/L/U/W within noise of `wbase`; dragsmoke both modes clean; manual
  checks A–D pass; unit test 4/4; tsc clean; lint 23/3.
