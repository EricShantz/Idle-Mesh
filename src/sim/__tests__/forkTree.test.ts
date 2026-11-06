// Fork tree (src/sim/forkTree.ts, scale-plan.md Phase F): every route of a fire is delivered
// exactly once, a mesh without bridges gets the one-level fork list it always had, and the relay
// accounting a dot carrying the tree produces (one charge per broker crossed, one per fork
// spawned there, the same for each fork from its spawn broker on) is one relay per link a broker
// fans out on. Dependency-free; the repo has no test runner:
//
//   npx tsc -b && node --test src/sim/__tests__/forkTree.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planForkTree, type ForkRoute } from '../forkTree.ts';
import type { ForkPath, ForkStep } from '../types.ts';

const route = (...nodeIds: string[]): ForkRoute => ({ waypoints: nodeIds.map((_, i) => ({ x: i, y: 0 })), nodeIds });
const forkFor = (r: ForkRoute, steps: ForkStep | undefined): ForkPath => ({ waypoints: r.waypoints, nodeIds: r.nodeIds, steps });
const isBroker = (id: string) => id.startsWith('B');
const plan = (routes: ForkRoute[]) => planForkTree(routes, routes[0].nodeIds.findIndex(isBroker), isBroker, forkFor);

/** The routes a dot carrying `step` along `nodeIds` delivers (itself plus every fork, recursively). */
function delivered(nodeIds: string[], step: ForkStep | undefined, out: string[] = []): string[] {
  out.push(nodeIds.join('>'));
  for (let st = step; st; st = st.next) for (const f of st.forks) delivered(f.nodeIds, f.steps, out);
  return out;
}

/** Relay charges per broker as sim.ts makes them: one when a dot crosses a broker's center (a
 *  fork starts AT its spawn broker, so from the next node on), one per fork spawned at a step. */
function relays(nodeIds: string[], step: ForkStep | undefined, from: number, counts: Record<string, number> = {}): Record<string, number> {
  for (let i = from; i < nodeIds.length; i++) if (isBroker(nodeIds[i])) counts[nodeIds[i]] = (counts[nodeIds[i]] ?? 0) + 1;
  for (let st = step; st; st = st.next) {
    for (const f of st.forks) {
      counts[st.nodeId] = (counts[st.nodeId] ?? 0) + 1;
      relays(f.nodeIds, f.steps, f.nodeIds.indexOf(st.nodeId) + 1, counts);
    }
  }
  return counts;
}

/** Links per broker: distinct next hops over all routes through it (what one copy per link costs). */
function links(routes: ForkRoute[]): Record<string, number> {
  const next = new Map<string, Set<string>>();
  for (const r of routes) for (let i = 0; i < r.nodeIds.length - 1; i++) {
    if (!isBroker(r.nodeIds[i])) continue;
    let s = next.get(r.nodeIds[i]);
    if (!s) { s = new Set(); next.set(r.nodeIds[i], s); }
    s.add(r.nodeIds[i + 1]);
  }
  return Object.fromEntries([...next].map(([id, s]) => [id, s.size]));
}

const stepList = (step: ForkStep | undefined) => { const out: ForkStep[] = []; for (let st = step; st; st = st.next) out.push(st); return out; };

test('single route: no steps', () => {
  const r = plan([route('P', 'B1', 'Q1', 'S')]);
  assert.equal(r.step, undefined);
  assert.equal(r.primary.nodeIds.join('>'), 'P>B1>Q1>S');
});

test('no bridges: one step at the first broker with the other routes as forks, in order', () => {
  const routes = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].map(q => route('P', 'B1', q, 'S'));
  const r = plan(routes);
  assert.equal(r.primary, routes[0]);
  const steps = stepList(r.step);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].nodeId, 'B1');
  assert.deepEqual(steps[0].forks.map(f => f.nodeIds), routes.slice(1).map(x => x.nodeIds));
  assert.ok(steps[0].forks.every(f => f.steps === undefined));
  assert.deepEqual(relays(r.primary.nodeIds, r.step, 0), { B1: 5 });
});

