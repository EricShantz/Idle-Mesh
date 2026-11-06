# Scale plan — session handoff

Handoff between sessions executing `scale-plan.md` (the late-game "TIE fighter" at 20 publishers).
Same protocol as `worker-refactor-progress.md`: read this first, do the phase under **Next**, pass
its gate, rewrite this file.

## Next

**Phase D: render-side interpolation**, exactly as in the plan: `fillPositions` writes two more
floats per dot (velocity in world units per ms along the path's current segment; `FLOATS_PER_DOT`
8 → 10, the GL vertex layout and the 2D paths follow); `EventCanvas` extrapolates
`x + vx·(now − tickNowMs)` capped at one tick interval, from the bridge's arrival time of the
latest summary; pausing and dropped entries do not move. Nothing in the sim changes. Gate D is
visual: a headless check at `--ticks=15` shows canvas positions advancing between ticks (write it
as `scripts/perf/.out/interpcheck.mjs`: sample `window.__sim.positions()` and the drawn buffer at
RAF rate while the sim is capped, and show entries move between two ticks), plus S, M, L, U, W vs
`wbase` within noise (sim untouched), F with `FTHROUGHPUT=300` within noise of `c1`, dragsmoke
both modes, `manualcheck.mjs`, tsc, lint 23/3. Commit: "canvas: extrapolate dots between ticks".
Then Phase F (fork where routes diverge; throughput multiplier 1.25 → 1.4 in the same commit;
balance decision 3 below decided with it).

Phase C's two new rules are decided (user, 2026-11-05): the bundle gate stays and the partial
broker relay stays (decisions 6 and 7 below).

## State of the tree

