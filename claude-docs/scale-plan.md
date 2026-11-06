# Plan: smooth late game at 20 publishers of fan-out

Status: in progress, see `scale-progress.md` (Phases A, A2, B, C and D done on 2026-11-05; F is next; the
open balance decisions, including two from C, are listed there). Written
2026-11-05 after Phase 3 of `worker-refactor-plan.md` (the sim runs in a Web Worker). Execute the
phases in order; each ends at a verified, committable state. `worker-refactor-plan.md` Phase 4
(docs) should land first; it is independent of this plan.

## The target

The player's late-game mesh, everything maxed: 20 publishers → one DMR Cluster → bridges to two
DMR Clusters (the +50% bonus) → 4 queues each → 20 subscribers per queue with fan-out and topic
broadening. One fire becomes 2 × 4 × 20 = 160 consumes. With batch fire 6 and the auto-publisher
poll (one fire per 100 ms of sim time per publisher, see Findings) that is 1,200 fires/s at the
first cluster, 9,600 queue arrivals/s and **192,000 consumes/s**. Today it plays at 6 ticks/s on an
M3 MacBook Pro; two publishers play fine.

Harness replica: scale `F` in `scripts/perf/prof.mjs` (`FPUBS=<n>` publishers, default 20;
`FTHROUGHPUT=300` lifts the broker caps the way prestige throughput multipliers do; without it the
upgrade-max cap drops most of the fan-out and the mesh never reaches the load). The layout follows
the player's screenshot: both bridge clusters feed the same 4 queues, and all 4 queues fan out to
the same 20 subscribers. Measured on the Phase 3 build (headless, worker mode):

| run | ticks/s | ms/tick | live dots | consumed/s | dropped/s |
|---|---|---|---|---|---|
| `FPUBS=2` | 55 | 9.0 | 6.2k | 8.0k | 528 |
| `FPUBS=20` (caps at upgrade max) | 56.4 | 6.5 | 14k | 8.1k | 3,351 |
| `FPUBS=20 FTHROUGHPUT=300` | **3.9** | **5,873** | **95k** | 254 | 0 |

So the player's symptom reproduces, and it is not "too many dots" in the first instance. Worker
profile of an earlier variant of the layout (one subscriber group per queue, 169k dots, 992 ms
ticks; `node scripts/perf/prof.mjs F --worker` with `FTHROUGHPUT=300`), the only one where V8
left the release check un-inlined:

| self time | function |
|---|---|
| 37.9% | `shouldReleaseTo` (Pass 2 predictive release check) |
| 14.8% | `(anon)` closures inside it: the per-candidate `arrivals.map` and `chain.sort` |
| 15.1% + 14.8% | the per-dot frame function (`tick` + Pass 1 IIFE) |
| 3.9% | GC |
| 3.5% | `inZones` |

`shouldReleaseTo` builds and sorts the full list of dots heading to a subscriber **for every
candidate dot, for every fan-out target**. With 20-way fan-out that is: per queue per tick,
(queued candidates) × 20 subscribers × (arrivals per subscriber, ~700 at this load) × log. The cost
grows with load squared; two publishers never notice, twenty collapse. The per-dot movement loop
is the second cost and is linear.

Why 169k live dots: a 1 s tick means arrivals wait a whole tick as `pausing` (26k) and the queue
backlog is released in one burst. At a healthy tick rate the steady state is production × lifetime
≈ 192k/s × ~0.4 s ≈ 75k dots, still 5–8× the U scale the loop was tuned at.

## Non-goals

- No change to upgrade numbers, caps, values, prestige, or the save format. Two user-decided
  exceptions: the DMR throughput cost multiplier (2.0 → 1.25 on 2026-11-05, → 1.4 with Phase F)
  and Phase F's relay accounting.
- The early and mid game (one dot per event, click to fire, visible drops) stay as they are; every
  change below is either exact-equivalent or gated to loads where dots are already a blur.
- No second worker, no SharedArrayBuffer.

## Phases

### Phase A — release and occupancy checks in O(log n) per candidate (½ day)

Goal: `shouldReleaseTo` gives the same answers with a per-subscriber sorted arrival index instead
of a rebuilt, re-sorted chain per candidate per target. Exact-equivalent; nothing visible changes.

1. **Done 2026-11-05.** The fast path that covers the maxed late game: `consumeDurationFor(sub) === 0`
   (fasterConsumption ≥ 11 → 100% → 0 ms). With a zero consume duration `busyUntil` never exceeds
   the latest earlier arrival, so the chain can never reject; return `true` before building
   anything (exact: `busyUntil = max(t, busyUntil) + 0` over ascending `t`). Ticks went from
   5,873 ms to 555 ms.
