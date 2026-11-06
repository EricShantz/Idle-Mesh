# Scale plan — session handoff

Handoff between sessions executing `scale-plan.md` (the late-game "TIE fighter" at 20 publishers).
Same protocol as `worker-refactor-progress.md`: read this first, do the phase under **Next**, pass
its gate, rewrite this file.

## Next

**Phase B2: the two tick-rate fixes the user chose (2026-11-05), one commit, then Phase C.**
Phase B measured income per **sim** second against the tick rate (table below) and listed the
non-flat rules under **Open balance decisions**; the user decided: do items **1 (skip fix only,
keep the 10/s cap)** and **5 (dt-proper drop fall)** now; defer 2 and 4; fold 3 into Phase F.
Steps: (a) auto-publisher poll in `sim.ts` (~line 1873): after `autoPubAccumulator -= 100`, use the
poll's nominal sim time `pollTime = simNow − autoPubAccumulator` for both the cooldown check
(`pollTime − last ≥ cooldown`) and the stored `last`, so consecutive polls are exactly 100 ms apart
in sim time and no poll is rejected at cooldowns ≤ 100 ms; cooldowns > 100 ms keep firing every
⌈cooldown/100⌉ polls as today. (b) dropped-dot fall in Pass 1 (`dot.status === 'dropped'`):
`vy += 0.001125 · dt; y += vy · dt` (px/ms units; identical to today's numbers at dt = 16.67).
Gate B2: `flowdiag.mjs F --ticks=20` with `FPUBS=10 FTHROUGHPUT=300 WINDOW=30000` shows
`firesPerPubPerSimSec` ≥ 9.95 (was 9.66) and `pollsFired` = `pollsDue` ± 1; S at `--ticks=15` still
catches drops in the DMQ (consumed ≥ 7.4, the `b15` S row) and at 60 the S/M/L/U/W rows match
`b0` within noise (the fall at 60 Hz is unchanged by construction; verify S dropped/consumed);
F 20 pubs `FTHROUGHPUT=300` unthrottled within noise of `b0` per sim second; dragsmoke both modes;
manualcheck; tsc; lint 23/3. Commit: "sim: auto-publisher poll and drop fall independent of tick
timing". Then **Phase C** as in the plan: `EventDot.count`, every counting rule by count, the extent scaled by count, `behavior.mjs`
reporting dots and events. Gate C: S, M, L, U, W consumed/dropped/earned per second vs `wbase`
within noise (events, not dots); `F` with `FTHROUGHPUT=300` ≥ 50 ticks/s — compare **per sim
second** (`consumedPerSimSec`, 190.7k today at 17.5 ticks/s, production 192k) and check
`inputsClamped`; drag smoke clean in both modes; click-to-fire shows one bundle dot per click with
the right `count`. Commit: "sim: batch fires travel as one dot". Phase D (render interpolation)
follows, then Phase F (fork where routes diverge, user decision 2026-11-05, with the throughput
multiplier 1.25 → 1.4 in the same commit).

## State of the tree

- Uncommitted, on top of commit `65f8dce` ("pausing dots in WebGL"). One commit; the plan's
  message "sim: income independent of tick rate" overstates it since no sim rule changed —
  suggested: "harness: tick-rate cap and income per sim second (Phase B audit)". Files:
  `src/sim/simBridge.ts`, `scripts/perf/behavior.mjs`, `scripts/perf/compare.mjs`,
  `scripts/perf/README.md`, `claude-docs/scale-plan.md` (B steps marked), this file. The user commits.
- `src/sim/simBridge.ts`: `setMaxTicksPerSec(n)` / `getMaxTicksPerSec()` (0 = none): `canTick()`
  holds a frame's input back until `1000/n − TICK_CAP_SLACK_MS (5)` ms have passed since the last
  input went out (`lastInputAt`, set in `tick()`), so frame deltas merge into fewer, longer inputs
  exactly as they do when the worker is slow; held frames count as busy in `stats`. The slack makes
  caps that divide 60 land on exact frame multiples (measured 15.0 / 29.7 / 58.1 ticks/s). `stats`
  gained `inputsClamped`, `clampLostMs`, `maxInputDtMs` (inputs over `MAX_FRAME_DT_MS` and the sim
  time the clamp discarded). `window.__sim.setMaxTicksPerSec` / `maxTicksPerSec` exposed.
- `scripts/perf/behavior.mjs`: `--ticks=<n>` (positional args are the non-`--` ones); reports
  `maxTicksPerSec`, `simSeconds` (summary `simNow` delta), `consumedPerSimSec` /
  `droppedPerSimSec` / `earnedPerSimSec`, `inputsClamped`, `clampLostMs`, `maxInputDtMs` (the last
  is cumulative since page load, so ~500 ms from the first input is normal). `compare.mjs` adds
  `simTicksPerSec`, `consumedPerSimSec`, `earnedPerSimSec` and skips keys missing on either side
  (older labels such as `wbase` have none).
- Scratch (gitignored `scripts/perf/.out/`): `flowdiag.mjs <scale> [--ticks=n]` wraps the store's
  `commitFrame` and accounts fires, fired events, consumes and drops per sim second against the
  scale's fan-out (`WINDOW=30000` env for a 30 s window), with the consumed value histogram and a
  poll-schedule check (`pollsDue` is reconstructed from `simNow` and is floating-point sensitive at
  the 100 ms boundaries: trust `firesPerPubPerSimSec`, not the `rejected` list, unless the fire
  count is short too). `manualcheck.mjs`, `pausecheck.mjs`, `canvascheck.mjs` unchanged.
- Labels in `.out/`: `b0` (S, M, L, U, W, and F = 20 pubs `FTHROUGHPUT=300`), `b60` / `b30` /
  `b15-1` / `b15-2` (U), `b15` / `b12` (F 20 pubs), `b0-10` / `b30-10` / `b15-10` (`FPUBS=10`),
  `b60-2` / `b30-2` / `b15-2` (`FPUBS=2`), `b30` / `b15` (S, W), `b15` (M, L), `bcap0` / `bcap30` /
  `bcap15` (F 20 pubs with the **default** caps, `FTHROUGHPUT` unset). All F labels except `bcap*`
  have `FTHROUGHPUT=300`.
- Lint 23/3, tsc clean, all touched tracked files CRLF. Preview server stopped.

## Measured — Gate B flat-income table (headless, worker mode, 15 s windows)

`cap` is `--ticks`; `sim s` is sim time over the 15.0 s wall window; `lost` is clamped inputs
(sim ms discarded). Consumed/dropped/earned are per **sim** second; `wall` is consumed per wall
second. Production: U 14,400/s; F 20 pubs 192,000, 10 pubs 96,000, 2 pubs 19,200.

| scale | cap | ticks/s | ms/tick | sim s | lost | consumed | wall | dropped | earned | live | pausing |
|---|---|---|---|---|---|---|---|---|---|---|---|
| U | – | 60 | 3.65 | 15.02 | 0 | 14,415 | 14,422 | 0 | 10.348M | 8,952 | 238 |
| U | 60 | 58.1 | 3.89 | 15.02 | 0 | 14,399 | 14,408 | 0 | 10.337M | 8,951 | 257 |
| U | 30 | 29.7 | 3.81 | 15.00 | 0 | 14,403 | 14,394 | 0 | 10.339M | 9,338 | 481 |
| U | 15 | 15.0 | 4.66 | 15.00 | 0 | 14,398 | 14,391 | 0 | 10.336M | 9,963 | 966 |
| U | 15 (re-run) | 15.0 | 4.65 | 15.07 | 0 | 14,402 | 14,458 | 0 | 10.339M | 9,977 | 953 |
| F 20 | – | 17.5 | 46.6 | 14.70 | 17 (350) | 190,725 | 186,775 | 0 | 186.25M | 123,993 | 11,915 |
| F 20 | 15 | 12.0 | 62.3 | 14.37 | 27 (717) | 189,796 | 181,683 | 0 | 185.38M | 131,136 | 15,952 |
| F 20 | 12 | 10.3 | 70.2 | 14.05 | 38 (901) | 192,318 | 180,014 | 0 | 187.83M | 135,066 | 17,824 |
| F 10 | – | 39.7 | 20.2 | 14.30 | 4 (750) | 91,760 | 87,430 | 0 | 66.64M | 55,636 | 3,502 |
| F 10 | 30 | 23.1 | 27.3 | 14.30 | 3 (717) | 95,440 | 90,931 | 0 | 69.31M | 58,838 | 4,034 |
| F 10 | 15 | 13.9 | 35.3 | 14.45 | 4 (550) | 94,680 | 91,123 | 0 | 68.76M | 62,424 | 6,821 |
| F 2 | 60 | 54.4 | 5.4 | 14.35 | 4 (667) | 19,037 | 18,200 | 0 | 10.01M | 10,982 | 305 |
| F 2 | 30 | 29.5 | 4.9 | 15.00 | 0 | 19,123 | 19,113 | 0 | 10.06M | 11,578 | 732 |
| F 2 | 15 | 15.0 | 3.9 | 15.02 | 0 | 19,194 | 19,201 | 0 | 10.09M | 12,585 | 1,310 |
| S | – | 59.4 | 2.3 | 15.02 | 0 | 8.2 | 8.2 | 174.87 | 3,339 | 446 | 3 |
| S | 30 | 29.4 | 2.8 | 15.03 | 0 | 8.1 | 8.1 | 160.78 | 3,372 | 436 | 3 |
| S | 15 | 15.0 | 2.6 | 14.98 | 0 | 7.4 | 7.4 | 149.70 | 3,065 | 426 | 3 |
| W | – | 60.1 | 0.4 | 15.00 | 0 | 1 | 1 | 8.93 | 30.00 | 32 | 1 |
| W | 30 | 30.0 | 0.55 | 15.03 | 0 | 1 | 1 | 9.05 | 29.93 | 32 | 1 |
| W | 15 | 15.0 | 0.62 | 15.00 | 0 | 1 | 1 | 9.00 | 30.00 | 31 | 1 |
| M | – | 59.9 | 0.75 | 15.00 | 0 | 1,439 | 1,439 | 0 | 744,682 | 931 | 26 |
| M | 15 | 15.0 | 0.73 | 15.00 | 0 | 1,440 | 1,440 | 0 | 745,270 | 966 | 95 |
| L | – | 60.3 | 5.1 | 15.02 | 0 | 4,324 | 4,325 | 0 | 3.104M | 2,808 | 69 |
| L | 15 | 15.0 | 8.4 | 15.07 | 0 | 4,321 | 4,338 | 0 | 3.102M | 2,950 | 288 |
| F 20 default caps | – | 58.0 | 8.1 | 15.02 | 0 | 8,122 | 8,125 | 8,972 | 7.415M | 28,641 | 222 |
| F 20 default caps | 30 | 29.8 | 10.1 | 15.02 | 0 | 8,136 | 8,140 | 4,333 | 7.592M | 16,502 | 158 |
| F 20 default caps | 15 | 15.0 | 4.1 | 15.07 | 0 | 8,193 | 8,223 | 2,532 | 7.172M | 12,896 | 628 |

Flow accounting (`flowdiag.mjs`, F 10 pubs `FTHROUGHPUT=300`, 30 s windows): consumed ÷ (events
fired × 160) = 100.09% at 47.4 ticks/s, 99.93% at 47.3, 100.11% capped at 20 (19.2 ticks/s), so
nothing is lost in flight; fires per publisher per sim second were 9.95, 9.87 and **9.66** (capped
20: 299 polls due, 290 fired, the 9 rejected polls all landed one 50 ms tick after the previous
poll with all 10 publishers rejected together). F 20 pubs default caps, 12 s: fires 10.03 and
10.00 per publisher per sim second at 57 and 15 ticks/s; average value per consumed event 914.5 vs
882.6; the lowest-tier publisher's 500.85 bucket took 9,917 vs 15,928 of ~97k consumes.

Gate B scales, `wbase` → `b0` (consumed/dropped/earned per wall s): S 8.2/175.88/3244.6 →
8.2/174.88/3338.9 (earned +2.9% at identical consumed, this scale's run noise as at every prior
gate); M 1440.3/0/745474 → 1438.8/0/744607; L 4323.4/0/3.104M → 4325.4/0/3.105M; U 13682/0/9.82M →
14422/0/10.35M (+5.4%, fps 51.9 → 60: explained now, see Findings); W 1/9.06/29.97 →
1/8.93/29.98. dragsmoke M: worker 890 traveling 0 off-path 0 dangling, inline 892 0/0, 1440 /
1444 consumed/s, no errors. Manual checks A–D pass in worker mode (D: inline fallback after
3036 ms, consumption resumes). tsc clean, lint 23/3.

## Open balance decisions (Phase B step 2 — measured; user decision 2026-11-05: 1 (i) and 5 now
as Phase B2; 2 and 4 deferred as known and small; 3 decided with Phase F)

