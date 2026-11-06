# Scale plan — session handoff

Handoff between sessions executing `scale-plan.md` (the late-game "TIE fighter" at 20 publishers).
Same protocol as `worker-refactor-progress.md`: read this first, do the phase under **Next**, pass
its gate, rewrite this file.

## Next

**The scale plan is complete**: Phases A, A2, B, C, D and F are done and gated (Phase E, flow
mode, stays unscheduled: F 20 runs at 59.5 ticks/s with 5.6 ms ticks, 100% of production). Nothing
in `scale-plan.md` is left to execute. What remains, in order of usefulness:

1. `worker-refactor-plan.md` **Phase 4 (docs and cleanup)**, still pending in
   `worker-refactor-progress.md` and the scale plan said it should land first: `CLAUDE.md` file
   structure (`src/sim/*` incl. `forkTree.ts`, `releaseIndex.ts`, `positions.ts`,
   `src/hooks/useSimBridge.ts`; the store never sees dots; a dot carries `count`; per-dot fields
   are set at creation; the fork tree), the save-exclusion list (no `eventDots`), the two rate
   stats; `dev-notes.md` "Round 4 — worker"; `event-dot-lifecycle.md` passes in `Sim.tick`;
   remove the worker plan's "planned, not started" line. Gate: tsc clean, lint 23/3.
2. The **open balance decisions** below need the user (1 (ii), 2 and 4 remain; 3 was decided and
   done on 2026-11-05).
3. The user's future option (render bundles as their `count` distinct dots again, plan end of
   Phase C; render-side only), not scheduled.

## State of the tree

- Phase F is committed as `dfbe31d` ("fork events where routes diverge (DMR relay accounting)", on
  top of `9af77b7`; Phase D is `a2e6bef`). **Uncommitted on top of it: balance decision 3**
  (`src/sim/sim.ts`, `claude-docs/upgrades.md`, this file; suggested message: "sim: each link copy
  is its own relay attempt"). The user commits. Phase F changed: `src/sim/types.ts`, `src/sim/publish.ts`,
  `src/sim/sim.ts`, `src/store/upgradeConfig.ts`, `scripts/perf/behavior.mjs`,
  `scripts/perf/compare.mjs`, `scripts/perf/prof.mjs`, `scripts/perf/README.md`,
  `claude-docs/upgrades.md`, `claude-docs/event-dot-lifecycle.md`, `claude-docs/dev-notes.md`,
  `claude-docs/scale-plan.md` (status line), this file. New: `src/sim/forkTree.ts`,
  `src/sim/__tests__/forkTree.test.ts`. Gitignored: `scripts/perf/.out/manualcheck.mjs` (section
  E added).
- `types.ts`: `ForkPath` (`waypoints`, `nodeIds`, `value?`, `color?`, `steps?: ForkStep`) and
  `ForkStep` (`nodeId`, `forks: ForkPath[]`, `next?: ForkStep`); `EventDot.forkStep?: ForkStep`
  replaces `forkPaths`/`forkNodeId` (the plan's "head of the list" is a linked list: advancing a
  step is a pointer move, the step data is per-fire plan data shared by every dot and never
  mutated).
- `forkTree.ts` (new, pure): `planForkTree(routes, i, isBroker, forkFor)` — routes share
  `nodeIds[0..i]` (a broker); partition by `nodeIds[i+1]` in order of first appearance; the first
  partition is the dot's own (recursing at `i+1` if that hop is a broker, else its extra routes
  fork here); every other partition contributes one fork: its own subtree's primary with that
  subtree's steps if the hop is a broker, else each of its routes. Returns `{ primary, step }`.
  Without bridges the hops after the first broker are queues/subscribers, one route each, so the
  result is one step at the first broker with `group.slice(1)` as forks: the old list exactly.
- `publish.ts`: `PlannedDot` carries `forkStep`; the `forkGroups` loop calls `planForkTree` with
  the first broker's index (`'none'` groups get no step, as their forks never spawned before);
  `routesBundleExact` walks every step and nested step.
- `sim.ts`: fork spawn is a `while (step)` over the head step and its successors (`break` at the
  first step whose broker/mark is missing or whose `touchStart` the dot has not reached), each
  spawned fork dot carries `forkStep: fork.steps`, and the dot's `forkStep` is advanced in place
  (no new object; the old code spread a copy to clear two fields). `rebuildForkSteps(step,
  onlyNodeId, components, connections)` (module level) rebuilds fork routes through nested steps
  for the drag frame (only routes through the dragged node, degenerate or not, as before) and the
  post-drag Y-snap (all routes, degenerate rebuilds keep the old waypoints, as before). Relay
  accounting needed no new code, as the plan said: a fork dot starts at progress 0 at its spawn
  broker (no crossing charge there), each spawn charges the spawn broker, each crossing charges
  the broker crossed.
