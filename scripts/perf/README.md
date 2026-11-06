# Performance harness

Headless measurements of the game under synthetic heavy meshes, so optimizations can be
compared with numbers instead of feel. Uses `playwright-core` driving a locally cached
Chromium (set `CHROME_PATH` if yours lives elsewhere). Always profile the production build:
dev mode roughly doubles React cost and distorts the picture.

```
npm run perf:build          # unminified prod bundle -> .perf-dist (names preserved for the profiler)
npm run perf:serve          # serves it on http://localhost:5198/Idle-Mesh/  (leave running)

npm run perf:profile -- L   # CPU profile: self/inclusive time by function, real fps, live dots
npm run perf:renders -- L   # React renders/sec per component, store commits/sec, RAF callbacks/frame
npm run perf:trace -- L     # main-thread ms/s by Chrome event (script vs style/layout/paint)
node scripts/perf/dragsmoke.mjs M   # drags a queue + broker mid-flight via the store; dots must stay on their cables, no errors
npm run perf:profile -- U --worker   # CPU profile of the simulation worker thread (raw CDP over --remote-debugging-port)
node scripts/perf/lines.mjs scripts/perf/.out/profile-L.cpuprofile .perf-dist/assets/index-*.js
```

Scales (`prof.mjs` → `CFG`): `S` small (drops into a DMQ), `M` ~950 live dots, `L` ~2800, `XL`
over broker cap, `H` deliberately oversized and flooding, `U` the player-like heavy mesh (~14k
consumed/sec, ~9.5k live dots, no drops; zoomed out via wheel events so the whole mesh is drawn),
`F` the player's late-game "TIE fighter" (`FPUBS=<n>` publishers, default 20, through one DMR
Cluster bridged to two, into 4 shared queues fanning out to 20 shared subscribers; `FTHROUGHPUT=300`
lifts the broker caps the way prestige throughput does, which is what makes the full fan-out flow).
`W` is the early game: one publisher through a real webhook to a level-0 subscriber (exercises the
webhook slow zone and the occupied-webhook drop). The simulation runs in a Web Worker; every script
takes an optional page URL, and `http://localhost:5198/Idle-Mesh/?inlineSim` runs it on the main
thread instead for A/B comparisons (`behavior.mjs` reports `simMode`, `simTicksPerSec`, the worker's
`tickMs`, the post-to-receive `roundTripMs`, and the share of frames whose input went out late or
merged into the next). Dot objects are read through `window.__sim.dots()` / `byStatus()`, which are
asynchronous (a round trip to the worker). `SUBSPEED=10 PUBSPEED=9` env vars use non-maxed
card levels so the per-card cooldown animations are active. `JSFLAGS=--no-turbo-inlining node
scripts/perf/prof.mjs U` attributes time to the real functions inside the loop (V8 otherwise inlines
the whole frame into `loop`); absolute speed is lower with it. `behavior.mjs` output includes `renderer` (`webgl` or `2d`) so you can tell which
`EventCanvas` path was measured.

Caveats: headless Chromium renders with software GL, so canvas cost is overstated and absolute
fps is lower than a real GPU browser. Run one instance at a time. The in-page fps the scripts
report is frames per wall second, not the game's own stat.
