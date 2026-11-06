// Equivalence test for the sorted arrival index (src/sim/releaseIndex.ts) against the chain walk
// it replaced in shouldReleaseTo (sim.ts Pass 2). Dependency-free; the repo has no test runner:
//
//   npx tsc -b && node --test src/sim/__tests__/release.test.ts
//
// (Node 24 strips the types itself.) Random arrival sets with ties, both halves of the rule
// (the candidate collides / a later arrival collides), consume durations 0 and > 0, and
// insertions mid-tick at the end and in the middle of the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArrivalIndex, finalizeArrivalIndex, insertArrival, canAcceptArrival } from '../releaseIndex.ts';
import type { ArrivalIndex } from '../releaseIndex.ts';

/** The old shouldReleaseTo chain, verbatim: the reference. */
function referenceCanRelease(pausingRemaining: number | null, arrivals: number[], travelTime: number, consumeDuration: number): boolean {
  const chain = arrivals.map(t => ({ t, candidate: false }));
  chain.push({ t: travelTime, candidate: true });
  chain.sort((a, b) => a.t - b.t);
  let busyUntil = pausingRemaining ?? 0;
  let candidateSeen = false;
  for (const { t, candidate } of chain) {
    if (candidate) {
      if (t < busyUntil) return false;
      candidateSeen = true;
    } else if (candidateSeen && t < busyUntil) {
      return false;
    }
    busyUntil = Math.max(t, busyUntil) + consumeDuration;
  }
  return true;
}

/** Which half of the rule rejected (for coverage counting); null when accepted. */
function referenceReason(pausingRemaining: number | null, arrivals: number[], travelTime: number, consumeDuration: number): 'candidate' | 'later' | null {
  const chain = arrivals.map(t => ({ t, candidate: false }));
  chain.push({ t: travelTime, candidate: true });
  chain.sort((a, b) => a.t - b.t);
  let busyUntil = pausingRemaining ?? 0;
  let candidateSeen = false;
  for (const { t, candidate } of chain) {
    if (candidate) {
      if (t < busyUntil) return 'candidate';
      candidateSeen = true;
    } else if (candidateSeen && t < busyUntil) {
      return 'later';
    }
    busyUntil = Math.max(t, busyUntil) + consumeDuration;
  }
  return null;
}

// Deterministic PRNG (mulberry32) so a failure reproduces.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DURATIONS = [0, 1, 50, 100, 250, 1000];

/** Arrival times with deliberate ties (integers) and a few fractional values. */
function randomArrivals(r: () => number, n: number, span: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(r() < 0.8 ? Math.floor(r() * span) : r() * span);
  return out;
}

/** Candidate times worth checking against a list: random, exact ties, and the busy boundaries. */
function candidateTimes(r: () => number, arrivals: number[], pausingRemaining: number | null, d: number, span: number): number[] {
  const ts: number[] = [];
  for (let i = 0; i < 12; i++) ts.push(r() < 0.7 ? Math.floor(r() * span) : r() * span);
  for (const a of arrivals) { ts.push(a); ts.push(a - d); ts.push(a + d); ts.push(a - 1); ts.push(a + 1); }
  if (pausingRemaining !== null) { ts.push(pausingRemaining); ts.push(pausingRemaining - 1); }
  ts.push(0, -1, span * 2);
  // exact busy boundaries from the reference prefix
  const sorted = [...arrivals].sort((x, y) => x - y);
  let busy = pausingRemaining ?? 0;
  for (const a of sorted) { busy = Math.max(a, busy) + d; ts.push(busy, busy - 1, busy + 1); }
  return ts;
}

function buildIndex(pausingRemaining: number | null, arrivals: number[], d: number): ArrivalIndex {
  const idx = createArrivalIndex();
  idx.pausingRemaining = pausingRemaining;
  // pushed in the (unsorted) order the index loop would push them
  for (const a of arrivals) idx.arrivals.push(a);
  finalizeArrivalIndex(idx, d);
  return idx;
}

function assertSorted(idx: ArrivalIndex): void {
  for (let i = 1; i < idx.arrivals.length; i++) assert.ok(idx.arrivals[i - 1] <= idx.arrivals[i], 'arrivals ascending');
}

