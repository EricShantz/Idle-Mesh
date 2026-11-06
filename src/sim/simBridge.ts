// Main-thread side of the simulation. The sim (src/sim/sim.ts) runs in a Web Worker
// (sim.worker.ts) behind a message port, or inline on the main thread when the worker cannot be
// created, fails, stalls, or `?inlineSim` is in the URL (A/B testing). Both drivers expose the
// same functions to the rest of the app: useSimBridge drives them from requestAnimationFrame
// (sends one input per frame, applies each tick's summary with ONE store commit), simStats
// serves the UI from the latest summary, EventCanvas draws the latest position buffer, and the
// store queues publisher clicks here for the next tick.
//
// Flow control: at most ONE input is in flight and at most one input per animation frame. A
// frame that finds the previous tick still out sends its input the moment that tick lands (the
// bridge calls the driver's onIdle); if the next frame comes first, the frame deltas accumulate
// and go out as one input (the sim clamps it to MAX_FRAME_DT_MS exactly as it clamped a long
// frame), so sim time tracks wall time the way a slow main-thread frame did and the worker never
// piles up inputs.
//
// Position buffers (layout in positions.ts): two Float32Arrays ping-pong. The canvas draws
// `positions.buf`; `spare` is the free one and goes out with the next input as a transferable
// (null while in flight); the filled one comes back with the tick and the two swap. Never read a
// buffer after transferring it (it is detached). The worker grows the buffer it holds when the
// dot count outgrows it; the inline driver grows `spare` the same way.
import { Sim, tickSections, byStatusOf, MAX_FRAME_DT_MS, type SimInput, type TickSummary, type TickSections } from './sim';
import { FLOATS_PER_DOT } from './positions';
import type { Mesh } from './types';
import type { MainToWorker, WorkerToMain, DebugQuery, DebugResult } from './protocol';

export type SimMode = 'worker' | 'inline';

/** A worker that has not even acknowledged an input for this long is dead or wedged: fall back
 *  inline. The ack is posted before the tick runs, so a tick that takes seconds (an overloaded
 *  mesh) is slow, not dead, and is left alone. */
const WORKER_STALL_MS = 3000;
const INITIAL_CAPACITY = 4096; // dots

// ---- what the UI and the store share with the sim, whichever driver runs it ----

const NO_FIRES: string[] = [];
let pendingManualFires: string[] = [];
let latest: TickSummary | null = null;

/** A publisher click, already cooldown-checked by the store; its dots are built at the start
 *  of the next tick (the store used to append them itself). */
export function queueManualFire(publisherId: string): void {
  pendingManualFires.push(publisherId);
}

/** Drains the pending clicks into the next tick's input. */
export function takeManualFires(): string[] {
  if (pendingManualFires.length === 0) return NO_FIRES;
  const fires = pendingManualFires;
  pendingManualFires = [];
  return fires;
}

export function latestSummary(): TickSummary | null {
  return latest;
}

const positions = { buf: new Float32Array(FLOATS_PER_DOT * INITIAL_CAPACITY), count: 0 };
let spare: Float32Array<ArrayBuffer> | null = new Float32Array(FLOATS_PER_DOT * INITIAL_CAPACITY);

/** The latest filled buffer and how many FLOATS_PER_DOT entries it holds (same object every
 *  call; valid until the next tick lands). */
export function getPositions(): { buf: Float32Array; count: number } {
  return positions;
}

/** Sim ticks per second: smoothed interval between tick arrivals, inverted (the same shape as
 *  the render fps stat in useSimBridge). Equals the frame rate when the worker keeps up — the
 *  bridge sends one input per frame — and drops below it when a tick takes longer than a frame.
 *  Below 1000 / MAX_FRAME_DT_MS (10) the sim runs slower than wall time. */
let _smoothedTickDt = 1000 / 60;
let _lastTickAt = 0;
const TICK_SMOOTH = 0.1;
const TICK_PAUSE_MS = 1000; // a gap this long is a tab switch or a stall, not a rate
export function getSimTicksPerSec(): number {
  return 1000 / _smoothedTickDt;
}

/** When the latest tick landed (performance.now()) and the interval between it and the one
 *  before, capped at MAX_FRAME_DT_MS (a tick never stands for more sim time than that). The
 *  canvas extrapolates traveling dots by their velocity floats (positions.ts) for the time since
 *  arrival, up to that interval: smooth motion at frame rate when the sim ticks slower, and a
 *  stalled sim stops the dots after one interval instead of running them off their cables. The
 *  same object every call. */