1b. **Done 2026-11-05.** The second quadratic check, found with per-section tick timers after
   step 1: the subscriber-occupancy scan on arrival walks every pausing dot at that subscriber
   (`pausingBySub` bucket) per arriving dot; with 0 ms consume `elapsed < 0 − 50` is never true,
   so the scan is skipped. Ticks 555 → 103 ms, consumed 30k → 136k/s. Keep the timers
   (`tickSections`); they are what finally separated the passes.
1c. **Done 2026-11-05.** Skip building the arrival index (`subTiming`, the `predictedArrival` pushes in the index loop
   and after each release) for subscribers with a 0 ms consume: nothing reads it once step 1
   returns early. Worth ~27 ms of the 103 ms tick (`index`) plus part of `pass2`.
2. **Done 2026-11-05** (`src/sim/releaseIndex.ts`; the suffix condition reduces to adjacent gaps ≥
   `consumeDuration`, see `scale-progress.md` → Findings). General case: keep `subTiming.arrivals` sorted (binary insert in `timingFor(...).arrivals.push`
   sites; there are two) and precompute per subscriber, once per tick after the Pass 1 index is
   built, the prefix `busyUntil` after each arrival and the suffix slack `min(t_j − busyUntil_j)` for
   arrivals after position j. A candidate at travel time `t` then needs: `t ≥ busyUntil(prefix
   before t)` and, for the "would make a later dot collide" half, that inserting it (which adds
   `consumeDuration` to every later `busyUntil` until the chain has slack) leaves the suffix slack
   ≥ 0. Work out the exact recurrence against the current loop and keep the current loop as the
   reference in a unit test (`src/sim/__tests__/release.test.ts`, run with `node --test` after
   `tsc`; the repo has no test runner, so keep it dependency-free) over random arrival sets.