- Decision 3 (`sim.ts`, traveling branch): the crossing loop no longer `continue`s on a refusal;
  it records the refusing mark (`cappedMark`) and, for a dot with steps, the count before each
  partial admission (`countsBefore`, allocated only then). The fork spawn loop then runs for the
  steps reached, stops at any step past `cappedMark`, and spawns each step's forks with the count
  the dot arrived at that broker with (`forkCount`: the first `countsBefore` entry at or after the
  step's `centerP`, else `dot.count`), each with its own `tryBrokerRelay`. A refused dot is pushed
  dropped after the spawn loop, carrying its advanced `forkStep`, so a DMQ retry does not re-spawn
  forks already sent. Where no cap binds nothing changes (no record, `forkCount === dot.count`).
- `upgradeConfig.ts`: `CLUSTER_THROUGHPUT_MULTIPLIER` 1.25 → **1.4** (comment updated with the
  new level targets: ingestion cluster ~31, bridged clusters ~45, ~$98B total; was ~$3B at 1.25
  and ~$130B before Phase F when the ingestion cluster needed ~65).
- Harness: `behavior.mjs` samples the summary's `brokerRelayCounts` and the store's
  `recentPublishes` every 500 ms and reports `publishedEventsPerSec`, `brokerRelaysPerSec` and
  `relaysPerPublishedEvent` per broker; `compare.mjs` prints the relay lines; `prof.mjs` F comment
  and the README state the 2 / 4 / 4 accounting. `manualcheck.mjs` section E: F layout with
  `FPUBS=2 FTHROUGHPUT=300`, auto-fire off, one click on pub-1; records the traveling dots per
  route (fork routes only), the distinct dots per cable leaving each broker, the max trailing-
  second relay count per broker, and the consumed/dropped totals 4 s later.
- Unit tests (`npx tsc -b && node --test src/sim/__tests__/*.test.ts`): `forkTree.test.ts` 6
  (single route; no bridges = old list in order; TIE fighter tree and relay counts 2/4/4 with all 8
  routes delivered once; mixed queue+bridge in both orders; bridge chain; 300 random meshes with
  the game's one-route-per-queue-per-broker dedup: every route delivered once and each broker's
  relays = its distinct next hops) + `release.test.ts` 4 = 10/10.
- Labels in `.out/`: `f1` (Phase F: S, M, L, U, W, F 20 at `FTHROUGHPUT=300`, `f1-10`, `f1-2`),
  `f1cap` (F 20 at default caps; its predecessor is `c1cap`), `f2`/`f2-10`/`f2-2`/`f2cap` (the
  same set on the decision-3 build), `manualcheck-f1.json`, `manualcheck-f2.json`. Earlier: `d0`,
  `d2`, `c1`, `c1cap`, `wbase`…
- Line endings: every changed file CRLF except `src/store/upgradeConfig.ts`,
  `claude-docs/upgrades.md` and `claude-docs/event-dot-lifecycle.md`, which were LF at HEAD and
  were left LF (git's autocrlf warns it will normalize them when it next touches them; the CRLF
  check in the kickoff prompt lists these three by design).
- Lint 23/3, tsc clean, preview server stopped.

## Measured — Gate F (headless, worker mode, 15 s windows, per **sim** second; `d2` → `f1`)

`inputsClamped` was 0 in every run of both labels. Relays per published event (new column) are
`f1` only; by construction `d2` charged the ingestion cluster 8 per event (7 forks + 1 crossing)
and the bridged clusters 4.

| scale | fps | ticks/s | ms/tick | consumed | dropped | earned | dots | pausing | relays/event |
|---|---|---|---|---|---|---|---|---|---|
| S | 59.9 → 60 | 58.7 → 59.5 | 2.96 → 2.53 | 8.2 → 8.2 | 175.6 → 175.6 | 3,339 → 3,255 | 444 → 445 | 3 → 3 | 1.66 (1 broker, drops) |
| M | 60.1 → 60 | 60.1 → 59.8 | 0.45 → 0.51 | 1,442.1 → 1,440.0 | 0 | 746.4k → 745.3k | 461 → 462 | 12 → 13 | 3.01 / 3.01 |
| L | 60 → 60 | 59.4 → 59.9 | 0.82 → 0.80 | 4,316.4 → 4,318.8 | 0 | 3.0987M → 3.1006M | 920 → 923 | 23 → 23 | 2.01 ×3 |
| U | 60 → 60 | 60.1 → 60.4 | 1.26 → 1.41 | 14,406 → 14,396 | 0 | 10.342M → 10.335M | 1,820 → 1,809 | 46 → 51 | 2.01 ×6 |
| W | 60 → 60 | 60.1 → 59.8 | 0.48 → 0.56 | 1 → 1 | 9.0 → 9.0 | 30 → 30 | 33 → 32 | 1 → 1 | — |
| F 20 (300) | 60.1 → 60 | 58.9 → 59.5 | 5.96 → 5.61 | 191,950 → 191,941 | 0 | 187.47M → 187.46M | 18,359 → 18,028 | 546 → 553 | **2.01 / 4.03 / 4.03** |
| F 10 (300) | 60 → 60 | 60.1 → 60.3 | 3.40 → 3.51 | 95,984 → 95,987 | 0 | 69.71M → 69.71M | 9,066 → 8,899 | 243 → 238 | 2.01 / 4.00 / 4.03 |
| F 2 (300) | 60 → 60 | 60.2 → 60.4 | 0.90 → 0.85 | 19,215 → 19,206 | 0 | 10.11M → 10.10M | 1,775 → 1,826 | 30 → 67 | 2.00 / 4.02 / 4.02 |
| F 20 caps (`c1cap` → `f1cap`) | 60.1 → 60 | 60.3 → 60.1 | 2.02 → 2.19 | 8,180 → **15,623** | 9,187 → **2,866** | 7.19M → **14.09M** | 4,726 → 2,430 | 13 → 27 | 0.34 / 0.32 / 0.33 (412 / 395 / 387 relays/s, every cluster at its 412 cap) |

Against `wbase` (per wall second): S 8.2/175.88/3,244.6 → 8.2/175.66/3,255.6; M
1,440.3/0/745,474 → 1,440.6/0/745,633; L 4,323.4/0/3.104M → 4,316/0/3.099M; U 13,682/0/9.82M →
14,401.5/0/10.34M (the clamp loss `wbase` had, as in every gate since Phase 3); W 1/9.06/29.97 →
1/8.99/29.98. S earned −2.5% vs `d2` is this scale's known ±3% run noise (`d2` was itself +3% over
`d0`); events per scale unchanged (U 9,101 → 9,043, F 20 110,152 → 108,170: the DMR3 subtree's
copies now spawn at DMR3 instead of DMR1, so each lives a shorter path, hence 1.8% fewer live
dots at the same consume rate).

