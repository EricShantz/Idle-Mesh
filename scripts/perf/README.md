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
node scripts/perf/lines.mjs scripts/perf/.out/profile-L.cpuprofile .perf-dist/assets/index-*.js
```

Scales (`prof.mjs` → `CFG`): `S` small, `M` ~950 live dots, `L` ~1650, `XL` ~2500 (frame clamp
kicks in), `H` deliberately oversized. `SUBSPEED=10 PUBSPEED=9` env vars use non-maxed card
levels so the per-card cooldown animations are active.

Caveats: headless Chromium renders with software GL, so canvas cost is overstated and absolute
fps is lower than a real GPU browser. Run one instance at a time. The in-page fps the scripts
report is frames per wall second, not the game's own stat.
