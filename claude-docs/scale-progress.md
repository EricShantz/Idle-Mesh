# Scale plan — session handoff

Handoff between sessions executing `scale-plan.md` (the late-game "TIE fighter" at 20 publishers).
Same protocol as `worker-refactor-progress.md`: read this first, do the phase under **Next**, pass
its gate, rewrite this file.

## Next

**Phase C: bundles, one dot per batch**, exactly as in the plan: `EventDot.count` (default 1);
`buildPublishDots` emits one dot per plan entry with `count = fireCount` (`publishes[].count` stays
`fireCount`); every counting rule by count (broker relay takes `count` slots with the cap check
`ts.length + count > cap` dropping the whole bundle, queue and DMQ buffer gates
`queuedCount + count ≤ bufferSize`, `applyConsumes` gets `{ value, subscriberId, count }` and adds
`count` to `eventsConsumed`/`recentEarnings`, drop counting adds `count`, the slot signature repeats
its character `count` times, `liveDots`/`byStatus` report events and dots); the extent in the
position buffer scales by `1 + 0.15·log2(count)`; `behavior.mjs` reports both dots and events.
Gate C: S, M, L, U, W consumed/dropped/earned per second vs `wbase` within noise (events, not
dots); `F` with `FTHROUGHPUT=300` ≥ 50 ticks/s, compared **per sim second** with `b2` (191.3k at
22.5 ticks/s; production 192k) and `inputsClamped` checked; `FPUBS=10` / `FPUBS=2` per sim second
within noise of `b2-10` / `b2-2`; dragsmoke both modes; `manualcheck.mjs` (click-to-fire must show
one bundle dot per click with the right `count`: extend section A to read `count`; section D is
flaky for a reason unrelated to the sim, see Findings — rerun it or use `dcheck.mjs`); tsc; lint
23/3. Commit: "sim: batch fires travel as one dot". Phase D (render interpolation) follows, then
Phase F (fork where routes diverge, user decision 2026-11-05, with the throughput multiplier
1.25 → 1.4 in the same commit; balance decision 3 below is decided with it).

## State of the tree

- Phase B2 done, uncommitted, on top of commit `c14bad6` ("tick-rate cap and income per sim
  second"). One commit, message from the plan: "sim: auto-publisher poll and drop fall independent
  of tick timing". Files: `src/sim/sim.ts`, `src/sim/types.ts` (a doc comment), this file. The user
  commits.
- `src/sim/sim.ts` auto-publisher poll (~line 1885): a new field `autoPubPollSimTime` advances by
  `AUTO_PUB_POLL_MS` per poll and is the poll's nominal sim time (`simNow − autoPubAccumulator`
  kept as an exact multiple of 100, so the compare never fails on floating point); the cooldown
  check is `pollTime − last ≥ cooldown` and `last` is stamped with `pollTime`. Consecutive polls are
  exactly 100 ms apart in sim time whatever the tick pattern. Cooldowns > 100 ms fire every
  ⌈cooldown/100⌉ polls (exactly now; before, a 200 ms cooldown could slip to every third poll on
  jitter). The 10/s cap stays (user decision 1 (i)).
- `src/sim/sim.ts` dropped-dot fall (Pass 1, ~line 1260): `vy += 0.001125·dt; y += vy·dt` in px/ms,
  identical to the old per-tick form at 60 Hz (0.3125 px/tick per tick), ∝ dt instead of ∝ 1/dt
  below it. `EventDot.dropVY` is documented as px per ms.
- Harness unchanged since `c14bad6` (`--ticks`, per-sim-second numbers, `inputsClamped`). Scratch
  (gitignored `scripts/perf/.out/`): `flowdiag.mjs`, `manualcheck.mjs`, `pausecheck.mjs`,
  `canvascheck.mjs` unchanged; new `dcheck.mjs <n>` repeats manualcheck section D n times (kill the
  worker on the S layout, count fallbacks).
- Labels in `.out/`: `b2` (S, M, L, U, W, F 20 pubs `FTHROUGHPUT=300`), `b2-15` / `b2-10t` (S at
  `--ticks=15` / `10`), `b2-10` / `b2-2` (`FPUBS=10` / `2`, `FTHROUGHPUT=300`). Earlier: `b0`
  (Phase B baseline, same set), `b15` (S/M/L/W, F 20), `b30` / `b60` (U), `b0-10` / `b30-10` /
  `b15-10`, `b60-2` / `b30-2` / `b15-2`, `bcap0/30/15` (F 20 with default caps), `wbase` (Phase 0,
  no per-sim-second keys).
