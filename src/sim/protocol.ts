// The messages between the main thread (simBridge.ts) and the simulation worker
// (sim.worker.ts). Type-only: the worker entry must never be imported as a module by the main
// bundle, so both sides share these shapes through this file instead.
import type { Mesh, EventDot } from './types';
import type { SimInput, TickSummary, TickSections } from './sim';

/** Harness/debug queries (window.__sim); answered asynchronously because the dots live in the worker. */
export type DebugQuery = 'dots' | 'byStatus';
export type DebugResult = EventDot[] | Record<string, number>;

export type MainToWorker =
  /** The store's components/connections/upgrades/prestige changed identity: replace the snapshot. */
  | { type: 'mesh'; mesh: Mesh }
  /** A drag frame: only this card moved (Sim.moveComponent patches the snapshot). */
  | { type: 'move'; id: string; x: number; y: number }
  /** One tick's worth of input plus the free position buffer (transferred; the worker fills and returns it). */
  | { type: 'input'; input: SimInput; buffer: ArrayBuffer }
  /** Prestige: dots cleared, dot ids restart. */
  | { type: 'reset' }
  | { type: 'debug'; id: number; what: DebugQuery };

export type WorkerToMain =
  /** Sent the moment an input is picked up, before the tick runs: proof the worker is alive even
   *  when the tick itself takes seconds (the bridge's stall watchdog waits for this, not for the tick). */
  | { type: 'busy' }
  /** The tick's summary and the filled position buffer (transferred) with its entry count;
   *  tickMs is how long the tick + fill took on the worker (for the harness' stats). */
  | { type: 'tick'; summary: TickSummary; buffer: ArrayBuffer; count: number; tickMs: number; sections: TickSections }
  | { type: 'debug'; id: number; result: DebugResult };