Sections at F 20 (ms per tick): setup 0.56 → 0.53, pass1 2.76 → 2.60, index 0.02, pass2 0.45 →
0.48, pass3 0.21, sigs 0.12 → 0.11, fill (ms/tick minus sections) 1.83 → 1.66. The M/U/W
ms/tick +0.06–0.15 ms are against the previous session's `d2` numbers and were not re-measured
same-session; the sub-ms ticks moved by as much between the D-gate's `d0` and `d2` (U 1.03 → 1.26
for a change measured at +0.25 ms pass1 at F), the per-dot work the fork step adds is the same one
`forkStep` null check as before, and ticks/s stayed 59.5–60.4 everywhere.

dragsmoke M: worker 462 traveling, 0 off-path, 0 dangling, 1,441 consumed/s; inline 450, 0/0,
1,442; no errors. `manualcheck.mjs` (worker mode): A (click 1 dot `count` 1, 2 fires, webhook
border, win freeze/resume, prestige reset + post-prestige consume), A2 (bundle 1 dot `count` 3 /
per-dot 3 × 1, 9 consumed each), B (45 drops, subscriber-busy reason), C (broker bar 100%, prune
20 → 0), D (kill → inline at 10.06 s via the post-ack timeout, 15 consumed in the 3 s after) pass
with no errors; **E**: after one click 8 traveling fork-route dots of `count` 6
(pub→DMR1→DMR2→Q1, DMR1→DMR3→Q1, DMR2→Q2..4, DMR3→Q2..4), exactly one dot on each of the 10
cables leaving the three clusters (DMR1→DMR2, DMR1→DMR3, DMR2→Q1..4, DMR3→Q1..4), max trailing-
second relays DMR1 12 / DMR2 24 / DMR3 24 (2 / 4 / 4 per event), 960 consumed (6 × 8 × 20), 0
dropped, 0 live dots after 4 s, no errors. tsc clean, lint 23/3, tests 10/10.

