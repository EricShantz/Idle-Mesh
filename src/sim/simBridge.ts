// Main-thread side of the simulation. In this phase the sim still runs inline (useGameLoop ticks
// it from requestAnimationFrame); this module holds what the UI and the store share with it:
// the one Sim instance, the publisher clicks waiting for the next tick, the latest tick
// summary (read through simStats) and the position buffer the canvas draws from. The worker
// phase replaces the instance with a message port behind the same functions.
import { Sim, type TickSummary } from './sim';
import { FLOATS_PER_DOT } from './positions';

export const sim = new Sim();

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

export function publishSummary(summary: TickSummary): void {
  latest = summary;
}

export function latestSummary(): TickSummary | null {
  return latest;
}

// Two position buffers (layout in positions.ts): the canvas draws `front`, the sim fills `back`,
// and fillPositions swaps them. Two so the worker phase can ping-pong them as transferables;
// the buffer the canvas holds is never written while it is being drawn.
const INITIAL_CAPACITY = 4096; // dots
let front = new Float32Array(FLOATS_PER_DOT * INITIAL_CAPACITY);
let back = new Float32Array(FLOATS_PER_DOT * INITIAL_CAPACITY);
const positions = { buf: front, count: 0 };

/** Writes the sim's current dots into the free buffer and makes it the one the canvas reads.
 *  The buffer grows (x1.5, like the old vertex array) when the dot count outgrows it. */
export function fillPositions(): void {
  const dots = sim.getDots().length;
  if (back.length < dots * FLOATS_PER_DOT) back = new Float32Array(Math.ceil(dots * 1.5) * FLOATS_PER_DOT);
  const count = sim.fillPositions(back);
  const drawn = front;
  front = back;
  back = drawn;
  positions.buf = front;
  positions.count = count;
}

/** The latest filled buffer and how many FLOATS_PER_DOT entries it holds (same object every
 *  call; valid until the next fillPositions). */
export function getPositions(): { buf: Float32Array; count: number } {
  return positions;
}

// Debug / harness hook, present in all builds like window.useGameStore: the dots left the store,
// so the perf scripts (scripts/perf/*.mjs) read live-dot counts and the dot objects from here.
if (typeof window !== 'undefined') {
  (window as unknown as { __sim: unknown }).__sim = {
    liveDots: () => sim.getDots().length,
    byStatus: () => {
      const by: Record<string, number> = {};
      for (const d of sim.getDots()) by[d.status] = (by[d.status] ?? 0) + 1;
      return by;
    },
    dots: () => sim.getDots(),
    positions: getPositions,
    summary: latestSummary,
  };
}
