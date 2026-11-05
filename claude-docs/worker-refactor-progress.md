# Worker refactor — session handoff

This file is the handoff between Claude Code sessions executing `worker-refactor-plan.md`.
Each session: read this file first, do exactly the phase named under **Next**, pass its gate,
then rewrite this file for the next session (see "How to hand off"). Keep the history section
short; the plan file holds the design, this file holds only state.

## Next

Phase 2 (canvas reads a position buffer; `eventDots` leaves the store). Stop at Gate 2.

## State of the tree

- Phases 0 and 1 are done and the tree is at a commit point (uncommitted; suggested message
  from the plan: "sim: extract pure simulation module"). The user commits.
- `src/sim/` exists: `types.ts` (ComponentType/GameComponent/Connection/EventDot/GlobalUpgrades/
  PrestigeState/Mesh), `meshRules.ts` (route helpers, `getPermanent*`, `getPublisherCooldownMs`,
  `getEventValue(mesh, id)`, `getAllPathsWithNodes(components, connections, id)`), `publish.ts`
  (`nextDotId`/`resetDotIds`, `getPublishPlan`/`buildPublishDots` over a `Mesh`), `sim.ts`
  (`Sim` class: `setMesh`, `moveComponent`, `reset`, `tick`, `getDots`; `SimInput`,
  `TickSummary`, `DropReason`, `MAX_FRAME_DT_MS`, `DROPPED_VISUAL_CAP`), `simBridge.ts` (the
  one `Sim` instance, `queueManualFire`/`takeManualFires`, `publishSummary`/`latestSummary`),
  `simStats.ts` (`getActiveDrops`, `getBrokerUtilization`, `getSubscriberConsume`,
  `getWebhookFill` reading the latest summary). `Sim.fillPositions` is NOT implemented yet
  (Phase 2 adds it).
- `src/hooks/useGameLoop.ts` is the thin driver (103 lines): fps stat, store subscription that
  calls `sim.setMesh` on any identity change of components/connections/upgrades/prestige and
  `sim.reset()` when `prestige.count` changes, one `sim.tick` and one `commitFrame(summary,
  sim.getDots())` per frame, first-drop tutorial from `summary.firstDropAt`.
- `gameStore.ts`: types and store-free helpers are re-exported from `src/sim`; `meshOf(state)`
  builds the snapshot; `commitFrame(summary: TickSummary, dots)`; `fireEvent` writes the
  cooldown + `recentPublishes` at click time (only if `getPublishPlan` is non-null) and calls
  `queueManualFire`; `fireEvents`, `consumeEvent`, `dropEvent`, `updateDots`, `removeDot`,
  `isPathOccupied`, `buildPublishBatch` are gone. `eventDots` is still in the store (mirror of
  the sim's array, for `EventCanvas`) — Phase 2 removes it.
- `NodeCard.tsx` no longer selects `eventDots`; the webhook border reads `getWebhookFill(id)`
  in its RAF effect. `HelpButton.tsx` imports from `simStats`. `EventCanvas.tsx` untouched.
- Harness labels recorded in `scripts/perf/.out/`: `wbase` (Phase 0 baseline) and `p1` (Gate 1).
  Gate 2 compares to `wbase`.
- Lint: 24 errors / 3 warnings (`npx eslint src`), unchanged. `npx tsc -b` clean.
- `scripts/perf/.out/manualcheck.mjs` (ignored dir) is the headless version of the gate's
  "manual check in the browser" (click-to-fire, webhook border, help-button reasons, broker bar,
  win-screen freeze, prestige reset, removed-queue pruning). Run it from the repo root with the
  preview server up; reuse it for Gates 2 and 3.

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
  broker relay window and drop timestamps that used `performance.now()` before (plan's risk
  section asked for this). `simStats.getActiveDrops` re-filters by `Date.now()` at call time, so
  the 2 s window is unchanged. Sub-ms window edges differ (integer ms vs fractional); within noise.
- Types moved to `src/sim/types.ts` (not in the plan, but required so `src/sim` imports nothing
  from the store). `GameState['upgrades']`/`['prestige']` are `GlobalUpgrades`/`PrestigeState`.
- Coin pop ids have their own counter in the store (they shared `dotIdCounter`); React keys only.
- U-scale `consumedPerSec` went up 5% with fps 51.9 → 57.8 because `commitFrame` no longer
  concat-copies the ~9k dot array every frame (the sim appends publishes in place). The
  consumed-to-earned ratio is identical; the extra throughput is fewer clamped (>100 ms) frames.
- `scripts/perf/prof.mjs` `want` regex still names `loop @ src/hooks/useGameLoop`; the frame is
  now `tick @ src/sim/sim.ts`. Update it in Phase 3's harness step.
- Broker utilization is read at `NodeCard` render time (as before), so the bar only refreshes
  when the card re-renders; not a regression, but the headless check must force a re-render.
- `sim.ts` was produced by moving the loop body verbatim (then dedented 2 spaces); the frame
  function is still an IIFE inside `tick` over `this.dots`. `TickSummary.consumed` entries keep
  the dot `id` field (unused by the store).
- `Sim.moveComponent` exists per the interface but the inline driver relies on `setMesh` from
  the subscription (the store replaces `components` every drag frame).

## History

- 2026-11-05: plan written, nothing executed.
- 2026-11-05: Phase 0 + Phase 1 done. Gate 1 (`wbase` → `p1`): S 8.2/175.9/3245 →
  8.2/175.5/3389 consumed/dropped/earned per s (earned ±2% is this scale's run noise); M 1440 →
  1442; L 4323 → 4292; U 13682 → 14410 (fps 51.9 → 57.8); W 1/9.06/29.97 → 1/9.06/29.98.
  dragsmoke M: 0 off-path, 0 dangling, no errors. tsc clean, lint 24/3. Headless manual checks
  all pass.

## How to hand off (do this at the end of every session, before reporting to the user)

1. Update **Next** to the next phase and its gate (or "Done" after Phase 4).
2. Update **State of the tree**: what exists now, the harness labels recorded so far, the lint
   count, and whether the tree is at a commit point (the user commits; never commit yourself).
3. Add to **Findings** anything the next session must know that is not in the plan.
4. Add one line to **History** with the date, the phase done, and the key gate numbers.
5. Tell the user the tree is ready to commit and that the next session should use the same
   kickoff prompt (it reads this file).
