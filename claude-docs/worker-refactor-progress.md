# Worker refactor — session handoff

This file is the handoff between Claude Code sessions executing `worker-refactor-plan.md`.
Each session: read this file first, do exactly the phase named under **Next**, pass its gate,
then rewrite this file for the next session (see "How to hand off"). Keep the history section
short; the plan file holds the design, this file holds only state.

## Next

**Done.** Phases 0–4 are complete (2026-11-05). Nothing in `worker-refactor-plan.md` is left to
execute; later work on the simulation (the late-game scaling plan) is tracked in `scale-progress.md`.

## State of the tree

- Phases 0–3 were committed by the user (`6d35c8d` canvas draws from position buffer, `ea078c2` /
  `40fd51c` run the simulation in a Web Worker); the scale plan's phases followed on top. Phase 4
  (docs, 2026-11-05, no code): `CLAUDE.md` (file structure with `src/sim/*` and `useSimBridge.ts`,
  the save-exclusion list without `eventDots`, a "Simulation architecture" convention, the two
  rate stats, the gate commands), `dev-notes.md` (stale `useGameLoop.ts` / `getMinFps` /
  `fireEvent` references fixed; "Round 4 — worker" and "Round 5 — the late game" appended),
  `event-dot-lifecycle.md` (rewritten around `Sim.tick` and the dot's `count`),
  `component-types.md`, `roadmap.md`, the plan's status line and this file. Uncommitted; the
  user commits (see `scale-progress.md` → State of the tree).
- `src/sim/`: `types.ts`, `meshRules.ts`, `publish.ts`, `sim.ts`, `positions.ts`, `simStats.ts` as
  after Phase 2, plus:
  - `protocol.ts` (type-only): `MainToWorker` = `mesh` | `move` | `input` (with the transferred
    position `ArrayBuffer`) | `reset` | `debug` (`dots` / `byStatus`, with an id);
    `WorkerToMain` = `tick` (summary, buffer, count, `tickMs`) | `debug` (id, result).
  - `sim.worker.ts`: one `Sim`; ticks every `input` as it arrives (no worker-side coalescing,
    see Findings), grows the buffer it holds when the dot count outgrows it, fills it right
    after the tick and transfers it back. `self` is typed through a local slice of
    `DedicatedWorkerGlobalScope` because tsconfig uses the DOM lib.
  - `simBridge.ts` (rewritten): a `Driver` interface with two implementations. The worker driver
    posts messages, tracks one in-flight input, and fails over through `onFail` on construction
    error, `worker.onerror`, or a 3 s stall (`WORKER_STALL_MS`, checked from `ready()`); the
    inline driver is Phase 2's. `fallbackInline` disposes the worker, makes an inline `Sim`,
    replays the last mesh snapshot and recreates the lost buffer. `?inlineSim` in the URL picks
    inline from the start. Exports: `start(onSummary, onIdle)` (idempotent), `stop()`,
    `setMesh`, `moveComponent`, `reset`, `canTick`, `tick(input, late)`, `noteBusyFrame`,
    `getPositions`, `latestSummary`, `getSimTicksPerSec` (EMA of tick-arrival intervals),
    `getMode`, `queueManualFire`/`takeManualFires`.
- `src/hooks/useSimBridge.ts` (renamed from `useGameLoop.ts`, `git mv`): the RAF driver. Flow
  control: at most one input in flight and at most one per frame; a frame that finds the worker
  busy sends from the bridge's idle callback the moment the tick lands; if the next frame comes
  first, the frame deltas accumulate into one input (the sim clamps it as it clamped a long frame).
  The hook uses `useLayoutEffect` so its RAF registers before `EventCanvas`'s passive one (input
  goes out at the top of the frame). Store subscription: `prestige.count` change → `reset`; a drag
  frame where only the dragged card changed (`onlyMovedCard`, reference compare per index) →
  `move`; any other change of the four mesh fields → full `mesh` snapshot. While `showWinScreen`
  no input is sent and no frame time accumulates (as before). The fps stat
  (`getSmoothedFps`/`getMinFps`) is unchanged and still lives here; imports in `gameStore.ts`,
  `Sidebar.tsx`, `WinScreen.tsx`, `App.tsx` updated.
- `Sidebar.tsx`: the "Frame rate" row is gone (user request after Gate 3: it no longer says
  anything about game speed); "Sim rate N ticks/s" replaces it (gray ≥ 50, amber ≥ 10, red below,
  tooltip says the sim dilates below 10). `WinScreen` shows "Lowest sim rate" from
  `getMinSimTicksPerSec` (simBridge) instead of the lowest fps; `getMinFps` was removed.
  `getSmoothedFps` stays in `useSimBridge.ts` for the coin-pop throttle only.