**Decision 3 build (`f1` → `f2`, same session, per sim second)**: S 8.2/175.6/3,255 →
8.2/174.6/3,396 (earned +4.3%: inside this scale's spread across every gate, 3,239–3,396; S is
the one small scale where the cap binds, 101 of 103 relays/s, so a small real shift is possible;
consumed and dropped unchanged); M 1,440.0 → 1,439.7; L 4,318.8 → 4,320; U 14,396 → 14,406; W
1/9/30 unchanged; F 20 (300) 191,941 → 191,767 (−0.1%, relays 2.01 / 4.01 / 4.02); F 10 95,987 →
96,056; F 2 19,206 → 19,171; **F 20 default caps** 15,623 → 15,898 consumed/s (+1.8%), 2,866 →
2,835 dropped/s, 14.09M → 14.46M earned/s, the bridged clusters' windows 395 / 387 → 409 / 401
of 412 relays/s (filled link by link instead of fire by fire; DMR1 410). ticks/s 59.2–60.4,
`inputsClamped` 0 everywhere. dragsmoke M worker 444 traveling 0/0 1,442/s, inline 454 0/0
1,441/s, no errors; manualcheck A–E pass (D fell back at 3.06 s this run: the kill landed before
the ack; E one dot per cable, 12/24/24, 960/0). tsc clean, lint 23/3, tests 10/10.

## Open balance decisions (from Phase B; user decision 2026-11-05 unless stated)

1. **Auto-publisher poll** — done as (i) in Phase B2 (10/s cap stays). Option (ii) remains open.
2. **Timed-subscriber release quantization** — deferred (known, small): S 8.2 → 7.5 → 7.4
   consumed per sim second at 60 / 15 / 10 ticks/s. Flat form: release early by `slack`.
3. **Capped primary skips its forks** — **decided 2026-11-05 ("use your lean"): decoupled, done.**
   Every link copy is its own relay attempt: the forks a dot spawns at a broker carry the count
   it arrived there with and take their own slots, whatever that broker's cap did to the dot;
   a dot refused outright still loses every step past that broker (a lost link copy takes the
   deliveries behind it along) and its own events are the drop counted. Before, a refused primary
   skipped the fork step at that broker (its forks vanished uncounted; under the fork tree that
   was the whole fire at the ingestion cluster) and a partly admitted one spawned forks with the
   admitted count. Effect only where a cap binds (`f1cap` → `f2cap` above); S/M/L/U/W and F at
   `FTHROUGHPUT=300` within noise.
4. **Cap arbitration is array order within a tick** — deferred. Phase C adds to it: under a
   binding cap a bundle takes its slots at one instant instead of over the batch's 0.04-progress
   stagger (~200 ms), so which publishers' events fill the window differs; at F 20 default caps
   the value per consumed event moved 913 → 879 (−3.8%) with consumed flat at the cap. Invisible
   where the cap does not bind (S/M/L/U/W, F at `FTHROUGHPUT=300`). Flat form unchanged: admit
   by crossing time inside the tick.
5. **Dropped-dot fall was per tick** — done in Phase B2.
6. **Bundle gate (Phase C)** — **decided 2026-11-05: keep.** Bundles are emitted only where exact
   (routes without a webhook, ending at 0 ms subscribers).
7. **Partial broker relay (Phase C)** — **decided 2026-11-05: keep.** Partial admits exactly the
   events the per-dot compare admitted (head passes, tail drops).

## Findings