1. **Auto-publisher poll** (`AUTO_PUB_POLL_MS` 100, `sim.ts` ~line 1873). Two things in one rule.
   (a) The cap: one fire per publisher per poll = 10/s, while `publishSpeed` 10 promises a 50 ms
   cooldown (20/s) and prestige `pubRate` shorter still; at cooldowns over 100 ms a publisher fires
   every ⌈cooldown/100⌉ polls (150 ms → 5/s instead of 6.7/s). Not tick-rate dependent (the
   accumulator gives exactly 10 polls per sim second at any dt; U is flat to 0.1%). (b) Fires lost on
   **irregular** ticks: after a merged input (≥ 2 frames) lands with a large remainder, the next poll
   can come one tick after the previous one; `simNow − last ≥ cooldown` then fails for every
   publisher when that tick is ≤ the cooldown (50 ms ticks vs a 50 ms cooldown fail on floating
   point). Measured: 3.4% of fires at F 10 pubs capped to 20 (50 ms ticks, ~10% late inputs),
   0.5–1.3% unthrottled at 47 ticks/s, 0 with regular 60/30/15 Hz ticks. This is also most of why
   the 10-publisher F runs sit at 94–96% of production across sessions (`a2-10`, `pa3-10`, `b0-10`).
   Options: (i) keep the 10/s cap but anchor `last` to the poll's nominal sim time
   (`simNow − autoPubAccumulator` after the subtraction), so poll spacing is exactly 100 ms and the
   check never fails at cooldown ≤ 100; (ii) per-tick cooldown with catch-up (`while (simNow − last
   ≥ cd) { last += cd; fire }`): `publishSpeed` means what it says, auto income ×2 at level 10, flat
   at any tick rate, but catch-up fires spawn at the same spot and would want a stagger like the
   queue's; (iii) leave it.