- `window.__sim` (all builds): `mode()`, `liveDots()` (latest summary), `byStatus()` and `dots()`
  (**Promises**: a round trip to the worker), `positions()`, `summary()`, `ticksPerSec()`,
  `stats()` (cumulative: ticks, tickMsTotal, roundTripMsTotal, framesSent, framesBusy,
  inputsLate), `killWorker()` (terminates the worker behind the bridge's back; the watchdog must
  fall back).
- Harness: `behavior.mjs` reports `simTicksPerSec`, `tickMs`, `roundTripMs`, `lateInputPct`,
  `mergedFramePct`, `simMode`; `dragsmoke.mjs` takes an optional URL and awaits `dots()`;
  `trace.mjs` awaits `dots()`; `prof.mjs` has `--worker` (profiles the worker thread over a raw
  CDP WebSocket on `--remote-debugging-port=9333`; Playwright's `CDPSession` cannot reach worker
  targets), the `want` regex names `tick`/`fillPositions`/`onmessage`/`receiveTick`/`commitFrame`
  by function name only, and the sample reports `simTicksPerSec`/`simMode`. README updated.
  `scripts/perf/.out/manualcheck.mjs` awaits `dots()` and has a new section D (kill the worker →
  inline fallback). `canvascheck.mjs`/`pausecheck.mjs` unchanged (they read `positions()`).
