// Per-subscriber arrival index for the predictive release check (Pass 2 in sim.ts).
//
// The rule it answers, unchanged from the old per-candidate chain walk: a queued dot may be
// released toward a subscriber if, with its predicted arrival inserted into the ascending list
// of everything already heading there, (1) it arrives no earlier than the subscriber is free
// (`busyUntil` after the arrivals before it, seeded by the longest remaining consume of the
// dots already pausing there), and (2) nothing arriving after it collides: each later arrival
// must come no earlier than the previous one's `busyUntil`. The reference walk computed
// `busyUntil = max(t, busyUntil) + consumeDuration` over the sorted chain; it still is the
// reference, in `src/sim/__tests__/release.test.ts`.
//
// What makes it O(log n) per candidate: the chain only ever changes by insertion, and once the
// candidate at `t` is placed after the `k` arrivals ≤ t, condition (1) is `t ≥ busy[k]` (a
// prefix the candidate does not affect) and condition (2) reduces to `arrivals[k] ≥ t + D`
// for the next arrival and `arrivals[i] ≥ arrivals[i-1] + D` for every later pair — the
// latter is a property of the existing list alone (`lastBad`), independent of the candidate.
// The reference rejects on such a pre-existing collision too, whatever the candidate's `t`.
//
// Dependency-free on purpose (no sim types) so the unit test runs under `node --test`.

export type ArrivalIndex = {
  /** Longest remaining consume (ms) among dots already pausing at the subscriber; null when none. */
  pausingRemaining: number | null;
  /** Predicted arrival times (ms from now) of every dot heading to the subscriber next. Ascending
   *  once `finalizeArrivalIndex` ran; `insertArrival` keeps it so. */
  arrivals: number[];
  /** busy[i]: when the subscriber is free after the first i arrivals (busy[0] = pausingRemaining ?? 0). */
  busy: number[];
  /** Largest 1-based i ≥ 2 with arrivals[i-1] < arrivals[i-2] + consumeDuration (a collision that
   *  exists without any candidate), 0 when there is none. */
  lastBad: number;
};

export function createArrivalIndex(): ArrivalIndex {
  return { pausingRemaining: null, arrivals: [], busy: [0], lastBad: 0 };
}

/** Position after every arrival ≤ t. A candidate sorts after ties: the reference pushed it last
 *  and `Array.prototype.sort` is stable. */
function upperBound(a: number[], t: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Recompute busy[i] and lastBad for 1-based positions from `fromPos` on (the prefix before it is
 *  unchanged). Same arithmetic as the reference walk, in the same order. */
function rebuildFrom(idx: ArrivalIndex, fromPos: number, consumeDuration: number): void {
  const a = idx.arrivals;
  const busy = idx.busy;
  busy.length = a.length + 1;
  // A bad gap at position i involves arrivals i-1 and i; gaps before fromPos are untouched.
  let lastBad = idx.lastBad < fromPos ? idx.lastBad : 0;
  for (let i = fromPos; i <= a.length; i++) {
    const t = a[i - 1];
    busy[i] = Math.max(t, busy[i - 1]) + consumeDuration;
    if (i >= 2 && t < a[i - 2] + consumeDuration) lastBad = i;
  }
  idx.lastBad = lastBad;
}

/** Sort the arrivals pushed while the index was built and compute the prefix. Call once per tick
 *  per subscriber, after `pausingRemaining` is final and before the first check. */
export function finalizeArrivalIndex(idx: ArrivalIndex, consumeDuration: number): void {
  idx.arrivals.sort((x, y) => x - y);
  idx.busy[0] = idx.pausingRemaining ?? 0;
  idx.lastBad = 0;
  rebuildFrom(idx, 1, consumeDuration);
}

/** Add an arrival (a dot released this tick) to a finalized index, keeping it ascending. O(1) when
 *  it lands at the end, which same-tick releases from one queue do; O(n − pos) otherwise. */
export function insertArrival(idx: ArrivalIndex, t: number, consumeDuration: number): void {
  const pos = upperBound(idx.arrivals, t);
  idx.arrivals.splice(pos, 0, t);
  rebuildFrom(idx, pos + 1, consumeDuration);
}

/** Would a dot arriving at `t` neither collide nor make a later arrival collide? */
export function canAcceptArrival(idx: ArrivalIndex, t: number, consumeDuration: number): boolean {
  const a = idx.arrivals;
  const k = upperBound(a, t);
  // (1) the candidate itself lands while the subscriber is still busy with what came before it
  if (t < idx.busy[k]) return false;
  // (2a) the next arrival lands while the subscriber is busy with the candidate
  if (k < a.length && a[k] < t + consumeDuration) return false;
  // (2b) a collision further down the chain (the reference rejects on it after the candidate)
  return idx.lastBad <= k + 1;
}
