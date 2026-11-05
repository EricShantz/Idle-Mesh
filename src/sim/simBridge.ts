// Main-thread side of the simulation. In this phase the sim still runs inline (useGameLoop ticks
// it from requestAnimationFrame); this module holds what the UI and the store share with it:
// the one Sim instance, the publisher clicks waiting for the next tick, and the latest tick
// summary (read through simStats). The worker phase replaces the instance with a message port
// behind the same functions.
import { Sim, type TickSummary } from './sim';

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