test('TIE fighter: one copy per bridge at the ingestion cluster, fan-out at the far clusters', () => {
  const routes: ForkRoute[] = [];
  for (const b of ['B2', 'B3']) for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) routes.push(route('P', 'B1', b, q, 'S'));
  const r = plan(routes);
  assert.equal(r.primary.nodeIds.join('>'), 'P>B1>B2>Q1>S');
  const steps = stepList(r.step);
  assert.deepEqual(steps.map(s => s.nodeId), ['B1', 'B2']);
  assert.equal(steps[0].forks.length, 1);
  assert.equal(steps[0].forks[0].nodeIds.join('>'), 'P>B1>B3>Q1>S');
  const b3 = stepList(steps[0].forks[0].steps);
  assert.deepEqual(b3.map(s => s.nodeId), ['B3']);
  assert.deepEqual(b3[0].forks.map(f => f.nodeIds[3]), ['Q2', 'Q3', 'Q4']);
  assert.deepEqual(steps[1].forks.map(f => f.nodeIds[3]), ['Q2', 'Q3', 'Q4']);
  assert.deepEqual(relays(r.primary.nodeIds, r.step, 0), { B1: 2, B2: 4, B3: 4 });
  assert.deepEqual(delivered(r.primary.nodeIds, r.step).sort(), routes.map(x => x.nodeIds.join('>')).sort());
});

test('mixed: a queue and a bridge off the same broker, either order', () => {
  const a = plan([route('P', 'B1', 'B2', 'Q1', 'S'), route('P', 'B1', 'B2', 'Q2', 'S'), route('P', 'B1', 'Q3', 'S')]);
  assert.equal(a.primary.nodeIds.join('>'), 'P>B1>B2>Q1>S');
  assert.deepEqual(stepList(a.step).map(s => [s.nodeId, s.forks.map(f => f.nodeIds.join('>'))]), [['B1', ['P>B1>Q3>S']], ['B2', ['P>B1>B2>Q2>S']]]);
  assert.deepEqual(relays(a.primary.nodeIds, a.step, 0), { B1: 2, B2: 2 });
  const b = plan([route('P', 'B1', 'Q3', 'S'), route('P', 'B1', 'B2', 'Q1', 'S'), route('P', 'B1', 'B2', 'Q2', 'S')]);
  assert.equal(b.primary.nodeIds.join('>'), 'P>B1>Q3>S');
  const steps = stepList(b.step);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].forks[0].nodeIds.join('>'), 'P>B1>B2>Q1>S');
  assert.deepEqual(stepList(steps[0].forks[0].steps).map(s => [s.nodeId, s.forks.map(f => f.nodeIds.join('>'))]), [['B2', ['P>B1>B2>Q2>S']]]);
  assert.deepEqual(relays(b.primary.nodeIds, b.step, 0), { B1: 2, B2: 2 });
});

test('bridge chain: no step at a broker the routes all pass through', () => {
  const r = plan([route('P', 'B1', 'B2', 'B3', 'Q1', 'S'), route('P', 'B1', 'B2', 'B3', 'Q2', 'S'), route('P', 'B1', 'Q9', 'S')]);
  assert.deepEqual(stepList(r.step).map(s => s.nodeId), ['B1', 'B3']);
  assert.deepEqual(relays(r.primary.nodeIds, r.step, 0), { B1: 2, B2: 1, B3: 2 });
});

test('random meshes: every route delivered once, one relay per link per broker', () => {
  let seed = 12345;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let trial = 0; trial < 300; trial++) {
    const seen = new Set<string>();
    const routes: ForkRoute[] = [];
    const n = 1 + rnd(12);
    for (let k = 0; k < n; k++) {
      // Bridge chains through distinct brokers (the path walk never revisits a node)
      const ids = ['P', 'B1'];
      const pool = ['B2', 'B3', 'B4'];
      const depth = rnd(3);
      for (let d = 0; d < depth; d++) ids.push(pool.splice(rnd(pool.length), 1)[0]);
      ids.push(`Q${1 + rnd(5)}`, 'S');
      // One route per queue per broker feeding it, as the publish plan dedups (two copies reaching
      // one queue over different bridges would each be relayed, which is not "one per link")
      const key = ids.slice(-3, -1).join('>');
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push(route(...ids));
    }
    const r = plan(routes);
    assert.deepEqual(delivered(r.primary.nodeIds, r.step).sort(), routes.map(x => x.nodeIds.join('>')).sort(), `trial ${trial}`);
    assert.deepEqual(relays(r.primary.nodeIds, r.step, 0), links(routes), `trial ${trial}`);
  }
});