- Build: Vite emits `assets/sim.worker-<hash>.js` (88 kB unminified; no React, zustand or store
  code in it) next to the main bundle; verified in the preview build under `/Idle-Mesh/`. Not
  verified on the deployed GitHub Pages site (user's check).
- Harness labels in `scripts/perf/.out/`: `wbase` (Phase 0), `p1`, `p2`, `p3` (Gate 3, worker),
  `p3inline` (U and W with `?inlineSim`). Scratch labels from the diagnosis (`p3diag*`, `p3late*`,
  `p3lay*`, `p3b/c`) can be deleted. Profiles: `prof-U-worker.txt`, `prof-U-p3-main.txt`,
  `profile-U-worker.cpuprofile`.
- Lint: 23 errors / 3 warnings (`npx eslint src`), unchanged from Phase 2. `npx tsc -b` clean.
  All changed files CRLF.

## Findings that affect later phases

- **Flow control deviates from the plan's worker-side coalescing.** The plan has the worker
  coalesce queued inputs; with at most one input in flight that never happens, so the bridge
  accumulates frame deltas instead and the worker ticks each input immediately. Equivalent
  result (summed dt, clamped by the sim; manual fires drained into whichever input goes out).
- **U in headless: ticks/s ≈ pre-worker fps, not above it.** Final: render 59.9 fps, 54.2 ticks/s
  (wbase fps 51.9, p2 55). Worker tick 7–9.5 ms at 60 Hz (vs ~5 ms inline and ~5 ms in the
  uncapped profile: per-tick work grows with dt — publishes and node crossings per tick — not GC,
  which is 1.8%), round trip ~9 ms; ~16% of frames send late and ~9% merge into the next because
  the reply is handled only after the main thread's own frame work. Run-to-run variance of
  ticks/s is about ±3 (49.1–55 across seven U runs). The plan's "ticks/s ≥ 55 at U" is therefore
  met only sometimes in headless; on a real GPU browser the main thread has far less to do per
  frame. Possible later step (not done, would be a cadence change): decouple ticks from frames.
- **Consumed/sec at U correlates with ticks/s even above 10 ticks/s** (~+250 consumed/s per
  tick/s across wbase/p1/p2/p3 and the U re-runs: 49.9 ticks → 13.0k, 54 → 14.0k, 57.8 → 14.4k).
  Cause not established: the earlier guess "some rule is per-tick" is unproven (queue releases are
  timing-based, not one-per-tick); long ticks losing sim time to the 100 ms clamp is the other
  candidate. `scale-plan.md` Phase B measures it. For this gate it means "ticks/s within noise of
  the baseline fps".
- **Inline re-entry bug caught by `dragsmoke.mjs` with `?inlineSim`** (fixed): inline,
  `bridge.tick` runs the tick and the idle callback synchronously, so the frame's "waiting" flag
  must be cleared before the call. Run dragsmoke in both modes after any driver change.
- `SimInput.frozen` is never sent `true`: the driver skips the tick entirely while the win screen
  is open (Phase 2 behavior, no commits while frozen); pausing dots still freeze behind the overlay
  (Phase 2 visual finding (b) unchanged). Phase 4 may document it or leave it as interface.
- The `move` message is used only for pure drag frames; a structured-clone `mesh` snapshot goes
  out for everything else (175 components + 169 connections at U; not measurable in the numbers).
- `Sim.moveComponent` and `setMesh` run inside the worker, so the queue-prune on removal and the
  prestige reset (`prestige.count` → `reset`) work as in Phase 1.
- `scripts/perf/.out/` still holds older scratch scripts (`dragsmoke.mjs` copy, `forkcheck.mjs`,
  `overlap.mjs`) that read `s.eventDots`; not the gate's scripts, left alone.
- The frame-rate row in the Sidebar never had a tooltip (the plan assumed one); the Sim rate row
  has one.
- Post-gate fix: the stall watchdog originally waited for the **tick**; on the player's 20-publisher
  mesh (`scale-plan.md`) one tick exceeded 3 s, the bridge declared the worker dead and fell back
  inline mid-run. The worker now posts `busy` the moment it picks up an input and the watchdog
  trips only when that ack is missing. `manualcheck.mjs` section D (terminate the worker) still
  exercises the fallback.
- Typing: transferring buffers needs `Float32Array<ArrayBuffer>` (TS 5.7+ generic typed arrays);
  `new Float32Array(n)` and `new Float32Array(arrayBuffer)` give that, bare `Float32Array` does not.
- `prof.mjs`'s profile keys are `fn @ assets/index-<hash>.js:line` in the perf build, so the old
  `src/...` regex entries never matched; they are kept for dev-mode runs.
- Phase 4 resolved the stale docs (`eventDots` / `useGameLoop.ts` / `getMinFps` no longer appear
  outside the two plan files and the Round 1–3 history, where they are marked "then … now").
  `SimInput.frozen` stays as interface and is documented as never sent `true` (`dev-notes.md` →
  End Game).

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
- 2026-11-05: Phase 3 done. Gate 3 (`wbase` → `p3`, worker mode): S 8.2/175.88/3244.6 →
  8.2/175.34/3251.3 (fps 59.7 → 60, 59.8 ticks/s); M 1440.3/0/745474 → 1440/0/745266 (60 fps,
  59.9 ticks/s); L 4323.4/0/3.104M → 4316.9/0/3.099M (fps 58.8 → 60, 60.1 ticks/s); U
  13682/0/9.82M → 14198/0/10.19M (fps 51.9 → 59.9, 54.2 ticks/s, tick 7.7 ms, round trip 9.3 ms,
  15.9% late, 8.7% merged); W 1/9.06/29.97 → 1/9.07/30 (60 fps, 59.8 ticks/s). `?inlineSim` U:
  56.1 fps, 55.4 ticks/s, 14350/0/10.30M, tick 5.0 ms (Phase-2 numbers). dragsmoke M worker: 906
  traveling, 0 off-path, 0 dangling, no errors; inline: 908, 0, 0, no errors. Manual checks A–D
  pass in worker mode (click-to-fire, webhook border, win freeze/resume, prestige reset + post-
  prestige run consumes, drop reasons, broker bar, queue prune 19 → 0, `killWorker()` → inline
  after 3.03 s with consumption resuming, no reload). 2D fallback M/W no errors; starter pausing
  dot 6.5 → 4.04. Worker profile (uncapped RAF): worker 62% busy at ~120 ticks/s, GC 1.8%; main
  thread: browser internals 67%, JS 26.5% (EventCanvas render 6.3%, message handling 1.5%,
  commitFrame + applyConsumes 0.7%). tsc clean, lint 23/3.
- 2026-11-05: Phase 4 done (docs only): `CLAUDE.md`, `dev-notes.md` (Rounds 4–5), `event-dot-lifecycle.md`,
  `component-types.md`, `roadmap.md`, the plan's status line, this file, `scale-progress.md`. No
  `src/` change, so no harness run; tsc clean, lint 23/3.

## How to hand off (do this at the end of every session, before reporting to the user)

1. Update **Next** to the next phase and its gate (or "Done" after Phase 4).
2. Update **State of the tree**: what exists now, the harness labels recorded so far, the lint
   count, and whether the tree is at a commit point (the user commits; never commit yourself).
3. Add to **Findings** anything the next session must know that is not in the plan.
4. Add one line to **History** with the date, the phase done, and the key gate numbers.
5. Tell the user the tree is ready to commit and that the next session should use the same
   kickoff prompt (it reads this file).