2. **Timed-subscriber release quantization** (Pass 2, `shouldReleaseTo` / `canAcceptArrival`): a
   candidate rejected this tick is re-checked next tick, so a saturated subscriber idles up to one
   tick per consume. S (320 ms consume): 8.2 → 8.1 → 7.4 consumed per sim second at 59 / 29 / 15
   ticks/s (−10% at 15), drops 175 → 161 → 150. Only timed subscribers (early/mid game; maxed ones
   are 0 ms and flat). Flat form: when the chain rejects only because the candidate would arrive
   `slack` ms early, release it now with its start pushed back by `slack × progressPerMs` (the
   stagger already does exactly this for same-tick releases). Balance: +~10% on timed subscribers at
   15 ticks/s, ~+3% at 30, 0 at 60.
3. **Capped primary skips its forks** (Pass 1: the broker cap check at `centerP` runs before the
   fork spawn at `touchStart`; a capped primary `continue`s). When one tick carries the dot across
   both marks, a capped primary's forks are neither spawned nor counted. F 20 pubs default caps:
   dropped per sim second 8,972 → 4,333 → 2,532 at 58 / 30 / 15 ticks/s, consumed flat at the cap
   (8,122 / 8,136 / 8,193). Income-neutral while the cap binds (the forks would have dropped), but
   the drop counter, the "!" reasons and DMQ catching see up to 72% fewer drops. Exact-at-60 Hz
   form: run the fork spawn before the cap check (marks in progress order). Note Phase F's design
   makes this deliberate ("a capped copy at DMR1 takes every delivery behind that bridge with it,
   one drop counted"); decide the two together.
4. **Cap arbitration is array order within a tick**: relays are granted in dot-array order, so in a
   long tick the publishers earlier in the component list (lower network tier) take the window's
   remaining slots. F 20 pubs default caps: average value per consumed event 914 → 883 (−3.5%) at
   57 → 15 ticks/s; earned per sim second 7.41M / 7.59M / 7.17M at 58 / 30 / 15 (non-monotone: it
   depends on the tick pattern). Flat form: when a cap binds within a tick, admit by the dot's
   crossing time inside the tick (`(centerP − p) / speed`) rather than array order. Balance: which
   publishers lose under a binding cap.
5. **Dropped-dot fall is per tick** (`dropVY += 0.3·dt/16; dropY += dropVY`): the velocity is
   dt-scaled but applied once per tick, so the fall over the 2.5 s fade is ∝ 1/dt: ~3,500 px at 60
   ticks/s, ~1,780 at 30, ~900 at 15. A DMQ more than ~900 px below the drop point catches nothing at
   15 ticks/s (S's sits 672 px below: caught at ~2.1 s instead of ~1.05 s, not at all at ≤ 10
   ticks/s; the F layout's DMQ is 1,100 px below). dt-proper form `vy += 0.001125·dt; y += vy·dt`
   is identical at 60 Hz. Visual + DMQ; income effect not measured (S at 15 still catches).

Rules measured flat (no decision needed): the poll accumulator (10 polls per sim second at any
dt), the broker 1 s window (consumed at the cap 8,122–8,193 from 58 to 15 ticks/s), the queue
buffer gate (previous-tick backlog), the DMQ 500 ms wall-clock rule (≤ 2/s; its one-per-tick only
matters for direct subscriber retries, which no scale has), the release stagger and the one-tick
pausing wait (latency only: live dots +11% at U and +9% at F at 15 ticks/s), W's webhook rules
(1/1/1 consumed, 8.9–9.05 drops). The 100 ms clamp is the designed dilation below 10 ticks/s.

## Findings

- **The wbase → worker U gain (+5.4%) and the "consumed/s correlates with ticks/s" finding are the
  clamp**, not a per-tick rule: U produces exactly 14,400 per sim second at 60, 58, 30 and 15
  ticks/s; `wbase` at 51.9 fps on a loaded main thread lost ~5% of sim time to inputs over 100 ms.
  `inputsClamped` / `clampLostMs` make this visible: F 20 pubs unthrottled loses 2.0% of sim time
  (17 inputs over 100 ms in 15 s at a 55 ms round trip), 4.3% capped at 15, 6.4% capped at 12; the
  per-wall-second income falls by exactly that.
- **A tick cap at F 20 pubs does not land where it is set**: cap 15 gave 12.0 ticks/s, cap 12 gave
  10.3. Longer ticks hold more dots (one-tick pausing wait 192k × dt, stagger), the tick gets
  longer (46.6 → 62.3 → 70.2 ms), and the round trip (55 → 74 → 84 ms) exceeds the cap interval. The
  feedback loop is why Phase C's dot reduction matters more than the tick budget alone.
- **Machine load corrupts capped runs silently**: the first U runs at 60/30/15 had 13 ms ticks for
  4.7 ms of work and lost 0.3–0.5 s of sim time (hitches over 100 ms); re-runs on a quiet machine
  were exact. Always check `inputsClamped` = 0 at S/M/L/U/W and discard runs where it is not.
- **F 10-publisher runs at 94–96% of production** (three sessions) are the fire loss above (1–3%)
  plus a pipeline still filling over the window (traveling dots 46.9k → 52.7k in 12 s unthrottled);
  30 s accounting shows nothing lost in flight (99.9–100.1%).
- The plan's Phase B wording "run U and F at 60, 30, 15" is unreachable at F 20 pubs (worker-bound
  at ~18 ticks/s); 60 and 30 were covered with `FPUBS=2` and `FPUBS=10`, 20 pubs at 17.5/12/10.3.
- Earlier findings that still hold: WebGL contexts cannot share a buffer (A2); `canvascheck` M
  reports 0 front pixels (layout quirk); same-tick releases do not always ascend (A step 3);
  harness `tickMs` is ~8 ms above the section sum at 20 pubs; GC 8% of the worker at 20 pubs;
  `avgQueued` 6–8 at W is pre-existing; `CLAUDE.md` does not list `src/sim/*` yet (worker-refactor
  Phase 4 pending; `EventCanvas.tsx` line still says "2D front canvas"); harness scripts in
  `scripts/perf/.out/` cannot live in the session scratchpad.

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