const tickTiming = { arrivedAt: 0, intervalMs: 0 };
export function getTickTiming(): { arrivedAt: number; intervalMs: number } {
  return tickTiming;
}

/** Lowest smoothed tick rate seen this session (the end-game stats). Session-level, not saved. */
let _minTicksPerSec = Infinity;
let _tickCount = 0;
const MIN_TICKS_WARMUP = 120; // skip startup ticks so page load doesn't count as a dip
export function getMinSimTicksPerSec(): number {
  return _minTicksPerSec === Infinity ? getSimTicksPerSec() : _minTicksPerSec;
}

let onSummary: ((summary: TickSummary) => void) | null = null;
/** Called after each tick has been applied: the driver sends a frame's input that was waiting. */
let onIdle: (() => void) | null = null;

/** Cumulative counters for the harness (window.__sim.stats()): ticks landed, time the worker
 *  spent in tick + fill, post-to-receive round trip on the main thread's clock, frames that
 *  could / could not send an input (a skipped frame means the previous tick had not returned),
 *  and the inputs whose delta exceeded MAX_FRAME_DT_MS with the sim time that clamp discarded
 *  (the sim then ran slower than wall time by that much). */
const stats = { ticks: 0, tickMsTotal: 0, roundTripMsTotal: 0, framesSent: 0, framesBusy: 0, inputsLate: 0, inputsClamped: 0, clampLostMs: 0, maxInputDtMs: 0, sections: { ...tickSections } as TickSections };

/** Every tick ends here, whichever driver produced it: the summary for simStats and the driver's
 *  listener (commitFrame), the ticks/s stat, and the buffer swap. */
function receiveTick(summary: TickSummary, buf: Float32Array<ArrayBuffer>, count: number): void {
  const now = performance.now();
  if (_lastTickAt > 0) {
    const dt = now - _lastTickAt;
    tickTiming.intervalMs = Math.min(Math.max(0, dt), MAX_FRAME_DT_MS);
    if (dt > 0 && dt < TICK_PAUSE_MS) {
      _smoothedTickDt += TICK_SMOOTH * (dt - _smoothedTickDt);
      _tickCount++;
      if (_tickCount > MIN_TICKS_WARMUP) _minTicksPerSec = Math.min(_minTicksPerSec, getSimTicksPerSec());
    }
  }
  _lastTickAt = now;
  tickTiming.arrivedAt = now;
  latest = summary;
  spare = positions.buf;
  positions.buf = buf;
  positions.count = count;
  onSummary?.(summary);
  onIdle?.();
}

// ---- drivers ----

type Driver = {
  readonly mode: SimMode;
  setMesh(mesh: Mesh): void;
  moveComponent(id: string, x: number, y: number): void;
  reset(): void;
  /** True when a new input can go out (inline: always; worker: the previous tick has returned). */
  ready(): boolean;
  /** Runs (inline) or posts (worker) one tick; the result arrives through receiveTick. Requires ready(). */
  tick(input: SimInput): void;
  debug(what: DebugQuery): Promise<DebugResult>;
  dispose(): void;
  /** Test hook: terminate the worker without telling the bridge, so the stall watchdog has to notice. */
  kill?(): void;
};

function createInlineDriver(): Driver {
  const sim = new Sim();
  return {
    mode: 'inline',
    setMesh: mesh => sim.setMesh(mesh),
    moveComponent: (id, x, y) => sim.moveComponent(id, x, y),
    reset: () => sim.reset(),
    ready: () => true,
    tick(input) {
      const t0 = performance.now();
      const summary = sim.tick(input);
      const dots = sim.getDots().length;
      let buf = spare ?? new Float32Array(FLOATS_PER_DOT * INITIAL_CAPACITY);
      if (buf.length < dots * FLOATS_PER_DOT) buf = new Float32Array(Math.ceil(dots * 1.5) * FLOATS_PER_DOT);
      const count = sim.fillPositions(buf);
      stats.ticks++;
      stats.tickMsTotal += performance.now() - t0;
      stats.sections = { ...tickSections };
      receiveTick(summary, buf, count);
    },
    debug: what => Promise.resolve(what === 'dots' ? sim.getDots() : byStatusOf(sim.getDots())),
    dispose() {},
  };
}

