import { useEffect, useRef } from 'react';
import { useGameStore, meshOf } from '../store/gameStore';
import { sim, takeManualFires, publishSummary } from '../sim/simBridge';

// The requestAnimationFrame driver around the simulation (src/sim/sim.ts). Per frame: the fps
// stat, one `sim.tick` with this frame's delta and the publisher clicks since the last one, then
// ONE store commit (`commitFrame`) with the tick's summary and the sim's dot array. The mesh the
// sim runs on is kept current by a store subscription that compares the identity of the four
// fields the rules read; a prestige resets the sim (dots cleared, dot ids restart).

/** Smoothed FPS for the sidebar stat and adaptive coin pop throttling.
 *  Smoothed in frame-time space (an EMA of the raw, unclamped frame delta, then inverted):
 *  averaging instantaneous 1000/dt values over-reads badly when frames are uneven, and using
 *  the clamped dt put a floor of 1000/MAX_FRAME_DT_MS under the number — it could never show
 *  less than 10 even when the real rate was 1. Frames longer than FPS_PAUSE_MS are a tab
 *  switch or a hitch, not rendering performance, and are skipped. */
let _smoothedDt = 1000 / 60;
const FPS_SMOOTH = 0.1; // low-pass weight on frame time (converges in ~20 frames)
const FPS_PAUSE_MS = 1000;
export function getSmoothedFps() { return 1000 / _smoothedDt; }

/** Lowest smoothed FPS seen this session (shown on the end-game stats). Session-level, not saved. */
let _minFps = Infinity;
let _fpsFrameCount = 0;
const MIN_FPS_WARMUP_FRAMES = 120; // skip startup frames so page load doesn't count as a dip
export function getMinFps() { return _minFps === Infinity ? getSmoothedFps() : _minFps; }

/** The first-drop tutorial fires once, 1 s after the sim reports its first drop. */
let firstDropTutorialShown = false;

export function useGameLoop() {
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  useEffect(() => {
    // Hand the sim the current mesh and keep it current. Every store commit runs this; it only
    // does work when one of the four mesh fields changed identity (a drag replaces `components`
    // every frame, which rebuilds the layout caches exactly as the loop's per-frame reads did).
    sim.setMesh(meshOf(useGameStore.getState()));
    const unsubscribe = useGameStore.subscribe((s, prev) => {
      // performPrestige: the run's dots are gone and dot ids restart (it used to clear
      // eventDots and the id counter itself).
      if (s.prestige.count !== prev.prestige.count) sim.reset();
      if (s.components !== prev.components || s.connections !== prev.connections ||
          s.upgrades !== prev.upgrades || s.prestige !== prev.prestige) {
        sim.setMesh(meshOf(s));
      }
    });

    const loop = (time: number) => {
      if (lastTimeRef.current === 0) lastTimeRef.current = time;
      // The sim clamps the delta (MAX_FRAME_DT_MS in sim.ts); the fps stat wants the raw one.
      const rawDt = time - lastTimeRef.current;
      lastTimeRef.current = time;

      // Update smoothed frame time for the fps stat and adaptive coin pop throttling
      if (rawDt > 0 && rawDt < FPS_PAUSE_MS) {
        _smoothedDt += FPS_SMOOTH * (rawDt - _smoothedDt);
        _fpsFrameCount++;
        if (_fpsFrameCount > MIN_FPS_WARMUP_FRAMES) {
          _minFps = Math.min(_minFps, getSmoothedFps());
        }
      }

      const state = useGameStore.getState();

      // End-game win screen: freeze the simulation in place behind the overlay. Nothing is
      // ticked or committed; resuming after dismissal just picks up at normal pace.
      if (state.showWinScreen) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      const summary = sim.tick({
        dtMs: rawDt,
        nowMs: Date.now(),
        draggingNodeId: state.draggingNodeId,
        frozen: false,
        manualFires: takeManualFires(),
      });
      publishSummary(summary);

      // Show first-drop tutorial 1 second after the first drop
      if (summary.firstDropAt !== null && !firstDropTutorialShown && Date.now() - summary.firstDropAt >= 1000) {
        firstDropTutorialShown = true;
        useGameStore.getState().showTutorial('firstDrop');
      }

      // One store commit for the whole frame: moved dots (plus the due publishers' new ones),
      // this frame's consumes (money is added in the same commit), the drop count, the
      // auto-publishers' cooldowns and the slot display.
      state.commitFrame(summary, sim.getDots());

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
      unsubscribe();
    };
  }, []);
}
