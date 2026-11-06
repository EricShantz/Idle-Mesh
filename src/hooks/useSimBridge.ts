import { useLayoutEffect, useRef } from 'react';
import { useGameStore, meshOf } from '../store/gameStore';
import * as bridge from '../sim/simBridge';
import type { GameComponent } from '../sim/types';

// The requestAnimationFrame driver around the simulation bridge (src/sim/simBridge.ts). Per
// frame: the fps stat, then one input with the frame's delta and the publisher clicks since the
// last one — sent right away if the previous tick has returned, otherwise the moment it does
// (the bridge's idle callback); if the next frame comes first the deltas accumulate into one
// input. Never more than one input per frame. Each tick's summary comes back
// through the bridge (synchronously inline, by message from the worker) and is applied with ONE
// store commit (`commitFrame`). The dots never enter the store: the canvas draws them from the
// bridge's position buffer. The mesh the sim runs on is kept current by a store subscription
// that compares the identity of the four fields the rules read; a prestige resets the sim (dots
// cleared, dot ids restart).

/** Smoothed render FPS for the adaptive coin pop throttling (the sidebar shows the sim's tick
 *  rate instead; see getSimTicksPerSec in simBridge.ts).
 *  Smoothed in frame-time space (an EMA of the raw, unclamped frame delta, then inverted):
 *  averaging instantaneous 1000/dt values over-reads badly when frames are uneven, and using
 *  the clamped dt put a floor of 1000/MAX_FRAME_DT_MS under the number — it could never show
 *  less than 10 even when the real rate was 1. Frames longer than FPS_PAUSE_MS are a tab
 *  switch or a hitch, not rendering performance, and are skipped. */
let _smoothedDt = 1000 / 60;
const FPS_SMOOTH = 0.1; // low-pass weight on frame time (converges in ~20 frames)
const FPS_PAUSE_MS = 1000;
export function getSmoothedFps() { return 1000 / _smoothedDt; }

/** The first-drop tutorial fires once, 1 s after the sim reports its first drop. */
let firstDropTutorialShown = false;

/** If the only difference between two component arrays is the dragged card's position, that
 *  card; otherwise null (anything else — a purchase, an upgrade, a removal — needs the snapshot).
 *  immer keeps the identity of untouched elements, so this is a reference compare per index. */
function onlyMovedCard(next: GameComponent[], prev: GameComponent[], draggingId: string): GameComponent | null {
  if (next.length !== prev.length) return null;
  let moved: GameComponent | null = null;
  for (let i = 0; i < next.length; i++) {
    if (next[i] === prev[i]) continue;
    if (moved || next[i].id !== draggingId || prev[i].id !== draggingId) return null;
    moved = next[i];
  }
  return moved;
}

export function useSimBridge() {
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  // A layout effect so this RAF registers before EventCanvas's (passive) one: the input then
  // goes out at the top of the frame, before the canvas draws, giving the worker the most time
  // to answer before the next frame.
  useLayoutEffect(() => {
    // Frame time not yet sent to the sim and whether a frame is waiting to send it: the worker may
    // still be ticking the previous input, in which case the input goes out when that tick lands
    // (sendInput from onIdle) or, if the next frame comes first, carries the sum of the deltas
    // (the sim clamps it as it did a long frame).
    let pendingDt = 0;
    let frameWaiting = false;
    const sendInput = (late: boolean) => {
      const state = useGameStore.getState();
      // Settle the frame's bookkeeping before the tick: inline, bridge.tick runs the tick (and the
      // idle callback) synchronously, and the callback must see this frame as already sent.
      const dtMs = pendingDt;
      pendingDt = 0;
      frameWaiting = false;
      bridge.tick({
        dtMs,
        nowMs: Date.now(),
        draggingNodeId: state.draggingNodeId,
        frozen: false,
        manualFires: bridge.takeManualFires(),
      }, late);
    };

    bridge.start(summary => {
      // Show first-drop tutorial 1 second after the first drop
      if (summary.firstDropAt !== null && !firstDropTutorialShown && Date.now() - summary.firstDropAt >= 1000) {
        firstDropTutorialShown = true;
        useGameStore.getState().showTutorial('firstDrop');
      }
      // One store commit for the whole tick: its consumes (money is added in the same commit),
      // the drop count, the auto-publishers' cooldowns and the slot display.
      useGameStore.getState().commitFrame(summary);
    }, () => {
      // The frame that found the worker busy sends now (unless the win screen opened meanwhile).
      if (frameWaiting && !useGameStore.getState().showWinScreen && bridge.canTick()) sendInput(true);
    });

    // Hand the sim the current mesh and keep it current. Every store commit runs this; it only
    // does work when one of the four mesh fields changed identity. A drag replaces `components`
    // every frame: when that is all that changed, only the moved card's position is sent (the
    // sim gives its snapshot a new `components` identity, so the layout caches rebuild exactly
    // as the loop's per-frame reads did).
    bridge.setMesh(meshOf(useGameStore.getState()));
    const unsubscribe = useGameStore.subscribe((s, prev) => {
      // performPrestige: the run's dots are gone and dot ids restart (it used to clear
      // eventDots and the id counter itself).
      if (s.prestige.count !== prev.prestige.count) bridge.reset();
      if (s.components !== prev.components || s.connections !== prev.connections ||
          s.upgrades !== prev.upgrades || s.prestige !== prev.prestige) {
        const moved = s.draggingNodeId !== null && s.connections === prev.connections &&
          s.upgrades === prev.upgrades && s.prestige === prev.prestige
          ? onlyMovedCard(s.components, prev.components, s.draggingNodeId)
          : null;
        if (moved) bridge.moveComponent(moved.id, moved.x, moved.y);
        else bridge.setMesh(meshOf(s));
      }
    });

    const loop = (time: number) => {
      if (lastTimeRef.current === 0) lastTimeRef.current = time;
      // The sim clamps the delta (MAX_FRAME_DT_MS in sim.ts); the fps stat wants the raw one.
      const rawDt = time - lastTimeRef.current;
      lastTimeRef.current = time;

      // Update smoothed frame time for the fps stat and adaptive coin pop throttling
      if (rawDt > 0 && rawDt < FPS_PAUSE_MS) _smoothedDt += FPS_SMOOTH * (rawDt - _smoothedDt);

      const state = useGameStore.getState();

      // End-game win screen: freeze the simulation in place behind the overlay. Nothing is
      // ticked or committed (and the frozen time is not owed to the sim); resuming after
      // dismissal just picks up at normal pace.
      if (state.showWinScreen) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      pendingDt += rawDt;
      frameWaiting = true;
      if (bridge.canTick()) sendInput(false);
      else bridge.noteBusyFrame();

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
      unsubscribe();
      bridge.stop();
    };
  }, []);
}