3. **Done 2026-11-05** (binary insert; same-tick releases from different queues to one subscriber
   do not ascend, see Findings). Releases made within the tick append to the index; keep the ascending order (the stagger makes
   same-tick releases ascend already; assert, don't assume).

Gate A: unit test passes (random chains, both halves of the rule, consume durations 0 and > 0);
`behavior.mjs` S, M, L, U, W vs `wbase` within noise; `F` with `FTHROUGHPUT=300`: the worker's
`tickMs` ≤ 60 (the main thread, not the sim, now bounds ticks/s until Phase A2); `dragsmoke.mjs M`
in both modes clean; tsc clean, lint count unchanged (23/3). Record the `F` numbers in
`scale-progress.md`. Commit: "sim: release check in log time per candidate".

### Phase A2 — pausing dots through WebGL (½ day)

Found after Phase A step 1b: at 20 publishers the main thread spends 72% of its time in 2D
`drawImage` on the front canvas, one call per pausing dot per frame (~15k pausing dots when the
sim ticks at 7/s; ~2k at 60 ticks/s, still too many for one `drawImage` each). The front canvas
exists only to draw pausing dots above the node cards (z-index 25 vs 19).

1. **Done 2026-11-05** (`u_front` uniform, set once per context; WebGL contexts cannot share a
   buffer object, so each canvas uploads the same CPU buffer, see `scale-progress.md` → Findings).
   Give the front canvas its own WebGL context with the existing point-sprite renderer
   (`createGlRenderer`); add a uniform that flips the vertex shader's clip so the back context
   draws `glow < 1.5` and the front `glow ≥ 1.5` entries from the same buffer upload. Keep the 2D
   `drawEntry` path as the fallback for both canvases when WebGL is unavailable.
2. **Done 2026-11-05** (both scripts now read WebGL canvases through a scratch 2D canvas; the
   pixel counts are in `scale-progress.md`). The shrink is already in the buffer (`extent` and alpha), so the look is unchanged; verify with
   `.out/pausecheck.mjs` (front canvas pixels over the pause) and `.out/canvascheck.mjs`
   (`--disable-webgl` fallback).

Gate A2: main-thread profile at `F` 20 publishers shows `drawImage` gone from the top entries and
render fps ≥ 50; `pausecheck`/`canvascheck` pass; S, M, L, U, W unchanged (sim untouched). Commit:
"canvas: pausing dots in WebGL".

### Phase B — tick-rate independence audit (½ day)

Goal: the money a mesh earns per sim second does not depend on how many ticks that second took,
above the 10 ticks/s clamp. Today's evidence is mixed (see Findings); this phase measures instead
of guessing.

1. **Done 2026-11-05** (`setMaxTicksPerSec` in `simBridge.ts`; `behavior.mjs` reports
   `simSeconds`, the per-sim-second rates and the clamp loss; F at 20 publishers is worker-bound
   at ~18 ticks/s, so it was run at 17.5/12/10.3 and the 10- and 2-publisher variants at 40–60/30/15;
   the table is in `scale-progress.md`). Harness switch: `behavior.mjs ... --ticks=<n>` makes the bridge send at most `n` inputs per
   second (a `window.__sim.setMaxTicksPerSec(n)` debug hook on the bridge; inputs still carry the
   accumulated dt). Run U and F at 60, 30, 15 ticks/s; consumed/s per **sim** second (divide by
   `summary.simNow` delta, which `behavior.mjs` must start reporting) must be flat.
2. **Audited 2026-11-05, no rule changed; decisions pending** (U, M, L, W and F with lifted caps are
   flat within 0.3%; the rules that are not flat — the auto-publisher cooldown on irregular ticks,
   the timed-subscriber release quantization, the capped-primary fork skip, the cap arbitration
   order and the per-tick drop fall — are listed with their measured effect and a proposed form in
   `scale-progress.md` → "Open balance decisions"). For every rule that is not flat, make it a function of `dt`, not of the tick: the known
   candidates are the auto-publisher poll (one fire per publisher per 100 ms poll, which caps the
   fire rate at 10/s although `publishSpeed` 10 promises a 50 ms cooldown; decide with the user
   whether to keep that cap, it is a balance change either way), the DMQ one-release-per-tick, and
   the per-tick `releaseStaggerFor` spread. Anything found is listed, measured, and only changed
   with the user's decision recorded here.

Gate B: the flat-income table at 60/30/15 for U and F, with any rule change listed and its
balance effect stated; S, M, L, U, W vs `wbase` within noise unless a listed change explains the
delta. Commit: "sim: income independent of tick rate".

### Phase C — bundles: one dot per batch (1 day)

Goal: the `fireCount` dots a batch fire produces on one path travel as one dot with `count`.
Every rule that counts events uses the count. Up to 6× fewer dots at max batch fire; the fan-out
legs after a queue (20 per release) stay one dot per subscriber, each carrying the count.

1. `EventDot.count` (default 1). `buildPublishDots` emits one dot per plan entry with
   `count = fireCount` instead of `fireCount` dots; `publishes[].count` stays `fireCount`.
2. Rules by count: broker relay takes `count` slots (`tryBrokerRelay(…, count)` with the cap check
   `ts.length + count > cap` → drop the whole bundle, same as today's per-dot ordering would drop
   the tail; note the difference in Findings if a partial relay is preferred), queue buffer
   gate `queuedCount + count ≤ bufferSize`, DMQ buffer likewise, consume pushes `count` entries'
   worth (`applyConsumes` gets `{ value, subscriberId, count }` and adds `count` to
   `eventsConsumed`/`recentEarnings`), drop counting adds `count`, the slot signature repeats its
   character `count` times, `liveDots`/`byStatus` report events (sum of counts) and dots.
3. Visual: one dot drawn slightly larger by count (`extent` in the position buffer scales by
   `1 + 0.15·log2(count)`), so a bundle reads as a fuller dot rather than a clump.
4. `behavior.mjs` reports both dots and events.

Gate C: S, M, L, U, W consumed/dropped/earned per second vs `wbase` within noise (events, not
dots, are what the counters measure); `F` with `FTHROUGHPUT=300` ≥ 50 ticks/s; drag smoke clean
in both modes; the click-to-fire manual check shows one bundle dot per click with the right
`count`. Commit: "sim: batch fires travel as one dot".

Future option (user, 2026-11-05, not scheduled): draw a bundle as its `count` distinct dots again.
Feasible render-side only: `fillPositions` would emit `count` entries per bundle dot, spread along the
path behind it at the old batch stagger (−0.04 progress per event, clamped at the path start), with
the sim untouched. Cost is the position buffer and draw count returning to per-event size (F 20:
18k → 110k entries, main-thread fill + upload), so gate it: only below a live-event budget, or only
when zoomed in past some threshold, or as a settings toggle. Queued and pausing bundles would still
be one entry (they sit on a card). Phase D's velocity floats would apply per entry unchanged.

### Phase D — render-side interpolation (½ day)

Goal: motion stays smooth at 60 frames when the sim ticks slower than that.

1. `fillPositions` writes two more floats per dot: velocity in world units per ms along the
   path's current segment (`FLOATS_PER_DOT` 8 → 10; the GL vertex layout and the 2D paths follow).
2. `EventCanvas` extrapolates `x + vx·(now − tickNowMs)` capped at one tick interval, using the
   bridge's `latestSummary().simNow` arrival time; pausing and dropped entries do not move.
3. Nothing in the sim changes; the gate is visual: a headless check at 15 ticks/s (`--ticks=15`
   from Phase B) shows canvas positions advancing between ticks.

Commit: "canvas: extrapolate dots between ticks".

### Phase E — flow mode for saturated paths (2–3 days, optional)

Only if Phases A–D leave the 20-publisher mesh under ~50 ticks/s. Above a per-path rate threshold
(e.g. 2,000 events/s on one path array) the path carries a rate instead of dots: the broker cap is
a rate limiter, the queue a level, the subscriber a service rate; a capped stream of sample dots is
drawn and the counters are integrated per tick from the rates. The rules are re-expressed, so every
one needs its own equivalence test against the dot sim at the threshold. Design it in its own plan
file when and if it is needed; do not start it from this one.

### Phase F — fork where routes diverge: real DMR relay accounting (1 day)

Runs after the tick-speed phases (A2–D; E only if it happens). User decision 2026-11-05, after
checking the Solace DMR docs: a cluster sends **one copy of a message per link** and the receiving
cluster does the fan-out to its own queues. Today the publish plan resolves every final destination
up front and groups the routes by the **first** broker (`computePublishPlan`, the `forkGroups`
loop in `publish.ts`), so all copies are spawned at the ingestion cluster and charged to its cap:
in the TIE fighter DMR1 pays 8 relays per event while each bridged cluster pays 4, the reverse of
the real behaviour, and DMR1 caps first even at a higher level. This is a rule change (an explicit
exception to the non-goals), not exact-equivalent.

1. `computePublishPlan`: build the fork tree instead of one fork point. Group the selected routes
   by first broker as today; within a group, partition by the next hop after that broker. Routes
   sharing the next hop continue as one dot; each other partition's first route becomes a fork at
   that broker; recurse at the next broker along each partition's shared prefix. A plan entry (and
   each fork entry) carries an ordered list of fork steps `{ nodeId, forks[] }`; `forkNodeId` /
   `forkPaths` become the head of that list.