- **The plan's Gate F wording is off in one place**: "`F` with the default caps shows DMR1
  recording 2 relays per event and each bridged cluster 4" cannot be read at default caps, where
  all three clusters sit at their 412/s cap (0.34 / 0.32 / 0.33 relays per *published* event;
  `f1cap`). The ratio is observable only where no cap binds: F at `FTHROUGHPUT=300` reads 2.01 /
  4.03 / 4.03 (20, 10 and 2 publishers), and manualcheck E reads exactly 12 / 24 / 24 for one
  6-event bundle. Both are recorded above; the default-caps run is where the **rule change**
  shows instead: `c1cap` → `f1cap` consumed 8,180 → 15,623/s (+91%), dropped 9,187 → 2,866/s
  (−69%), earned 7.19M → 14.09M/s, because the ingestion cluster now passes ~206 events/s (2
  relays each) instead of ~51 (8 each) and the two bridged clusters' caps bind instead (395 and
  387 of 412 relays/s). Intended (the plan's non-goal exception).
- **Everything else the plan said about the code held**: `forkSpawnFor` slices from the fork
  broker and caches per (waypoints, broker), so nested forks reuse it unchanged; relay accounting
  needed no new code; meshes without bridges produce the identical one-step list (unit-tested and
  the S/M/L/U/W numbers). One representation choice: the step list is a linked list (`next`)
  rather than an array with an index, so the dot stores one pointer and advancing allocates
  nothing; the plan's "`forkNodeId`/`forkPaths` become the head of that list" is satisfied.
- **Two-step ticks**: a tick long enough to carry a dot past two fork brokers spawns both steps in
  that tick (the loop continues while the next step's `touchStart` is reached). With one step this
  is byte-identical to before; with two it is the "late instead of never" rule the route profile
  already applies to crossings.
- **The DMQ retry copies `forkStep`** (it spread `...dot`, which carried `forkPaths` before): a
  primary refused at a broker cap, caught by the DMQ and re-released, re-forks when it crosses
  that broker again. Pre-existing, unchanged, now written down.
- **Relay ratios read 2.01 / 4.03, not 2 / 4**, because `brokerRelaysPerSec` (the summary's
  trailing-second relay count) and `publishedEventsPerSec` (the store's `recentPublishes` over
  the trailing second) are sampled at slightly different instants; 0.5–1.5% is the sampling skew,
  not extra relays (manualcheck E, a single bundle, reads exactly 2 / 4 / 4).
- **Fuzz-testing the tree needed the game's dedup**: two routes reaching one queue over different
  last brokers would each be relayed at that queue's broker (two copies arrive on two links), so
  "one relay per distinct next hop" holds only after `publish.ts`'s one-route-per-queue-per-broker
  dedup, which the test now mirrors. Also routes never revisit a node (the path walk's visited
  set), which the generator respects.
- Earlier findings that still hold: Phase D's two deviations (11 floats, two canvas-only fields per
  advanced dot), dot objects must keep one shape (every creation site sets `progressPerMs`/
  `speedUntilP`; `forkStep` is optional like `forkPaths` was and the fork spawn sets it), the lead
  cap is the last tick interval, headless lead values are a probe artefact, the bridge watchdog
  fix (10 s post-ack timeout; manualcheck D is no longer a flake: 10.06 s this session), Phase C's
  plan gap (bundles gated to routes where they are exact), partial relay vs whole-bundle drop
  (decision 7), DMQ catch `min(free, count)` / release one event, dot ids not unique per event,
  B2's `autoPubPollSimTime`, F 10 at 100% of production, compare per sim second against a
  same-session baseline when the change touches the tick (`d2` here is the previous session's;
  the gate numbers are consumed/dropped/earned, which do not drift), S at `--ticks=10` reports a
  few `inputsClamped` by design, machine load corrupts capped runs silently (`inputsClamped` 0
  in every run here), WebGL contexts cannot share a buffer, `canvascheck` M reports 0 front
  pixels, same-tick releases do not always ascend, `avgQueued` 6–8 at W, `CLAUDE.md` does not
  list `src/sim/*` yet (worker-refactor Phase 4, see Next), harness scripts in
  `scripts/perf/.out/` cannot live in the session scratchpad, the Bash tool cuts commands over
  ~8 KB (edit with a CRLF-preserving Node script; `unix2dos` new files).

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
- 2026-11-05: balance decision 3 decided and done (user: "use your lean"): forks carry the count
  the dot arrived with and take their own slots; a refusal only cuts the steps past it. F 20 at
  default caps 15,623 → 15,898 consumed/s, bridged clusters 395/387 → 409/401 of 412 relays/s;
  S/M/L/U/W and F 20/10/2 at `FTHROUGHPUT=300` within noise of `f1`; dragsmoke both modes clean;
  manual checks A–E pass; tests 10/10; tsc; lint 23/3.
- 2026-11-05: Phase F done (fork tree: one copy per link at each broker, the far cluster fans out
  itself; `CLUSTER_THROUGHPUT_MULTIPLIER` 1.25 → 1.4; decision 3 left open with a lean): F 20 at
  `FTHROUGHPUT=300` relays 2.01 / 4.03 / 4.03 per event (was 8 / 4 / 4 by construction) with
  191,950 → 191,941 consumed per sim second, F 10 / F 2 flat, 59.5 ticks/s at 5.6 ms; F at
  default caps 8,180 → 15,623 consumed/s and 9,187 → 2,866 dropped/s (the rule change, every
  cluster at its cap); S/M/L/U/W vs `d2` and `wbase` within noise; dragsmoke both modes clean;
  manual checks A–D + new E (one dot per cable, 12/24/24 relays, 960 consumed) pass; forkTree test
  6/6 + release 4/4; tsc; lint 23/3.
