// The simulation worker: one Sim instance behind a message port. Everything here is plumbing;
// the rules are in sim.ts and run identically inline (see simBridge.ts for the fallback). The
// bridge never has more than one `input` in flight — it accumulates the frame delta until the
// previous tick has returned — so each input is ticked as it arrives; there is nothing to
// coalesce on this side. The position buffer ping-pongs: it arrives with the input, is filled
// right after the tick (same Sim, so the pausing shrink uses that tick's clock) and goes back
// with the summary. It is grown here when the dot count outgrows it.
import { Sim } from './sim';
import { FLOATS_PER_DOT } from './positions';
import type { MainToWorker, WorkerToMain, DebugResult } from './protocol';
import type { EventDot } from './types';

// tsconfig uses the DOM lib (the app is one project), so `self` is typed as a Window; this is
// the slice of DedicatedWorkerGlobalScope the entry uses.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<MainToWorker>) => void) | null;
  postMessage(msg: WorkerToMain, transfer?: Transferable[]): void;
};

const sim = new Sim();

function byStatusOf(dots: EventDot[]): Record<string, number> {
  const by: Record<string, number> = {};
  for (const d of dots) by[d.status] = (by[d.status] ?? 0) + 1;
  return by;
}

ctx.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'mesh':
      sim.setMesh(msg.mesh);
      break;
    case 'move':
      sim.moveComponent(msg.id, msg.x, msg.y);
      break;
    case 'reset':
      sim.reset();
      break;
    case 'input': {
      const t0 = performance.now();
      const summary = sim.tick(msg.input);
      const dots = sim.getDots().length;
      let buf = new Float32Array(msg.buffer);
      if (buf.length < dots * FLOATS_PER_DOT) buf = new Float32Array(Math.ceil(dots * 1.5) * FLOATS_PER_DOT);
      const count = sim.fillPositions(buf);
      ctx.postMessage({ type: 'tick', summary, buffer: buf.buffer, count, tickMs: performance.now() - t0 }, [buf.buffer]);
      break;
    }
    case 'debug': {
      const result: DebugResult = msg.what === 'dots' ? sim.getDots() : byStatusOf(sim.getDots());
      ctx.postMessage({ type: 'debug', id: msg.id, result });
      break;
    }
  }
};