2. `Sim.tick` fork spawn: on reaching the head step's broker, spawn its forks (each spawned dot
   carries its own remaining steps), then advance the step. `forkSpawnFor` already slices from the
   fork broker onward, so the caches work per (waypoints, broker). Relay accounting needs no new
   code: each spawn charges its fork broker, each crossing charges the broker crossed. Result for
   the TIE fighter: DMR1 2 relays per event (cap 2,400/s at 1,200 events/s, level ~31 with 4
   slots), DMR2/DMR3 4 each (4,800/s, level ~45). A capped copy at DMR1 now takes every delivery
   behind that bridge with it (one drop counted, as a lost link copy would be).
3. Meshes without bridges are unchanged: a broker fanning out to its own queues already pays once
   per queue, and the tree has one level.
4. Pricing with it: `CLUSTER_THROUGHPUT_MULTIPLIER` 1.25 → 1.4, so the TIE fighter's throughput
   levels stay a meaningful late-game purchase (~$100B, a tenth of the $1T run, instead of ~$3B).
   Update `claude-docs/upgrades.md` and the `F` harness description.
5. Not modelled on purpose: real DMR's one-hop rule between clusters (bridge chains stay allowed).

Gate F: S, M, L, U, W consumed/dropped/earned per second unchanged vs the previous label (no cap
binds there; U/L/M have no bridges); `F` with the default caps shows DMR1 recording 2 relays per
event and each bridged cluster 4 (add `brokerRelayCounts` to the `behavior.mjs` output); `F` with
`FTHROUGHPUT=300` within noise of the previous label on consumed/s; drag smoke clean in both
modes; the headless manual check shows one dot per cable leaving each cluster after a click.
Commit: "sim: fork events where routes diverge (DMR relay accounting)".

## Findings so far (the running list is in `scale-progress.md`)

- Phase 3 handoff claimed "consumed/sec at U tracks ticks/s because some rule is per-tick". The
  `F` runs show the dominant effect is different: long ticks lose sim time to the 100 ms clamp, and
  at 60 Hz the subscriber consume duration at the maxed level is 0 ms, so the per-tick suspicion is
  unproven. Phase B measures it.
- The auto-publisher poll caps auto fire at 10/s per publisher regardless of `publishSpeed` (level
  10 promises 20/s). Pre-existing; a balance decision for the user in Phase B.
- `queueSlotSignatures` strings (one char per queued event) and `activeDrops` cross the worker
  boundary every tick; at 169k dots they were not visible in the profile, but Phase C's count
  repetition should cap the signature length at the buffer size.

## Definition of done

- `F` with `FTHROUGHPUT=300` (20 publishers, 192k consumes/s) at ≥ 50 ticks/s in the headless
  worker run, and consumed/s within 5% of production (1,200 fires/s × 160).
- S, M, L, U, W within noise of `wbase` on event counts.
- Income per sim second flat across 60/30/15 ticks/s for U and F.
- Lint count unchanged, tsc clean, both sim modes pass drag smoke.