/** Returns null if the Worker cannot be constructed (the caller then runs inline). Failures
 *  after construction (script load error, uncaught error, stall) go through `onFail`. */
function createWorkerDriver(onFail: (reason: string) => void): Driver | null {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
  } catch (e) {
    console.warn('[sim] Worker construction failed, running inline:', e);
    return null;
  }
  let inFlightSince = 0; // performance.now() when the current input was posted; 0 when none
  let acked = false;     // the worker has picked up the in-flight input (it may still be ticking)
  let debugId = 0;
  const debugWaiting = new Map<number, (result: DebugResult) => void>();
  let failed = false;
  const fail = (reason: string) => {
    if (failed) return;
    failed = true;
    onFail(reason);
  };
  worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
    const msg = e.data;
    if (msg.type === 'busy') {
      acked = true;
    } else if (msg.type === 'tick') {
      stats.ticks++;
      stats.tickMsTotal += msg.tickMs;
      stats.sections = msg.sections;
      stats.roundTripMsTotal += performance.now() - inFlightSince;
      inFlightSince = 0;
      receiveTick(msg.summary, new Float32Array(msg.buffer), msg.count);
    } else if (msg.type === 'debug') {
      const resolve = debugWaiting.get(msg.id);
      if (resolve) { debugWaiting.delete(msg.id); resolve(msg.result); }
    }
  };
  worker.onerror = (e: ErrorEvent) => fail(`worker error: ${e.message || 'script failed to load'}`);
  const post = (msg: MainToWorker, transfer?: Transferable[]) => worker.postMessage(msg, transfer ?? []);
  return {
    mode: 'worker',
    setMesh: mesh => post({ type: 'mesh', mesh }),
    moveComponent: (id, x, y) => post({ type: 'move', id, x, y }),
    reset: () => post({ type: 'reset' }),
    ready() {
      if (inFlightSince === 0) return true;
      if (!acked && performance.now() - inFlightSince > WORKER_STALL_MS) fail(`no answer for ${WORKER_STALL_MS} ms`);
      return false;
    },
    tick(input) {
      const buf = spare;
      if (!buf) return; // cannot happen when ready(): the previous buffer is still out
      spare = null;
      inFlightSince = performance.now();
      acked = false;
      post({ type: 'input', input, buffer: buf.buffer }, [buf.buffer]);
    },
    debug: what => new Promise<DebugResult>(resolve => {
      const id = ++debugId;
      debugWaiting.set(id, resolve);
      post({ type: 'debug', id, what });
    }),
    dispose() {
      worker.terminate();
      debugWaiting.clear();
    },
    kill: () => worker.terminate(),
  };
}

// ---- the bridge ----

let driver: Driver | null = null;
let lastMesh: Mesh | null = null;

function fallbackInline(reason: string): void {
  console.warn(`[sim] ${reason}; running the simulation inline from here on`);
  driver?.dispose();
  driver = createInlineDriver();
  if (lastMesh) driver.setMesh(lastMesh);
  // The buffer that was in flight is gone with the worker.
  if (!spare) spare = new Float32Array(Math.max(FLOATS_PER_DOT * INITIAL_CAPACITY, positions.buf.length));
}

function wantsInline(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).has('inlineSim');
}

/** Creates the driver (idempotent: a second start keeps the one worker) and registers the
 *  per-tick listener and the idle callback (see flow control above). */
export function start(listener: (summary: TickSummary) => void, idle: () => void): void {
  onSummary = listener;
  onIdle = idle;
  if (driver) return;
  driver = wantsInline() ? null : createWorkerDriver(fallbackInline);
  if (!driver) driver = createInlineDriver();
}

/** Terminates the worker (or drops the inline sim). The next start() begins with no dots. */
export function stop(): void {
  onSummary = null;
  onIdle = null;
  driver?.dispose();
  driver = null;
  if (!spare) spare = new Float32Array(FLOATS_PER_DOT * INITIAL_CAPACITY);
}

export function getMode(): SimMode {
  return driver?.mode ?? 'inline';
}

/** The store's mesh fields changed identity: hand the sim the new snapshot (caches rebuild on
 *  identity exactly as they did when the loop read the store). Remembered for a fallback. */