- Phase C done, uncommitted, on top of commit `1a96e0a` ("auto-publisher poll and drop fall
  independent of tick timing"). One commit, message from the plan: "sim: batch fires travel as
  one dot". Files: `src/sim/types.ts`, `src/sim/meshRules.ts`, `src/sim/publish.ts`,
  `src/sim/sim.ts`, `src/sim/positions.ts`, `src/sim/simBridge.ts`, `src/sim/sim.worker.ts`,
  `src/store/gameStore.ts`, `scripts/perf/behavior.mjs`, `scripts/perf/compare.mjs`,
  `scripts/perf/README.md`, this file, the plan's status line. The user commits.
- `EventDot.count` (required, `src/sim/types.ts`): the events a dot stands for. `buildPublishDots`
  (`publish.ts`) emits one dot per plan entry with `count = fireCount` when the plan's `bundle`
  flag is set, else `fireCount` dots of count 1 at the old `-0.04` progress stagger. The flag is
  computed once per mesh change by `routesBundleExact`: every route of the fire (primary and
  forks) crosses no webhook and ends at a 0 ms subscriber or at a queue whose connected
  subscribers are all 0 ms (`consumeDurationFor` moved to `meshRules.ts` for it). Why gated: see
  Findings. `publishes[].count` stays `fireCount`.
- `sim.ts` rules by count: `tryBrokerRelay(…, count)` returns the admitted number (`room =
  ceil(cap − ts.length)`, which admits exactly what the per-event `ts.length < cap` compare did,
  fractional caps included) and pushes that many timestamps; a partly admitted bundle continues
  with the admitted count and the rest drops as its own falling dot (new id); 0 admitted = the
  old capped `continue`. Forks spawn with the bundle's count and take that many slots, same
  partial rule. Queue gate `backlog + count ≤ bufferSize` (backlog in events). DMQ catch takes
  `min(free, count)` events and the remainder falls on (new id). DMQ release (Pass 3) releases
  ONE event per 500 ms: a queued bundle emits a count-1 retry (new id) and keeps the rest. Every
  drop adds `count`; the consume entry is `{ id, value, subscriberId, count }` (`applyConsumes` in
  the store multiplies `value` by it and adds it to `eventsConsumed` / `recentEarnings.count`;
  coin-pop tracking stays per consumed dot). Slot signatures repeat the char `count` times, cut to
  the card's capacity (`3 + bufferSize + prestige bonus`, DMQ `3 + dmqBufferSize`) from the start,
  which is what the card drew of a longer string anyway. `TickSummary.liveEvents`; `byStatusOf`
  (now exported from `sim.ts`, used by the bridge and the worker) reports `<status>` dots and
  `<status>Events`; `window.__sim.liveEvents()`.
- `positions.ts`: extent × `1 + 0.15·log2(count)` for live, pausing (before the shrink) and
  dropped entries; the GL sprite and the 2D stamp scale with the extent, so a bundle is one
  fuller dot (×1.39 at 6).
- Harness: `behavior.mjs` reports `avgLiveEvents`/`maxLiveEvents`/`avgQueuedEvents`/
  `avgPausingEvents` next to the dot numbers; `compare.mjs` also prints `tickMs`,
  `droppedPerSimSec` and the event keys. README updated. Scratch (gitignored
  `scripts/perf/.out/`): `manualcheck.mjs` section A reads `count`/`liveEvents`; new section A2
  (S layout with `batchFire` 3, auto-publish off, subscribers at 11 then 8: one click → 1 dot
  `count` 3 / 3 dots `count` 1, 9 consumed either way); `flowdiag.mjs` sums `count`
  (`consumedDotsPerSimSec` added). `dcheck.mjs`, `pausecheck.mjs`, `canvascheck.mjs` unchanged.
- Labels in `.out/`: `c0` (same-session pre-C baseline: F 20 / `c0-10` / `c0-2`, all
  `FTHROUGHPUT=300`), `c1` (S, M, L, U, W, F 20 / `c1-10` / `c1-2`), `c1cap` (F 20 at default
  caps, compare with `bcap0`). Earlier: `b2`, `b0`, `b15`…, `wbase` (see git history of this file).
- Lint 23/3, tsc clean, `node --test src/sim/__tests__/release.test.ts` 4/4, all touched tracked
  files CRLF. Preview server stopped.

## Measured — Gate C (headless, worker mode, 15 s windows, per **sim** second)

`lost` is clamped inputs (sim ms discarded); `dots`/`events` are average live. Production: U
14,400/s; F 20 pubs 192,000, 10 pubs 96,000, 2 pubs 19,200.

| scale | ticks/s | ms/tick | lost | consumed | dropped | earned | dots | events | pausing dots/events |
|---|---|---|---|---|---|---|---|---|---|
| S | 60.0 | 2.21 | 0 | 8.2 | 174.6 | 3,337 | 443 | 443 | 3 / 3 |
| M | 60.2 | 0.42 | 0 | 1,442 | 0 | 746,338 | 460 | 921 | 11 / 22 |
| L | 59.9 | 0.74 | 0 | 4,320 | 0 | 3.101M | 925 | 2,774 | 22 / 65 |
| U | 60.0 | 0.98 | 0 | 14,400 | 0 | 10.338M | 1,793 | 8,966 | 54 / 272 |
| W | 60.2 | 0.38 | 0 | 1 | 9.0 | 30.00 | 32 | 32 | 1 / 1 |
| F 20 | **59.9** | **5.17** | 0 | 191,986 | 0 | 187.51M | 18,328 | 109,969 | 586 / 3,514 |
| F 10 | 60.1 | 2.89 | 0 | 96,078 | 0 | 69.77M | 9,127 | 54,762 | 286 / 1,717 |
| F 2 | 60.0 | 0.70 | 0 | 19,176 | 0 | 10.08M | 1,797 | 10,782 | 58 / 350 |
| F 20 default caps | 60.3 | 2.02 | 0 | 8,180 | 9,187 | 7.19M | 4,726 | 28,276 | 13 / 76 |

Same-session baseline `c0` (pre-C build): F 20 22.7 ticks/s, 36.3 ms/tick, 192,991 consumed,
188.47M earned, 120,894 live dots (sections: setup 4.17, pass1 16.67, pass2 4.78, pass3 2.33,
sigs 1.13 ms); F 10 47.3 ticks/s, 15.8 ms, 95,727; F 2 56.2 ticks/s, 4.6 ms, 19,189. After C the
F 20 sections are setup 0.76, pass1 2.46, index 0.02, pass2 0.45, pass3 0.22, sigs 0.11, publish
0.01 ms. Against `b2` (per sim second): S 8.2/175.0/3,331 → 8.2/174.6/3,337; M 1,440 → 1,442;
L 4,320 → 4,320; U 14,399.5 → 14,400.1; W 1/9.0/30 → 1/9.0/30; F 20 191,273 → 191,986 (+0.4%;
vs `c0` −0.5%); F 10 96,127 → 96,078; F 2 19,192 → 19,176. Against `wbase` (per wall second):
S 8.2/175.88/3,244.6 → 8.2/174.67/3,338.0; M 1,440.3/0/745,474 → 1,441.1/0/745,796; L
4,323.4/0/3.104M → 4,319.5/0/3.101M; U 13,682/0/9.82M → 14,392/0/10.33M (the clamp loss `wbase`
had); W 1/9.06/29.97 → 1/8.99/29.98. Dots per scale fell by the batch size (M ×2, L ×3, U ×5,
F ×6) with events unchanged. F 20 at default caps vs `bcap0` (58 ticks/s): consumed 8,122 →
8,180, dropped 8,972 → 9,187, earned 7.41M → 7.19M (value per consumed event 913 → 879, see
Findings).

dragsmoke M: worker 452 traveling, 0 off-path, 0 dangling, 1,439 consumed/s; inline 454, 0/0,
1,441; no errors. `manualcheck.mjs`: A (click-to-fire 1 dot, `count` 1, `liveEvents` 1; 2 fires;
webhook border animates; win freeze/resume; prestige reset and post-prestige consume), A2
(bundled: 1 dot `count` 3, `recentPublishes.count` 3, 9 consumed, 0 dropped; timed: 3 dots
`count` 1, 9 consumed), B ("!" button, subscriber-busy reason, 45 drops), C (broker bar 100%,
queue prune 19 → 0), D (`killWorker()` → inline at 3,023 ms, consumption resumes) all pass; D is
still the 8/10 flake described in Findings when it fails. tsc clean, lint 23/3, release test 4/4.

## Open balance decisions (from Phase B; user decision 2026-11-05 unless stated)

1. **Auto-publisher poll** — done as (i) in Phase B2 (10/s cap stays). Option (ii) remains open.
2. **Timed-subscriber release quantization** — deferred (known, small): S 8.2 → 7.5 → 7.4
   consumed per sim second at 60 / 15 / 10 ticks/s. Flat form: release early by `slack`.
3. **Capped primary skips its forks** — decide with Phase F. With bundles the rule is: a bundle
   whose events were all refused at `centerP` skips its forks (as before); a partly admitted one
   spawns forks with the admitted count.
4. **Cap arbitration is array order within a tick** — deferred. Phase C adds to it: under a
   binding cap a bundle takes its slots at one instant instead of over the batch's 0.04-progress
   stagger (~200 ms), so which publishers' events fill the window differs; at F 20 default caps
   the value per consumed event moved 913 → 879 (−3.8%) with consumed flat at the cap. Invisible
   where the cap does not bind (S/M/L/U/W, F at `FTHROUGHPUT=300`). Flat form unchanged: admit
   by crossing time inside the tick.
5. **Dropped-dot fall was per tick** — done in Phase B2.
6. **Bundle gate (Phase C)** — **decided 2026-11-05: keep.** Bundles are emitted only where exact (routes without a
   webhook, ending at 0 ms subscribers; see Findings). Lifting the gate would make a batch at a
   timed subscriber consume `count` events per consume duration (×`count` income at a saturated
   level-<11 subscriber) and pass a webhook as one event (today the occupied-webhook rule drops
   the trailing dots of a batch). Both are mid-game balance changes; the plan's non-goals say the
   mid game stays, so the gate stands until the user decides otherwise.
7. **Partial broker relay (Phase C)** — **decided 2026-11-05: keep.** The plan said "drop the whole bundle" when
   `ts.length + count > cap` and asked for a note if partial is preferred: partial is what was
   done, because it admits exactly the events the per-dot compare admitted (head passes, tail
   drops). Whole-bundle drop would under-fill the cap window by up to `count − 1` per crossing.

## Findings

- **Plan gap (Phase C step 1 is not exact-equivalent as written):** `scale-plan.md` → Phase C
  "`buildPublishDots` emits one dot per plan entry with `count = fireCount`" unconditionally, but
  two rules are per dot, not per event: (a) the occupied-webhook rule (`sim.ts` Pass 1,
  `isComponentOccupied` on the approach zone) — a batch through a webhook today loses every dot
  after the first; (b) the subscriber consume (Pass 1 pausing branch: `elapsed >= consumeDuration`
  once per dot; the Pass 2 release index assumes one event per `consumeDuration` per arrival) — a
  bundle at a timed subscriber would consume `count` events in one duration. Neither is covered
  by the gate's scales (S and W have batch 1; M/L/U/F subscribers are 0 ms). The gate in
  `publish.ts` → `routesBundleExact` keeps both regimes per-dot; in the late game the plan aims
  at (everything maxed, no webhook) every fire bundles, which the F numbers show. An in-flight
  bundle that meets a timed subscriber because the mesh changed after the fire (a new level-0
  subscriber wired to a queue while bundles are queued; ≤ a second of dots) consumes as one; the
  next fires are per-dot again (the plan cache keys on `connections`/`components` identity).
- **Plan claim corrected:** the plan's "drop the whole bundle, same as today's per-dot ordering
  would drop the tail" is not the same thing: per-dot ordering passes the head and drops the
  tail. Decision 7 above.
- **DMQ with bundles:** without the partial catch a 6-event bundle could never enter a DMQ of
  fewer than 6 free slots (the late-game default: 3 + level), and without the split release the
  DMQ would release 6 events per 500 ms instead of 1; both are exact now (catch `min(free,
  count)`, release one event). Not in the gate's scales (S has batch 1; the F DMQ at
  `FTHROUGHPUT=300` sees no drops); covered by reading the code, not by a measurement.