- Lint 23/3, tsc clean, all touched tracked files CRLF. Preview server stopped.

## Measured — Gate B2 (headless, worker mode, 15 s windows, per **sim** second)

`cap` is `--ticks`; `lost` is clamped inputs (sim ms discarded); `wall` is consumed per wall
second. Production: U 14,400/s; F 20 pubs 192,000, 10 pubs 96,000, 2 pubs 19,200.

| scale | cap | ticks/s | ms/tick | sim s | lost | consumed | wall | dropped | earned | live | pausing |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S | – | 60.1 | 2.06 | 15.00 | 0 | 8.2 | 8.2 | 175.0 | 3,331 | 443 | 3 |
| S | 15 | 15.0 | 2.16 | 15.00 | 0 | 7.5 | 7.5 | 150.6 | 3,183 | 424 | 3 |
| S | 10 | 10.0 | 2.24 | 15.00 | 40 (4) | 7.4 | 7.4 | 147.0 | 3,083 | 431 | 3 |
| M | – | 60.2 | 0.66 | 15.00 | 0 | 1,440 | 1,439 | 0 | 745,207 | 928 | 23 |
| L | – | 60.9 | 4.54 | 15.02 | 0 | 4,320 | 4,321 | 0 | 3.101M | 2,831 | 82 |
| U | – | 59.9 | 3.48 | 15.02 | 0 | 14,400 | 14,406 | 0 | 10.337M | 8,972 | 243 |
| W | – | 60.2 | 0.43 | 15.00 | 0 | 1 | 1 | 9.0 | 30.00 | 32 | 1 |
| F 20 | – | 22.5 | 36.7 | 15.00 | 4 (17) | 191,273 | 191,164 | 0 | 186.81M | 120,460 | 9,333 |
| F 10 | – | 46.8 | 15.6 | 14.82 | 1 (200) | 96,127 | 94,878 | 0 | 69.81M | 56,412 | 2,422 |
| F 2 | – | 58.0 | 4.3 | 14.77 | 3 (250) | 19,192 | 18,878 | 0 | 10.09M | 11,052 | 324 |

Against `b0` (per sim second): S 8.2/174.88/3338.9 → 8.2/175.0/3330.8; M 1438.9 → 1439.9; L
4323.8 → 4320; U 14,414.8 → 14,399.5; W 1/8.93/30 → 1/9.0/30; F 20 190,725 → 191,273 (+0.3%);
F 2 (`b60-2`) 19,037 → 19,192 (+0.8%); F 10 (`b0-10`) 91,760 → **96,127 (+4.8%, now 100.1% of
production)**: the fire loss was the gap. Against `wbase` (per wall second): S 8.2/175.88/3244.6 →
8.2/174.89/3328.7; M 1440.3/0/745,474 → 1438.7/0/744,611; L 4323.4/0/3.104M → 4321.3/0/3.102M; U
13,682/0/9.82M → 14,406/0/10.34M (the clamp loss `wbase` had at 51.9 fps, see Findings); W
1/9.06/29.97 → 1/8.99/29.98. S at 15 ticks/s vs `b15`: 7.4/149.5/3,065 → 7.5/150.6/3,183.

Flow accounting (`flowdiag.mjs F --ticks=20`, `FPUBS=10 FTHROUGHPUT=300 WINDOW=30000`): 19.1
ticks/s, `pollsDue` 297 = `pollsFired` 297, `rejected` empty, **9.99 fires per publisher per sim
second** (was 9.66 with 9 rejected polls), 600 events fired/s, consumed 96,034 per sim second =
100.04% of fired × 160. The gate's "≥ 9.95" and "pollsFired = pollsDue ± 1" both hold.

dragsmoke M: worker 902 traveling 0 off-path 0 dangling 1,442 consumed/s; inline 890, 0/0, 1,441;
no errors. `manualcheck.mjs` run three times: A–C pass every time in worker mode (A: click-to-fire
1 dot per click, 2 for two clicks, webhook border animates, win freeze/resume, prestige reset and
post-prestige consume; B: "!" button with the subscriber-busy reason, 45 drops; C: broker bar
moving, queue prune 19 → 0); D (`killWorker()` → inline) passed twice at 3,060 ms with consumption
resuming and failed once (mode stayed `worker` for 8 s, 0 frames sent after the kill);
`dcheck.mjs 10` reproduced it 2/10 — the bridge watchdog gap in Findings, not the sim. tsc clean,
lint 23/3.