export function setMesh(mesh: Mesh): void {
  lastMesh = mesh;
  driver?.setMesh(mesh);
}

/** A drag frame where only this card moved; cheaper than a snapshot and the same new
 *  `components` identity on the sim's side. */
export function moveComponent(id: string, x: number, y: number): void {
  if (lastMesh) lastMesh = { ...lastMesh, components: lastMesh.components.map(c => (c.id === id ? { ...c, x, y } : c)) };
  driver?.moveComponent(id, x, y);
}

/** Prestige: the run's dots are gone and dot ids restart (what performPrestige did). */
export function reset(): void {
  driver?.reset();
}

/** Debug/harness cap on inputs per second (0 = none; `window.__sim.setMaxTicksPerSec(n)`,
 *  `behavior.mjs --ticks=<n>`): a frame's input is held back until 1000/n ms have passed since
 *  the last one went out, so the frame deltas accumulate into fewer, longer inputs exactly as
 *  they do when the worker is slow (the sim still clamps each to MAX_FRAME_DT_MS). This is how
 *  the harness measures income per sim second against the tick rate (scale-plan.md Phase B).
 *  Frames held back count as busy in `stats` (their deltas merge into the next input). The
 *  slack absorbs RAF jitter so a cap that divides the frame rate (60/30/15) lands on exact
 *  frame multiples instead of skipping one now and then. */
let maxTicksPerSec = 0;
let lastInputAt = 0;
const TICK_CAP_SLACK_MS = 5;
export function setMaxTicksPerSec(n: number): void {
  maxTicksPerSec = Number.isFinite(n) && n > 0 ? n : 0;
}
export function getMaxTicksPerSec(): number {
  return maxTicksPerSec;
}

/** Whether an input may go out now. A stalled worker is replaced inline here. */
export function canTick(): boolean {
  if (!driver) return false;
  if (maxTicksPerSec > 0 && performance.now() - lastInputAt < 1000 / maxTicksPerSec - TICK_CAP_SLACK_MS) return false;
  if (driver.ready()) return true;
  // ready() may just have swapped a wedged worker for the inline driver, which is always ready.
  return driver.ready();
}

/** `late` marks an input sent from onIdle rather than from the frame that produced it. */
export function tick(input: SimInput, late = false): void {
  if (late) stats.inputsLate++;
  else stats.framesSent++;
  if (input.dtMs > MAX_FRAME_DT_MS) { stats.inputsClamped++; stats.clampLostMs += input.dtMs - MAX_FRAME_DT_MS; }
  if (input.dtMs > stats.maxInputDtMs) stats.maxInputDtMs = input.dtMs;
  lastInputAt = performance.now();
  driver?.tick(input);
}

/** A frame that could not send (the previous tick was still out); its input goes out from onIdle. */
export function noteBusyFrame(): void {
  stats.framesBusy++;
}

// Debug / harness hook, present in all builds like window.useGameStore: the dots live in the
// sim (possibly in the worker), so the perf scripts (scripts/perf/*.mjs) read them from here.
// `dots()` and `byStatus()` are asynchronous (a round trip to the worker); `liveDots()`,
// `liveEvents()` (a bundle dot stands for several events), `positions()` (entries of
// `floatsPerDot` floats, layout in positions.ts), `tickTiming()`, `summary()` and
// `ticksPerSec()` are the main thread's latest copies.
if (typeof window !== 'undefined') {
  (window as unknown as { __sim: unknown }).__sim = {
    mode: getMode,
    liveDots: () => latest?.liveDots ?? 0,
    liveEvents: () => latest?.liveEvents ?? 0,
    byStatus: () => driver ? driver.debug('byStatus') : Promise.resolve({}),
    dots: () => driver ? driver.debug('dots') : Promise.resolve([]),
    positions: getPositions,
    floatsPerDot: FLOATS_PER_DOT,
    tickTiming: getTickTiming,
    summary: latestSummary,
    ticksPerSec: getSimTicksPerSec,
    stats: () => ({ ...stats, sections: { ...stats.sections } }),
    /** Caps inputs per second (0 = none); see setMaxTicksPerSec. */
    setMaxTicksPerSec,
    maxTicksPerSec: getMaxTicksPerSec,
    /** Terminates the worker behind the bridge's back; the stall watchdog must fall back inline. */
    killWorker: () => { driver?.kill?.(); },
  };
}