- **Dot ids are no longer unique per event:** a partly relayed bundle, an uncaught DMQ remainder
  and a DMQ retry out of a bundle each get a fresh `nextDotId()`; the dot that keeps the old id
  is the continuing/queued one. Prestige still restarts at `dot-1` (manualcheck A).
- **F 20 pubs ticks at 59.9/s with 5.2 ms ticks, frame-bound now.** Dots 120.9k → 18.3k (events
  110k); the pausing-dot count fell from 9.8k to 586 dots (3.5k events) because ticks are short
  (one-tick pausing wait). Per sim second: 193.0k → 192.0k (−0.5%, production 192k). The
  remaining tick is pass1 2.5 ms over ~18k dots plus setup 0.8 ms (the per-tick component maps
  and backlog pass); the worker is idle most of each frame, so Phase D (render interpolation)
  is cosmetic for this mesh on this machine and matters on slower ones. Phase E (flow mode) is
  not needed by the plan's definition of done (≥ 50 ticks/s, within 5% of production: met).
- **Future option, user request 2026-11-05: render bundles as distinct dots again** (plan, end of
  Phase C). Render-side only, `fillPositions` emitting `count` entries spread behind the bundle at
  the old −0.04 stagger; gate it by a live-event budget or zoom level since the buffer returns to
  per-event size. Not scheduled; do not do it inside another phase.