## Open balance decisions (from Phase B; user decision 2026-11-05)

1. **Auto-publisher poll** — **done as (i) in Phase B2**: the 10/s cap stays (one fire per
   publisher per 100 ms poll even though `publishSpeed` 10 promises 50 ms); fires on irregular
   ticks are no longer lost. Option (ii) (per-tick cooldown with catch-up, `publishSpeed` meaning
   what it says, auto income ×2 at level 10) remains open for the user.
2. **Timed-subscriber release quantization** (Pass 2, `shouldReleaseTo` / `canAcceptArrival`) —
   **deferred** (known, small): a candidate rejected this tick is re-checked next tick, so a
   saturated timed subscriber idles up to one tick per consume. S (320 ms consume): 8.2 → 7.5 → 7.4
   consumed per sim second at 60 / 15 / 10 ticks/s (after B2; was 7.4 at 15). Only timed
   subscribers (early/mid game; maxed ones are 0 ms and flat). Flat form: when the chain rejects
   only because the candidate would arrive `slack` ms early, release it now with its start pushed
   back by `slack × progressPerMs`.
3. **Capped primary skips its forks** (Pass 1: the broker cap check at `centerP` runs before the
   fork spawn at `touchStart`; a capped primary `continue`s) — **decide with Phase F**. F 20 pubs
   default caps: dropped per sim second 8,972 → 4,333 → 2,532 at 58 / 30 / 15 ticks/s, consumed
   flat at the cap. Income-neutral while the cap binds; the drop counter, "!" reasons and DMQ
   catching see up to 72% fewer drops. Phase F's design makes this deliberate for bridged copies.
4. **Cap arbitration is array order within a tick** — **deferred** (known, small): under a binding
   cap the publishers earlier in the component list take a long tick's remaining slots; average
   value per consumed event 914 → 883 (−3.5%) at 57 → 15 ticks/s at F 20 pubs default caps. Flat
   form: admit by crossing time inside the tick.
5. **Dropped-dot fall was per tick** — **done in Phase B2** (dt-proper, identical at 60 Hz). The
   DMQ now catches at any tick rate: S consumed 7.4 at 10 ticks/s, where the old fall (~900 px at
   15 ticks/s, less below) never reached S's DMQ 672 px below the drop point.

Rules measured flat (no decision needed): the poll accumulator (10 polls per sim second at any
dt), the broker 1 s window, the queue buffer gate (previous-tick backlog), the DMQ 500 ms
wall-clock rule, the release stagger and the one-tick pausing wait (latency only), W's webhook
rules. The 100 ms clamp is the designed dilation below 10 ticks/s.

## Findings

