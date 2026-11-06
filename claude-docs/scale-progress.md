# Scale plan — session handoff

Handoff between sessions executing `scale-plan.md` (the late-game "TIE fighter" at 20 publishers).
Same protocol as `worker-refactor-progress.md`: read this first, do the phase under **Next**, pass
its gate, rewrite this file.

## Next

**Phase F: fork where routes diverge (real DMR relay accounting)**, exactly as in the plan, with
`CLUSTER_THROUGHPUT_MULTIPLIER` 1.25 → 1.4 in the same commit and balance decision 3 below decided
with it (ask the user before changing the capped-primary fork rule; with bundles it reads: a bundle
whose events were all refused at `centerP` skips its forks, a partly admitted one spawns forks with
the admitted count). Gate F per the plan: S, M, L, U, W consumed/dropped/earned per second unchanged
vs `d2` (no cap binds there; no bridges at U/L/M); F at default caps shows DMR1 recording 2 relays
per event and each bridged cluster 4 (add `brokerRelayCounts` to the `behavior.mjs` output); F with
`FTHROUGHPUT=300` within noise of `d2` on consumed/s (`d2`, `d2-10`, `d2-2`); dragsmoke both modes;
`manualcheck.mjs` (section D is the known flake, see Findings); the headless manual check shows one
dot per cable leaving each cluster after a click; tsc; lint 23/3. Commit: "sim: fork events where
routes diverge (DMR relay accounting)". Phase E (flow mode) stays unscheduled: F 20 runs at 58.9
ticks/s with 6.0 ms ticks, within 0.2% of production.

Phase D's deviations from the plan's letter (11 floats instead of 10; the sim writes two
canvas-only fields per advanced dot) are listed under Findings; nothing there needs a decision.
The bridge watchdog gap is fixed (user decision 2026-11-05, "use your lean": the post-ack
timeout); it is its own commit, see State of the tree.

## State of the tree