test('canAcceptArrival matches the reference chain walk over random arrival sets', () => {
  const r = rng(20261105);
  const reasons = { candidate: 0, later: 0, accepted: 0 };
  let checks = 0;
  for (let trial = 0; trial < 4000; trial++) {
    const d = DURATIONS[trial % DURATIONS.length];
    const n = Math.floor(r() * 12);
    const span = [20, 200, 2000][trial % 3];
    const arrivals = randomArrivals(r, n, span);
    const pausingRemaining = r() < 0.4 ? null : (r() < 0.5 ? Math.floor(r() * span) : r() * span);
    const idx = buildIndex(pausingRemaining, arrivals, d);
    assertSorted(idx);
    for (const t of candidateTimes(r, arrivals, pausingRemaining, d, span)) {
      const expected = referenceCanRelease(pausingRemaining, arrivals, t, d);
      const got = canAcceptArrival(idx, t, d);
      assert.equal(got, expected, `trial ${trial} d=${d} P=${pausingRemaining} arrivals=[${arrivals}] t=${t}`);
      const why = referenceReason(pausingRemaining, arrivals, t, d);
      if (why) reasons[why]++; else reasons.accepted++;
      checks++;
    }
  }
  // both halves of the rule and the accept path were all exercised
  assert.ok(reasons.candidate > 1000, `candidate rejections: ${reasons.candidate}`);
  assert.ok(reasons.later > 1000, `later-arrival rejections: ${reasons.later}`);
  assert.ok(reasons.accepted > 1000, `accepts: ${reasons.accepted}`);
  assert.ok(checks > 100000, `checks: ${checks}`);
});

test('a 0 ms consume never rejects (the fast path in shouldReleaseTo is exact)', () => {
  const r = rng(7);
  for (let trial = 0; trial < 500; trial++) {
    const arrivals = randomArrivals(r, Math.floor(r() * 10), 500);
    const pausingRemaining = r() < 0.5 ? null : r() * 500;
    const idx = buildIndex(pausingRemaining, arrivals, 0);
    for (const t of candidateTimes(r, arrivals, pausingRemaining, 0, 500)) {
      // the reference can still reject a candidate that would land before a pausing dot finishes;
      // with a 0 ms consume `pausingRemaining` is always 0 in the sim, so the fast path is exact
      // only under that condition — assert that, not an unconditional true.
      const expected = referenceCanRelease(pausingRemaining, arrivals, t, 0);
      assert.equal(canAcceptArrival(idx, t, 0), expected);
      if (pausingRemaining === null || pausingRemaining === 0) assert.equal(expected, !(t < 0));
    }
  }
});

test('insertArrival keeps the index equal to a fresh finalize and the checks equal to the reference', () => {
  const r = rng(99);
  let midInserts = 0, endInserts = 0;
  for (let trial = 0; trial < 2000; trial++) {
    const d = DURATIONS[trial % DURATIONS.length];
    const span = [50, 500][trial % 2];
    const arrivals = randomArrivals(r, Math.floor(r() * 8), span);
    const pausingRemaining = r() < 0.5 ? null : Math.floor(r() * span);
    const idx = buildIndex(pausingRemaining, arrivals, d);
    const live = [...arrivals];
    // several releases this tick: later-than-everything (the common case) and mid-list
    for (let k = 0; k < 6; k++) {
      const max = live.length ? Math.max(...live) : 0;
      const t = r() < 0.5 ? max + Math.floor(r() * 100) : Math.floor(r() * span);
      if (live.length && t < max) midInserts++; else endInserts++;
      insertArrival(idx, t, d);
      live.push(t);
      assertSorted(idx);
      const fresh = buildIndex(pausingRemaining, live, d);
      assert.deepEqual(idx.arrivals, fresh.arrivals);
      assert.deepEqual(idx.busy, fresh.busy);
      assert.equal(idx.lastBad, fresh.lastBad, `trial ${trial} d=${d} live=[${live}]`);
      for (const c of candidateTimes(r, live, pausingRemaining, d, span)) {
        assert.equal(canAcceptArrival(idx, c, d), referenceCanRelease(pausingRemaining, live, c, d), `trial ${trial} d=${d} P=${pausingRemaining} live=[${live}] t=${c}`);
      }
    }
  }
  assert.ok(midInserts > 500, `mid-list inserts: ${midInserts}`);
  assert.ok(endInserts > 500, `end inserts: ${endInserts}`);
});

test('an empty index accepts exactly what the reference accepts', () => {
  const idx = createArrivalIndex();
  for (const d of DURATIONS) {
    for (const t of [-5, -0.5, 0, 0.5, 10, 1e6]) {
      assert.equal(canAcceptArrival(idx, t, d), referenceCanRelease(null, [], t, d));
    }
  }
});
