# Worker refactor — session handoff

This file is the handoff between Claude Code sessions executing `worker-refactor-plan.md`.
Each session: read this file first, do exactly the phase named under **Next**, pass its gate,
then rewrite this file for the next session (see "How to hand off"). Keep the history section
short; the plan file holds the design, this file holds only state.

## Next

Phase 3 (the worker: `sim.worker.ts`, bridge with message port + inline fallback, `useSimBridge`,
sim ticks/s stat, harness `--worker` profile). Stop at Gate 3.

## State of the tree

- Phases 0, 1 and 2 are done and the tree is at a commit point (uncommitted; suggested message
  from the plan: "sim: canvas draws from position buffer"). The user commits.
- `src/sim/`: `types.ts`, `meshRules.ts`, `publish.ts`, `sim.ts`, `simBridge.ts`, `simStats.ts`
  as after Phase 1, plus `positions.ts` (Phase 2): `FLOATS_PER_DOT` (8), the draw constants
  `DOT_RADIUS`/`GLOW_RADIUS`/`GLOW_EXTENT`, the `glow` field values `GLOW_DROPPED` (0) /
  `GLOW_LIVE` (1) / `GLOW_PAUSING` (2), and `fillPositions(dots, components, nowMs, buf)`: the
  inline interpolation, queued-dot snap to its queue center, pausing-dot shrink and `parseColor`
  moved verbatim out of `EventCanvas.renderGl`/`drawDot`. `Sim.fillPositions(buf)` delegates to it
  with the sim's dots, `mesh.components` and `lastNowMs` (the clock of the last tick, recorded at
  the top of `tick` before the frozen check). `buf` must hold `getDots().length * 8` floats.
- `simBridge.ts` owns two `Float32Array`s (initial capacity 4096 dots, grown x1.5 when the dot
  count outgrows the free one). `fillPositions()` (called by the loop right after `sim.tick`)
  fills the free buffer and swaps; `getPositions()` returns the same `{ buf, count }` object
  every call. It also exposes `window.__sim` in all builds: `liveDots()`, `byStatus()`, `dots()`
  (the live array), `positions()`, `summary()`.
- `EventCanvas.tsx` draws only from `getPositions()`: the WebGL path uploads the buffer as-is
  (its layout is the vertex layout) and the vertex shader clips `glow > 1.5` (pausing) entries;
  the 2D front canvas scans for `glow === 2` entries; the 2D fallback back canvas draws the rest.
  Entries are in dot order, not grouped by glow. No store import, no `Dot` type.
- `gameStore.ts`: `eventDots` is gone from `GameState`, the initial state, `performPrestige`, the
  save exclusion destructure and `commitFrame`, which now takes only the `TickSummary`.
  `useGameLoop.ts`: tick → `publishSummary` → `fillPositions()` → first-drop tutorial →
  `commitFrame(summary)`.
- Harness scripts read dots through `window.__sim`: `behavior.mjs` (`liveDots`/`byStatus`),
  `prof.mjs`, `renders.mjs`, `trace.mjs` (counts) and `dragsmoke.mjs` (`dots()` for the off-path
  and dangling-path checks). `scripts/perf/.out/manualcheck.mjs` (ignored dir) likewise.
- Harness labels in `scripts/perf/.out/`: `wbase` (Phase 0 baseline), `p1` (Gate 1), `p2`
  (Gate 2). Gate 3 compares to `wbase`. Extra Phase 2 checks in `.out/`: `canvascheck.mjs`
  (`--disable-webgl` 2D fallback + buffer glow counts + canvas alpha-pixel probe) and
  `pausecheck.mjs` (front canvas draws the shrinking pausing dot in the starter layout). Reuse both
  for Gate 3.
- Lint: 23 errors / 3 warnings (`npx eslint src`), down from 24 because the `eventDots: _` entry
  of the save-exclusion destructure (one of the pre-existing no-unused-vars errors on that line)
  was removed with the field. New and changed files lint clean. `npx tsc -b` clean.

## Findings that affect later phases

- Plan gap: two store actions touched dots that the "Store code that touches dots" list missed.
  `removeComponent` filtered dots queued at the removed node (old `gameStore.ts` ~L1187) and
  `performPrestige` cleared `eventDots` and reset the dot id counter (~L1648/L1673). Handled in
  Phase 1 as: `Sim.setMesh` prunes dots whose `queuedAtNodeId` no longer exists whenever the
  component list shrinks (same observable result, next frame); `Sim.reset()` clears dots and
  restarts ids, driven by the loop's subscription on `prestige.count`. Phase 3 must post `reset`
  on the same signal and keep the prune inside the worker's `setMesh`.
- Plan said `fireEvents` had outside callers; it did not (only `fireEvent` → `fireEvents`). It
  was removed with the dead actions. The summary's `publisherIds`/`publishes` are
  auto-publishers only; manual fires are bookkept by the store at click time, so nothing in
  `commitFrame` double-writes a cooldown.
- The sim's clock is `input.nowMs` (`Date.now()` from the driver) everywhere, including the
  broker relay window, drop timestamps and (Phase 2) the pausing shrink in `fillPositions`.
  `simStats.getActiveDrops` re-filters by `Date.now()` at call time, so the 2 s window is unchanged.