- Phase D committed as `a2e6bef` ("extrapolate dots between ticks", on top of `ba2b4ae`; Phase C is
  `6309fbf`). Uncommitted on top of it: the bridge watchdog fix, `src/sim/simBridge.ts` only
  (`WORKER_ACKED_STALL_MS` 10 s; `ready()` also fails over when the in-flight input was acked but
  no tick has landed for max(10 s, 3 × the previous tick's `tickMs`); the fallback message says
  which timeout tripped), plus this file. Suggested message: "bridge: fall back when an
  acknowledged tick never returns". The user commits.
- Position buffer (`positions.ts`): `FLOATS_PER_DOT` 8 → **11**: `[x, y, extent, r, g, b, a,
  glow, vx, vy, tmax]`. `vx, vy` is the dot's velocity in world units per ms along its current
  segment; `tmax` is for how many ms that velocity holds. `fillPositions` derives them from two
  fields the sim writes on every traveling dot it advances in place (`EventDot.progressPerMs`,
  `EventDot.speedUntilP`, required fields, set `0`/`1` at every creation site so dot objects keep
  one shape) plus the path geometry: `pathPos` now also yields the segment direction, the progress
  at the next real corner (walking through collinear waypoints, where the segment scale keeps the
  pixel speed constant) and the world distance to it. `tmax = min(distance to the corner, distance
  to speedUntilP) / |v|`. Queued, pausing, dropped entries and dots before their path start carry
  zeros.
- `sim.ts` Pass 1, at the in-place advance (`dot.progress = newProgress`): computes the speed the
  **next** tick will use from the new progress (segment scale, slow/fast zone multipliers; the same
  expressions as the speed block) and `speedUntilP` = the first slow/fast zone edge after it
  (`nextZoneEdge`, new helper) or, if sooner, the capture point of `nextInteractable` (`centerP −
  0.01` with `nextNodeId`, else `touchStart`). Nothing in the sim reads either field; no rule
  changed (gate numbers below).
- `simBridge.ts`: `getTickTiming()` → `{ arrivedAt, intervalMs }` (performance.now() of the latest
  tick's arrival and the interval before it, capped at `MAX_FRAME_DT_MS`); `window.__sim` gains
  `floatsPerDot` and `tickTiming()`.
- `EventCanvas.tsx`: `lead = min(now − arrivedAt, intervalMs)` per frame (0 before the first tick),
  published as `window.__eventCanvasLeadMs`; the vertex shader has `a_vel`, `a_tmax`, `u_lead` and
  places the point at `a_pos + a_vel · min(u_lead, a_tmax)`; the 2D fallback does the same per
  entry. Both canvases get the lead (pausing entries have zero velocity anyway).
- Harness: `.out/interpcheck.mjs` (new; gitignored scratch like the other checks): starter layout,
  `setMaxTicksPerSec(--ticks, default 15)`, one `fireEvent`, then per frame the tick counter, the
  buffer's first live entry (x, vx), the canvas lead and the x-centroid of the back canvas's
  pixels; reports same-tick frame pairs that moved, tick-boundary jumps, backward jumps (worst)
  and PASS/FAIL (`--ticks=0` is uncapped and reports n/a). `canvascheck.mjs`, `pausecheck.mjs`,
  `pausediag.mjs` read the stride from `window.__sim.floatsPerDot`. README updated.
- Labels in `.out/`: `d0` (same-session pre-D baseline: S, M, L, U, W, F 20 / `d0-10` / `d0-2`,
  F at `FTHROUGHPUT=300`), `d1` (first D build, superseded), `d2` (final: same set). Earlier:
  `c0`, `c1`, `c1cap`, `b2`, `wbase`… (see git history of this file).
- Lint 23/3, tsc clean, `node --test src/sim/__tests__/release.test.ts` 4/4, all touched tracked
  files CRLF. Preview server stopped.

## Measured — Gate D (headless, worker mode, 15 s windows, per **sim** second; `d0` → `d2`)

`lost` was 0 (no clamped inputs) in every run of both labels. Production: U 14,400/s; F 20 pubs
192,000, 10 pubs 96,000, 2 pubs 19,200.

| scale | fps | ticks/s | ms/tick | consumed | dropped | earned | dots | pausing dots |
|---|---|---|---|---|---|---|---|---|
| S | 60.1 → 59.9 | 59.7 → 58.7 | 2.46 → 2.96 | 8.2 → 8.2 | 174.3 → 175.6 | 3,239 → 3,339 | 445 → 444 | 3 → 3 |
| M | 60 → 60.1 | 60.2 → 60.1 | 0.38 → 0.45 | 1,438.7 → 1,442.1 | 0 | 744.5k → 746.4k | 463 → 461 | 14 → 12 |
| L | 60 → 60 | 60.3 → 59.4 | 0.69 → 0.82 | 4,318.8 → 4,316.4 | 0 | 3.1005M → 3.0987M | 922 → 920 | 26 → 23 |
| U | 60 → 60 | 60.3 → 60.1 | 1.03 → 1.26 | 14,394 → 14,406 | 0 | 10.333M → 10.342M | 1,780 → 1,820 | 59 → 46 |
| W | 60 → 60 | 60.1 → 60.1 | 0.42 → 0.48 | 1 → 1 | 9.0 → 9.0 | 30 → 30 | 33 → 33 | 1 → 1 |
| F 20 | 60.1 → 60.1 | 59.8 → 58.9 | 5.16 → 5.96 | 192,299 → 191,950 | 0 | 187.82M → 187.47M | 18,367 → 18,359 | 599 → 546 |
| F 10 | 60 → 60 | 60.5 → 60.1 | 2.88 → 3.40 | 95,969 → 95,984 | 0 | 69.70M → 69.71M | 9,154 → 9,066 | 298 → 243 |
| F 2 | 60 → 60 | 60.4 → 60.2 | 0.75 → 0.90 | 19,208 → 19,215 | 0 | 10.10M → 10.11M | 1,802 → 1,775 | 62 → 30 |

Against `wbase` (per wall second): S 8.2/175.88/3,244.6 → 8.2/175.7/3,340.9 (earned ±3% is this
scale's run noise, as in every earlier gate); M 1,440.3/0/745,474 → 1,442.3/0/746,472; L
4,323.4/0/3.104M → 4,318.1/0/3.100M; U 13,682/0/9.82M → 14,413/0/10.35M (the clamp loss `wbase`
had); W 1/9.06/29.97 → 1/8.99/29.98. Against `c1`: F 20 191,986 → 191,950 (−0.0%). Events per
scale unchanged (U 8,980 → …, F 20 110,199 → 110,152).

Tick cost of the velocity floats (the one thing that moved): ms/tick +15–22% at every scale. At
F 20 the sections are setup 0.67 → 0.56, pass1 2.51 → 2.76 (+0.25 ms over 18.4k dots: the
next-speed block at the advance, ~14 ns per dot), index/pass2/pass3/sigs unchanged, and the fill
(ms/tick minus the sections) 1.18 → 1.83 ms (+0.65 ms, ~35 ns per dot: the collinear walk, two
square roots and the point at `speedUntilP`). Ticks/s stayed 58.9–60.1 everywhere; nothing is
frame-bound by it on this machine. `d1` (the first D build, where the two fields were added to
dot objects after creation) had U pass1 0.36 → 0.80 ms and fps 56–57 at S/M/L/U; setting the
fields at creation (one object shape) brought pass1 back to 0.50 and fps to 60.

interpcheck (starter layout, one dot, `--ticks=15`, final build): worker/WebGL 62 same-tick frame
pairs, 60 moved (97%), mean +5.5 px per frame, tick-boundary jumps mean +9.3 px, backward jumps 0
(worst 0.00 px), max lead 69.5 ms; inline/WebGL 65 pairs, 63 moved (97%), 0 backward; worker/2D
62 pairs, 61 moved (98%), 0 backward; `--ticks=30` 41/41 moved, 0 backward; `--ticks=0` n/a (a
fresh tick every frame, lead ≤ 15.4 ms). The frames that did not move are the dot waiting at a
real corner (the starter route's vertical jog at x ≈ 383.5) for the rest of the tick, by design
(see Findings). Before the per-entry cap the same check showed one backward jump of −10.7 px at the
webhook's slow-zone edge; before the velocity was evaluated at the post-move progress, the dot
froze for a whole tick at that edge instead.

dragsmoke M: worker 444 traveling, 0 off-path, 0 dangling, 1,442 consumed/s; inline 448, 0/0,
1,444; no errors. `manualcheck.mjs`: A (click-to-fire 1 dot `count` 1, 2 fires, webhook border
animates, win freeze/resume, prestige reset + post-prestige consume), A2 (bundle 1 dot `count` 3
and per-dot 3 × 1, 9 consumed each), B ("!" button, subscriber-busy reason, 45 drops), C (broker
bar 100%, prune 19 → 0) pass with no errors; D (kill the worker → inline): before the watchdog
fix it did **not** fall back in any of three suite runs on the D build (mode stayed `worker` for
8 s) while the pre-D build fell back 2/2 in the suite (3.05 s) and `dcheck.mjs 10` on the D build
10/10, `dcheck2.mjs` 4/7 — the pre-existing watchdog gap, see Findings. After the fix: manualcheck
D falls back at 10.05 s ("tick acknowledged but not returned for 10017 ms") and consumes 15 in the
3 s after; dcheck2 7/7 (3 × 3.0 s for kills that landed before the ack, 4 × 10.0 s for kills that
landed between `busy` and `tick`); dragsmoke both modes clean on the fixed build (worker 444
traveling, 0/0, 1,443/s; inline 444, 0/0, 1,442/s). manualcheck's and dcheck2's poll limits were
raised from 8 / 6 s to 14 s so they outlast the 10 s timeout. canvascheck: GL M/W and 2D
M/W draw from the 11-float buffer with no errors (W front canvas 74 / 50 pixels; M 0 is the known
layout quirk). pausecheck: the pausing dot shrinks 6.5 → 3.96 extent with front pixels 90 → 36
(WebGL) and 6.5 → 3.92, 68 → 26 (2D); no errors. tsc clean, lint 23/3, release test 4/4.

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
6. **Bundle gate (Phase C)** — **decided 2026-11-05: keep.** Bundles are emitted only where exact
   (routes without a webhook, ending at 0 ms subscribers). Lifting the gate would make a batch at
   a timed subscriber consume `count` events per consume duration and pass a webhook as one event;
   both are mid-game balance changes, so the gate stands until the user decides otherwise.
7. **Partial broker relay (Phase C)** — **decided 2026-11-05: keep.** Partial admits exactly the
   events the per-dot compare admitted (head passes, tail drops); whole-bundle drop would under-fill
   the cap window by up to `count − 1` per crossing.

## Findings

- **Phase D deviates from the plan's letter in two ways, both render-side, neither a rule
  change.** (1) The plan says "`FLOATS_PER_DOT` 8 → 10" and a cap "at one tick interval"; the
  build has 11 floats with a per-entry cap `tmax`. Measured reason: with velocity alone, a dot
  whose speed changes inside the lead (entering the webhook's slow zone, ×0.4) was drawn 10.7 px
  past where the next tick put it and jumped back (interpcheck, first build); the same happens at
  every corner (orthogonal routes turn every hop) and at every queue/subscriber arrival, by up to
  `v · lead` (7 px at 60 ticks/s for the starter dot, 28 px at 15). With `tmax` the extrapolation
  stops where the sim will change the motion and the dot waits there until the tick lands: a stall
  of at most one tick at corners and edges, never a backward jump (0 in every interpcheck run).
  (2) The plan says "nothing in the sim changes"; the sim now writes two canvas-only fields per
  advanced dot (`progressPerMs`, `speedUntilP`) because the zone multipliers and the capture point
  live in the route profile (`PathInfo`), which `positions.ts` cannot see without a dependency on
  `sim.ts` (which imports `positions.ts`). Recomputing zones render-side would duplicate the
  profile. The fields are evaluated at the dot's **new** progress (what the next tick starts from):
  the pre-move speed was stale by a tick at every corner and zone edge (the dot froze for a tick at
  the webhook edge with the right cap but the wrong velocity). Cost: +15–22% ms/tick (table).
- **Dot objects must keep one shape.** Adding the two fields after creation (first build) made
  pass1 2.2× slower at U (0.36 → 0.80 ms) and cost 3 fps at S/M/L/U: every `dot.x` access in the
  hot loop went polymorphic (dots with and without the fields). Every creation site now sets them
  (`publish.ts` `dotFor`, fork spawn and its dropped remainder, both queue-release spreads, the DMQ
  retry); the type makes them required so tsc flags a new site. Any future per-dot field must do
  the same.
- **The lead cap is the last tick interval, not the next.** `intervalMs` is the gap between the
  two latest arrivals; an irregular tick (a merged input followed by a short one) caps the lead
  short and the dot waits. Visible in interpcheck as an occasional +1.5 px frame. A stalled sim
  (tab hidden, worker wedged, win screen) stops the dots after one interval; while the win screen
  is open they sit up to one frame ahead of their sim position, invisible.
- **Headless lead values are an artefact of the probe.** In interpcheck the lead at the tick's
  frame reads 0.2–1 ms because the probe's `getImageData` on a 1600×900 canvas keeps the main
  thread busy until just before the next frame, so the worker's reply is handled right before the
  canvas draws. In a real browser at 60 ticks/s the lead is ~16 ms minus the round trip (7–15 ms),
  which is exactly what the extrapolation is for; at 15 ticks/s the probe and the browser agree
  (lead up to ~70 ms, dots advancing ~5.5 px per frame between ticks).
- **manualcheck D (kill the worker → inline) failed 3/3 on the D build and passed 2/2 on the
  pre-D build in the same session.** It is the watchdog gap below, not a Phase D bug: the new
  `.out/dcheck2.mjs` (manualcheck's exact timing plus the bridge counters at the kill) shows the
  wedge signature on every failure — `framesSentAfterKill` 0 and `framesBusyAfterKill` = every
  frame — i.e. the kill landed after the worker's `busy` ack and before its `tick`, where
  `ready()` never trips; every success shows 1–4 frames sent unacked and the fallback at 3.05 s.
  On the D build dcheck2 wedged 1/4 at WAIT=3000 and 2/3 at WAIT=1000 while `dcheck.mjs 10` (no
  tutorial dismissal, 2.5 s) fell back 10/10. The outcome depends on where the kill task lands in
  the frame cycle, which for a fixed delay after load is nearly phase-locked per build (same work
  per frame), so one build reads 0/3 and another 2/2 by accident; the exposed window is the
  worker's tick + reply time per frame (~3–4 ms of 16.7 at S, ~20%). Nothing in the bridge's flow
  control changed in Phase D. Fixed the same day, see the next item.
- **Bridge watchdog gap — fixed 2026-11-05 (user: "use your lean")**: `ready()` in
  `src/sim/simBridge.ts` tripped the 3 s stall watchdog only while the in-flight input was
  unacknowledged, so a worker that died after `busy` and before `tick` wedged the sim. Now an
  acked input with no tick for max(`WORKER_ACKED_STALL_MS` = 10 s, 3 × the previous tick's
  `tickMs`) also fails over. The heartbeat alternative was not viable: a tick is one synchronous
  call, the worker cannot post anything while it runs. The 10 s floor is far above any tick seen
  since Phase A (F 20 is 6 ms); a legitimately longer tick scales it by 3× its predecessor. One
  observation from dcheck2: kills that land right after an input went out are still acked (the
  terminate is not instant), so the 10 s path is what catches them.
- **Future option, user request 2026-11-05: render bundles as distinct dots again** (plan, end of
  Phase C). Render-side only; Phase D's velocity floats apply per entry unchanged. Not scheduled.
- Earlier findings that still hold: Phase C's plan gap (bundles gated to routes where they are
  exact; the occupied-webhook rule and the timed consume are per dot), partial relay vs the plan's
  whole-bundle drop (decision 7), DMQ catch `min(free, count)` / release one event, dot ids no
  longer unique per event, signature cap display-identical, B2's `autoPubPollSimTime`, F 10 at
  100% of production, compare per sim second against a same-session baseline (`d0` here), S at
  `--ticks=10` reports a few `inputsClamped` by design, machine load corrupts capped runs silently
  (`inputsClamped` was 0 in every `d0`/`d2` run; `d1` had 1 at U and 56–57 fps, partly the shape
  issue above), WebGL contexts cannot share a buffer, `canvascheck` M reports 0 front pixels,
  same-tick releases do not always ascend, `avgQueued` 6–8 at W, `CLAUDE.md` does not list
  `src/sim/*` yet (worker-refactor Phase 4 pending; it should also say the store never sees dots,
  that a dot carries `count`, and that per-dot fields are set at creation), harness scripts in
  `scripts/perf/.out/` cannot live in the session scratchpad, the Bash tool cuts commands over
  ~8 KB (edit with a CRLF-preserving Node script).

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
  flat at U and F; S −10% at 15 ticks/s (timed-subscriber quantization) and four more non-flat
  rules listed as open decisions, none changed; S/M/L/U/W vs `wbase` within noise; dragsmoke both
  modes clean; manual checks A–D pass; tsc; lint 23/3.
- 2026-11-05: Phase B2 done (user decisions 1 (i) and 5): auto-publisher poll anchored to the
  poll's nominal sim time, drop fall in px/ms over dt. F 10 unthrottled 91.8k → 96.1k consumed per
  sim second; S/M/L/U/W vs `b0` and `wbase` within noise; F 20 191.3k per sim second; dragsmoke
  both modes clean; manual checks A–C pass, D 8/10 (bridge watchdog gap found, not fixed); tsc;
  lint 23/3.
- 2026-11-05: Phase C done (bundles, gated to routes where it is exact; partial broker relay; DMQ
  catch/release per event): F 20 pubs 22.7 → 59.9 ticks/s, 36.3 → 5.2 ms/tick, 193.0k → 192.0k
  consumed per sim second, live dots 120.9k → 18.3k (110k events); F 10 / F 2 within noise; S/M/
  L/U/W vs `wbase` and `b2` within noise with dots ÷ batch size; dragsmoke both modes clean;
  manual checks A–D + new A2 pass; release test 4/4; tsc; lint 23/3.
- 2026-11-05: Phase D done (velocity + per-entry lead cap in an 11-float position buffer; canvas
  extrapolates between ticks): interpcheck at 15 ticks/s shows the drawn dot advancing on 97% of
  same-tick frames with 0 backward jumps in worker/WebGL, inline/WebGL and 2D; S/M/L/U/W and F
  20/10/2 consumed/dropped/earned per sim second within noise of the same-session `d0` (and
  `wbase`, `c1`); ms/tick +15–22% (F 20 5.16 → 5.96) at 58.9–60.1 ticks/s; dragsmoke both modes
  clean; manual checks A–C + A2 pass, D wedged 3/3 on the D build and 0/2 on the pre-D build
  (pre-existing watchdog gap; dcheck2 shows the kill landing between `busy` and `tick`);
  canvascheck/pausecheck both renderers pass; release test 4/4; tsc; lint 23/3.
- 2026-11-05: bridge watchdog gap fixed (user decision, post-ack timeout 10 s / 3× tick):
  manualcheck D falls back at 10.05 s, dcheck2 7/7, dragsmoke both modes clean; tsc; lint 23/3.
