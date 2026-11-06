# Scale plan — session handoff

Handoff between sessions executing `scale-plan.md` (the late-game "TIE fighter" at 20 publishers).
Same protocol as `worker-refactor-progress.md`: read this first, do the phase under **Next**, pass
its gate, rewrite this file.

## Next

**Phase B: tick-rate independence audit.** Phases A and A2 are complete and gated (table below).
At 20 publishers the main thread renders at 59.8 fps and no longer bounds the sim; the worker does:
45 ms ticks, 54 ms round trip with one input in flight, 17.8 ticks/s (70% of frames merge their
deltas into the next input). Phase B, as in the plan: (1) a `--ticks=<n>` harness switch on
`behavior.mjs` backed by a `window.__sim.setMaxTicksPerSec(n)` bridge hook, `behavior.mjs`
reporting consumed per **sim** second (`summary.simNow` delta), then U and F at 60/30/15 ticks/s;
(2) every rule that is not flat is listed and measured; the known candidates (auto-publisher
poll's 10/s cap, DMQ one-release-per-tick, per-tick `releaseStaggerFor`) are **balance decisions**:
list them with their measured effect and ask, do not change them without the user's decision
recorded here. Gate B: the flat-income table at 60/30/15 for U and F; S, M, L, U, W vs `wbase`
within noise unless a listed change explains the delta. Commit: "sim: income independent of tick
rate". Phases C (bundles) and D (render interpolation) follow; C is what will move the 20-publisher
tick rate (the worker is the bound now, and every section of its tick is linear in the dot count).

Queued after the tick-speed phases (B–D): **Phase F, fork where routes diverge** (real DMR relay
accounting, user decision 2026-11-05; the plan has the steps and gate). It is a rule change, with
the throughput multiplier going 1.25 → 1.4 in the same commit.

## State of the tree

- Uncommitted, on top of commit `576ab75` ("update scale plan"; Phase A and the 1.25 multiplier
  are committed as `20f8be0`). One commit: "canvas: pausing dots in WebGL". Files:
  `src/components/EventCanvas.tsx`, `claude-docs/scale-plan.md` (A2 steps marked done), this file.
  The two check scripts under the gitignored `scripts/perf/.out/` changed too (below). The user
  commits.
- `src/components/EventCanvas.tsx`: each canvas is a `Surface` (`createSurface(canvas, front)`):
  a WebGL point-sprite renderer when available, else the 2D `drawEntry` fallback; context-lost /
  restored handlers per surface. `createGlRenderer(canvas, front)` sets a new vertex-shader
  uniform `u_front` once per context; the shader clips entries whose `(a_glow > 1.5)` does not
  match it, so the back context draws dropped/live entries and the front context pausing entries
  (glow 2) from the same CPU buffer. Each context does its own `bufferData` of the full buffer
  (WebGL contexts cannot share buffer objects); the front upload and draw are skipped on frames
  where the front canvas was and stays empty (`frontHadContent`, as the 2D clear was). `render2d`
  is the shared 2D fallback (clear + stamp the matching half). `window.__eventCanvasRenderer` is
  `'webgl'` when both canvases are GL, `'2d'` when neither, `'mixed'` otherwise. The sim and the
  buffer layout (`positions.ts`) are untouched.
- `scripts/perf/.out/pausecheck.mjs` and `canvascheck.mjs`: a WebGL canvas has no 2D context, so
  both now count alpha pixels by drawing the canvas into a scratch 2D canvas **in the same
  animation frame** (EventCanvas's RAF runs first, and the drawing buffer is intact until
  compositing). `pausecheck.mjs` takes `--disable-webgl` (2D fallback on both canvases) and prints
  the renderer; `canvascheck.mjs` runs GL M, GL W, noGL M and noGL W and reports the front count
  both same-frame and next-frame. `pausediag.mjs` (scratch) dumps the first pausing entries.
- Labels in `scripts/perf/.out/`: `a2` (S, M, L, U, W, F), `a2-w2` (W re-run), `a2-2` and `a2-2b`
  (F, `FPUBS=2`), `a2-10` (`FPUBS=10`), all F with `FTHROUGHPUT=300`. Main-thread profile
  `prof-F-a2-main.txt` (uncapped RAF, as `prof.mjs` runs).
- Lint 23/3, tsc clean, all touched tracked files CRLF.

## Measured so far (headless, worker mode, `F` with `FTHROUGHPUT=300` unless noted)

| step | pubs | ticks/s | ms/tick | live dots | consumed/s | main fps |
|---|---|---|---|---|---|---|
| Phase 3 build | 20 | 3.9 (worker fell back inline on a >3 s tick) | 5,873 | 95k | 254 | 60 |
| + release fast path (`pa1`) | 20 | 2.1 | 555 | 132k | 30,445 | 24.5 |
| + occupancy fast path (`pa2`) | 20 | 7.0 | 103 | 136k | 136,339 | 21.6 |
| + sorted index, 1c (intermediate) | 20 | 9.7 | 68.5 | 134k | 163,741 | 23.8 |
| + 1d–1f (`pa3`, Gate A) | 20 | 13.9 | 47.2 | 122k | 170,121 | 31.6 |
| + front canvas in WebGL (`a2`, Gate A2) | 20 | 17.8 | 45.1 | 123k | 183,713 | 59.8 |
| `a2-10` | 10 | 39.8 | 21.1 | 56k | 90,224 | 59.9 |
| `a2-2` / `a2-2b` | 2 | 56.3 / 59.5 | 5.3 / 4.9 | 11.1k | 18,597 / 19,096 | 59.8 / 59.9 |
| `pa3-10` | 10 | 39.3 | 19.2 | 55k | 89,573 | 58.5 |
| `pa3-2` | 2 | 59.4 | 3.8 | 11.1k | 19,160 | 59.8 |
| `pa2` | 2 (caps at max, no `FTHROUGHPUT`) | 57.2 | 7.8 | 6.1k | 8,119 | 60 |

Production is 192k/s at 20 publishers (95.7% delivered in `a2`, 89% in `pa3`), 96k at 10 (94%),
19.2k at 2 (99%). `a2` sections at 20 pubs (ms/tick): setup 4.8, pass1 21.0, index 0.1, pass2 6.4,
pass3 2.8, sigs 1.6, publish 0.1 (sum 36.7; harness `tickMs` 45.1 also covers `fillPositions` and
`buildSummary`; round trip 54.4 ms, 30% of inputs late, 70% of frames merged). The sim is
untouched since `pa3`; the tick-rate gain comes from the main thread handing inputs back sooner.

Main thread at `F` 20 pubs, `prof-F-a2-main.txt` (uncapped RAF: 162 fps, 124k live dots,
~15 ticks/s): `(program)` 49.3%, `render` self 7.8% (the pausing scan plus GL calls),
`bufferData` 7.8% (two uploads of ~4 MB per frame), `worker.onmessage` 7.5%, idle 5.7%,
`formatMoney` 1.8%, GC 1.6%, `applyConsumes` 1.1%; inclusive React `performWorkOnRoot` 9.3%,
`receiveTick` 2.5%, `commitFrame` 2.2%. **No `drawImage` entry at all** (it was 72.2% of the main
thread at 21.5 fps in `prof-F-pa2-main.txt`).

Gate A2 scales, `a2` vs `wbase` (consumed/dropped/earned per s): S 8.2/175.88/3244.6 →
8.2/174.32/3286.45 (earned +1.3%, dropped −0.9%, this scale's known run noise); M 1440.3/0/745474
→ 1439.1/0/744800; L 4323/0/3.104M → 4325.7/0/3.105M; U 13682/0/9.82M → 14409.7/0/10.34M (fps
51.9 → 59.9, 59.3 ticks/s; the same +5% as `pa3`, the established ticks/s correlation); W first
run 0.9/9.06/27.99 (one event short at the 15 s window edge on a 1/s rate), re-run `a2-w2`
1/9/29.99 exact. dragsmoke M: worker 914 traveling 0 off-path 0 dangling, inline 900 0/0, no errors,
1440 consumed/s in both. Manual checks A–D pass in worker mode (D: inline fallback after 3056 ms,
consumption resumes). tsc clean, lint 23/3.

Pixel checks (alpha > 0 pixels on the front canvas): `pausecheck` starter layout, GL 88 → 72 → 52
→ 38 over the shrink (extent 6.5 → 4.0) vs the 2D fallback 68 → 52 → 32 → 24 at the same extents;
`canvascheck` GL W 80 (same frame and next frame), 2D W 56–58; both canvases draw in the
`--disable-webgl` run with no errors. The ~20-pixel GL surplus is the fragment shader's one-pixel
anti-aliased fringe beyond `GLOW_RADIUS`, which the back canvas has had since the WebGL round;
pausing dots now match traveling dots instead of the 2D stamp.

## Findings

- **Plan wording vs WebGL** (`scale-plan.md` Phase A2 step 1, "from the same buffer upload"):
  two WebGL contexts cannot share a buffer object, so the front and back canvases each
  `bufferData` the same CPU `Float32Array`. The uniform split is as planned; the cost is a second
  ~4 MB upload per frame at 124k dots (`bufferData` 7.8% of the uncapped main-thread profile,
  roughly 3% at 60 fps). If that ever matters, the fix is to compact the pausing entries into a
  small second array on the CPU side during the `hasPausing` scan the render loop already does.
- **`canvascheck` at M reports 0 front pixels in every mode**, before and after A2: the M layout's
  subscribers sit at x = 1650 while the mesh canvas beside the sidebar is 1632 CSS px wide, so at
  the default pan every pausing dot is just off the right edge (`pausediag.mjs`: entries at
  (1650, y), extent 6.5, alpha 1). Not a rendering fact; W and the starter layout show the pixels.
  A harness layout quirk, left as is.
- **At 20 publishers the worker now bounds the tick rate**: 45 ms tick + ~9 ms transfer and
  commit = 54 ms round trip with one input in flight → 17.8 ticks/s. Every tick section is linear
  in the dot count (pass1 21 ms over 123k dots = 0.17 µs per dot), so the next real gain is Phase
  C's 6× fewer dots; Phase D hides the remaining tick gap visually. The merged-frame share (70%)
  means the sim steps ~56 ms per tick there; income per sim second is what Phase B audits.
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
- The 60 ms Gate A needed more than steps 1c–3: after the index rewrite the tick was 68.5 ms and
  the index section was already 0.2 ms. The remaining time was the dot count (pass 1, 0.2 µs per
  dot, linear) and per-candidate bookkeeping in Pass 2 (two object spreads per released dot, 20
  cache-key string concatenations and 40 speed computations per candidate), plus 5 ms of two
  full-array passes in setup. 1d–1f are exact and took it to 47 ms.
- The harness `tickMs` (worker `performance.now()` around tick + `fillPositions` + summary) is ~8 ms
  above the sum of the sections at 20 publishers. Quote both when reporting.
- GC is 8% of the worker thread at 20 publishers (3.9% in the earlier variant): one spread copy per
  arriving dot (`pausingDot`, 12–20k per tick) and one per released dot; Phase C's bundles cut both.
- `avgQueued` 6–8 at `W` in every label since `p3` (Phase 3) is pre-existing, not from this session.
- The `F` 2-publisher row `pa2` (8.1k/s) ran without `FTHROUGHPUT`; later rows run with it.
  Compare like with like. Run-to-run spread at `FPUBS=2` is ±3 ticks/s and ±3% consumed (`a2-2`
  vs `a2-2b`).
- `CLAUDE.md`'s file structure does not list `src/sim/*` yet (worker-refactor Phase 4, still
  pending); `releaseIndex.ts`, the test directory and the two-surface `EventCanvas` belong in that
  update (`CLAUDE.md`'s `EventCanvas.tsx` line still says "2D front canvas for pausing dots").
- The auto-publisher poll caps auto fire at 10/s per publisher regardless of `publishSpeed`
  (see plan Phase B); the F numbers assume that cap.
- Harness scripts in `scripts/perf/.out/` cannot live in the session scratchpad: `playwright-core`
  resolves only from the repo's `node_modules`.

## History

- 2026-11-05: plan written after the Phase 3 worker gate; `F` scale built; Phase A steps 1 and
  the occupancy fast path done and measured (table above); worker ack watchdog fixed.
- 2026-11-05: Phase A finished (1c, 2, 3 + exact 1d–1f) and gated: `F` 20 pubs 103 → 47.2 ms/tick,
  136k → 170k consumed/s; S/M/L/U/W within noise of `wbase`; dragsmoke both modes clean; manual
  checks A–D pass; unit test 4/4; tsc clean; lint 23/3.
- 2026-11-05: Phase A2 done and gated: front canvas in WebGL; `F` 20 pubs main thread 31.6 →
  59.8 fps, `drawImage` gone from the profile (was 72%), 13.9 → 17.8 ticks/s, 170k → 184k
  consumed/s; S/M/L/U/W within noise of `wbase`; pausecheck/canvascheck pass in GL and 2D;
  dragsmoke both modes clean; manual checks A–D pass; tsc clean; lint 23/3.