- Types moved to `src/sim/types.ts` (not in the plan, but required so `src/sim` imports nothing
  from the store). `GameState['upgrades']`/`['prestige']` are `GlobalUpgrades`/`PrestigeState`.
- Coin pop ids have their own counter in the store (they shared `dotIdCounter`); React keys only.
- U-scale `consumedPerSec` went up ~2–5% over `wbase` in both p1 and p2 with fps 51.9 → 55–58:
  fewer clamped (>100 ms) frames. The consumed-to-earned ratio is identical.
- `behavior.mjs` `avgPausing` dropped wbase → p1 (M 27 → 22, U 363 → 265) and is flat p1 → p2
  (M 22 → 22, U 265 → 293). At these scales `fasterConsumption` makes the consume duration ~0, so
  the count is a one-frame population sampled every 500 ms: sampler-phase noise, with
  consumed/sec identical. Not a regression of either phase.
- `scripts/perf/prof.mjs` `want` regex still names `loop @ src/hooks/useGameLoop`; the frame is
  now `tick @ src/sim/sim.ts`. Update it in Phase 3's harness step.
- Broker utilization is read at `NodeCard` render time (as before), so the bar only refreshes
  when the card re-renders; not a regression, but the headless check must force a re-render.
- `sim.ts` was produced by moving the loop body verbatim (then dedented 2 spaces); the frame
  function is still an IIFE inside `tick` over `this.dots`. `TickSummary.consumed` entries keep
  the dot `id` field (unused by the store).
- `Sim.moveComponent` exists per the interface but the inline driver relies on `setMesh` from
  the subscription (the store replaces `components` every drag frame).
- Phase 2, buffer protocol: pausing entries are not grouped; the GL vertex shader clips them and
  the 2D paths test `glow`. Phase 3's worker fills the same layout right after its tick (same
  `Sim` instance, so `lastNowMs` is that tick's clock) and must size the buffer it holds from its
  own dot count before `fillPositions` (the bridge does this inline today).
- Phase 2, visual-only differences, noted not fixed: (a) the pausing shrink formula moved
  verbatim from the canvas (`2500 ms × 0.95^level`) and does not match the sim's actual consume
  duration (`consumeDurationFor`: `1000 × (1 − min(level(level+9)/2, 100)/100)`); at high
  `fasterConsumption` levels the shrink hits 0 within a frame, so pausing dots are invisible at
  M/L/U exactly as before. (b) While the win screen is open the loop does not tick, so the buffer
  is not refilled and pausing dots freeze behind the overlay instead of shrinking on wall clock.
- Phase 3 harness risk: `dragsmoke.mjs` (off-path/dangling checks) and `manualcheck.mjs`
  (prestige dot ids, queue-prune counts, win-screen progress snapshot) read dot objects
  synchronously via `window.__sim.dots()`. Once the dots live in the worker that is impossible;
  either run those scripts with `?inlineSim` or add a debug round-trip message that returns a dot
  snapshot and make the scripts await it. Decide in Phase 3 step 6.
- `scripts/perf/.out/` still holds older scratch scripts (`dragsmoke.mjs` copy, `forkcheck.mjs`,
  `overlap.mjs`) that read `s.eventDots`; they are not the gate's scripts and were left alone.
- Docs for Phase 4: `CLAUDE.md`'s save-exclusion list and file structure still name `eventDots`
  and describe `EventCanvas` as reading the store; `dev-notes.md` → Performance architecture and
  `event-dot-lifecycle.md` likewise.

## History

- 2026-11-05: plan written, nothing executed.
- 2026-11-05: Phase 0 + Phase 1 done. Gate 1 (`wbase` → `p1`): S 8.2/175.9/3245 →
  8.2/175.5/3389 consumed/dropped/earned per s (earned ±2% is this scale's run noise); M 1440 →
  1442; L 4323 → 4292; U 13682 → 14410 (fps 51.9 → 57.8); W 1/9.06/29.97 → 1/9.06/29.98.
  dragsmoke M: 0 off-path, 0 dangling, no errors. tsc clean, lint 24/3. Headless manual checks
  all pass.
- 2026-11-05: Phase 2 done. Gate 2 (`wbase` → `p2`): S 8.2/175.9/3245 → 8.2/174.2/3308; M
  1440.3/0/745474 → 1440.5/0/745455; L 4323/0/3.104M → 4319/0/3.101M; U 13682/0/9.82M →
  13993/0/10.05M (fps 51.9 → 55); W 1/9.06/29.97 → 1/9.06/29.98. dragsmoke M: 904 traveling,
  0 off-path, 0 dangling, no errors. tsc clean, lint 23/3 (see State). Headless manual checks all
  pass; M screenshots look identical; 2D fallback (`--disable-webgl`) draws from the buffer with
  no errors; starter-layout pausing dot shrinks on the front canvas (extent 6.5 → 4.0 over the pause).

## How to hand off (do this at the end of every session, before reporting to the user)

1. Update **Next** to the next phase and its gate (or "Done" after Phase 4).
2. Update **State of the tree**: what exists now, the harness labels recorded so far, the lint
   count, and whether the tree is at a commit point (the user commits; never commit yourself).
3. Add to **Findings** anything the next session must know that is not in the plan.
4. Add one line to **History** with the date, the phase done, and the key gate numbers.
5. Tell the user the tree is ready to commit and that the next session should use the same
   kickoff prompt (it reads this file).