- **Signature cap is display-identical**: `NodeCard.renderSlotRows` indexes `signature[capacity −
  1 − i]` when the string is longer than the capacity, i.e. it draws the first `capacity` chars;
  the sim now cuts the string to that prefix, so the card draws the same rows and the string
  crossing the worker boundary is bounded.
- **Bridge watchdog gap (pre-existing, from B2; needs a user decision)**: `ready()` in
  `src/sim/simBridge.ts` trips the 3 s stall watchdog only while the in-flight input is
  unacknowledged. A worker that dies after `busy` and before `tick` wedges the sim with no
  fallback (`dcheck.mjs 10`: 2/10 kills at S). Fix options: a longer post-ack timeout
  (max(10 s, 3× recent `tickMs`)) or a worker heartbeat during long ticks. Manualcheck D is 8/10
  until decided (it passed this session).
- Earlier findings that still hold: B2's `autoPubPollSimTime` (exact-multiple poll time); F 10 at
  100.1% of production since B2; F 20's unthrottled tick rate varies between sessions (compare
  per sim second against the same-session `c0`/`c1`, not `b0`); S at `--ticks=10` reports a few
  `inputsClamped` by design; machine load corrupts capped runs silently (check `inputsClamped` =
  0 at S/M/L/U/W — it was 0 for every `c1` run); WebGL contexts cannot share a buffer (A2);
  `canvascheck` M reports 0 front pixels (layout quirk); same-tick releases do not always ascend
  (A step 3); GC 8% of the worker at 20 pubs before C (not re-profiled: the tick is 5 ms);
  `avgQueued` 6–8 at W is pre-existing; `CLAUDE.md` does not list `src/sim/*` yet
  (worker-refactor Phase 4 pending; it should also say the store never sees dots and that a dot
  carries `count`); harness scripts in `scripts/perf/.out/` cannot live in the session
  scratchpad; the Bash tool cuts commands over ~8 KB (use the Write/Edit tools, then `unix2dos`).

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
- 2026-11-05: Phase C done (bundles, gated to routes where it is exact; partial broker relay; DMQ
  catch/release per event): F 20 pubs 22.7 → 59.9 ticks/s, 36.3 → 5.2 ms/tick, 193.0k → 192.0k
  consumed per sim second, live dots 120.9k → 18.3k (110k events); F 10 / F 2 within noise; S/M/
  L/U/W vs `wbase` and `b2` within noise with dots ÷ batch size; F default caps consumed flat,
  value per event −3.8% (arbitration); dragsmoke both modes clean; manual checks A–D + new A2
  pass; release test 4/4; tsc; lint 23/3.