- **Bridge watchdog gap (pre-existing, not B2; needs a user decision)**: `ready()` in
  `src/sim/simBridge.ts` lines 210–214 trips the 3 s stall watchdog only while the in-flight input
  is **unacknowledged** (`!acked`). If the worker dies after posting `busy` and before posting
  `tick` (the post-gate change that stopped the watchdog from killing the player's 3 s ticks), the
  bridge waits forever: `ready()` is false, no new input goes out, the sim is wedged with no
  fallback. `dcheck.mjs 10`: 2/10 kills at S land in that window (a ~2 ms tick inside a 16.7 ms
  frame). `worker.onerror` covers a script error, so in production only an externally terminated
  worker (browser OOM kill, DevTools) hits it. Possible fix: a second, longer post-ack timeout
  (e.g. max(10 s, 3× the recent `tickMs`)) or a worker-side heartbeat during long ticks; either is
  a bridge behaviour change, so decide it explicitly. Until then, treat manualcheck D as 8/10.
- **Plan formula vs implementation (B2 step a)**: the plan's `pollTime = simNow −
  autoPubAccumulator` is mathematically `100·n` but, computed from two drifting doubles, is not
  exactly so; `pollTime − last` could then come out at 99.999… and reject a cooldown of exactly
  100 ms (reachable through the prestige `pubRate` multiplier). `autoPubPollSimTime` holds the same
  nominal value as an exact integer multiple instead. Same value, no floating-point hazard.
- **F 10 publishers at 100.1% of production** after B2 (three earlier sessions sat at 94–96%):
  the lost fires on irregular ticks were the whole gap; the pipeline-fill effect noted before is
  within the window's noise.
- **F 20 pubs unthrottled ran at 22.5 ticks/s (36.7 ms tick) vs 17.5 (46.6 ms) in `b0`.** Nothing
  in B2 changes tick cost (no drops at F; the poll change is a few arithmetic ops); per sim second
  the income is +0.3%. Treat it as machine variance between sessions (the section times fell
  uniformly: pass1 16.8 ms, pass2 4.8, setup 4.5); fewer pausing dots (9.3k vs 11.9k) follows
  from the shorter tick. Phase C's gate compares per sim second, so this does not matter, but do
  not read a Phase C tick-rate gain against `b0`; compare against `b2`.
- **S at `--ticks=10` reports `inputsClamped` 40 with `clampLostMs` 4**: at a 10 cap every input
  is ~100 ms and a few land a fraction over; the loss is 4 ms in 15 s. Not a corrupted run (the
  rule "discard runs with `inputsClamped` > 0" is for uncapped S/M/L/U/W).
- Earlier findings that still hold: the `wbase` → worker U gain (+5.3%) is the clamp loss `wbase`
  had at 51.9 fps, not a per-tick rule (U is 14,400 per sim second at 60/58/30/15 ticks/s); a tick
  cap at F 20 pubs does not land where it is set (feedback through pausing dots); machine load
  corrupts capped runs silently (check `inputsClamped` = 0 at S/M/L/U/W); the plan's "run U and F
  at 60, 30, 15" is unreachable at F 20 pubs (worker-bound), so `FPUBS=2` / `FPUBS=10` cover 60 and
  30; WebGL contexts cannot share a buffer (A2); `canvascheck` M reports 0 front pixels (layout
  quirk); same-tick releases do not always ascend (A step 3); harness `tickMs` is ~8 ms above the
  section sum at 20 pubs; GC 8% of the worker at 20 pubs; `avgQueued` 6–8 at W is pre-existing;
  `CLAUDE.md` does not list `src/sim/*` yet (worker-refactor Phase 4 pending; `EventCanvas.tsx`
  line still says "2D front canvas"); harness scripts in `scripts/perf/.out/` cannot live in the
  session scratchpad; the Bash tool cuts commands over ~8 KB (write long files with the Write
  tool, then `unix2dos`).

## History

- 2026-11-05: plan written after the Phase 3 worker gate; `F` scale built; Phase A steps 1 and
  the occupancy fast path done and measured; worker ack watchdog fixed.
- 2026-11-05: Phase A finished (1c, 2, 3 + exact 1d–1f) and gated: `F` 20 pubs 103 → 47.2 ms/tick,
  136k → 170k consumed/s; S/M/L/U/W within noise of `wbase`; dragsmoke both modes clean; manual
  checks A–D pass; unit test 4/4; tsc clean; lint 23/3.
- 2026-11-05: Phase A2 done and gated: front canvas in WebGL; `F` 20 pubs main thread 31.6 →
  59.8 fps, `drawImage` gone from the profile, 13.9 → 17.8 ticks/s, 170k → 184k consumed/s;
  S/M/L/U/W within noise; pausecheck/canvascheck pass; dragsmoke both modes clean; tsc; lint 23/3.
- 2026-11-05: Phase B done: `--ticks` cap + per-sim-second harness numbers; income per sim second
  flat at U (14,415/14,399/14,403/14,400 at 60/58/30/15 ticks/s) and F (190.7k/189.8k/192.3k at
  17.5/12/10.3; 10 and 2 pubs likewise), M/L/W flat; S −10% at 15 ticks/s (timed-subscriber
  quantization) and four more non-flat rules listed as open decisions, none changed; S/M/L/U/W vs
  `wbase` within noise; dragsmoke both modes clean; manual checks A–D pass; tsc; lint 23/3.
- 2026-11-05: Phase B2 done (user decisions 1 (i) and 5): auto-publisher poll anchored to the
  poll's nominal sim time, drop fall in px/ms over dt. F 10 pubs capped 20: 9.66 → 9.99 fires per
  publisher per sim second, 297/297 polls fired; F 10 unthrottled 91.8k → 96.1k consumed per sim
  second (100.1% of production); S at 15 ticks/s 7.4 → 7.5, at 10 still 7.4 (DMQ catches);
  S/M/L/U/W vs `b0` and `wbase` within noise; F 20 191.3k per sim second (+0.3%); dragsmoke both
  modes clean; manual checks A–C pass, D 8/10 (bridge watchdog gap found, not fixed); tsc; lint
  23/3.
