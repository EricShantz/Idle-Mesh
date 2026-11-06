// Where a fire's routes diverge. A publisher's routes are grouped by their first broker (one dot
// per group, see publish.ts); within a group this builds the tree of fork points the dot carries:
// at each broker along its route, one fork per OTHER next hop the group's routes take from that
// broker, and each fork carries the same for its own routes further on. So a cluster relays one
// copy per link it fans out on (one per bridge, one per queue) and the cluster at the far end of
// a bridge does its own fan-out — real DMR relay accounting (scale-plan.md Phase F) — instead of
// every copy being spawned, and charged, at the first broker. Routes never share a next hop that
// is a queue or subscriber (one route per queue per broker after dedup, and routes end there), so
// a mesh without bridges gets exactly one step, at the first broker, with the group's other routes
// as its forks in route order: what the one-level fork list was.
import type { ForkPath, ForkStep } from './types';

export type ForkRoute = { waypoints: { x: number; y: number }[]; nodeIds: string[] };

/** The route the group's own dot follows and the head of its fork-step list. `routes` share
 *  nodeIds[0..i] and nodeIds[i] is a broker; `isBroker` tells which node ids are brokers;
 *  `forkFor` makes the ForkPath for a route (its value and color are route-specific). Partitions
 *  are in order of first appearance, so the primary is the first route's and forks keep route
 *  order. */
export function planForkTree(
  routes: ForkRoute[], i: number, isBroker: (id: string) => boolean,
  forkFor: (route: ForkRoute, steps: ForkStep | undefined) => ForkPath,
): { primary: ForkRoute; step: ForkStep | undefined } {
  if (routes.length === 1) return { primary: routes[0], step: undefined };
  const partitions = new Map<string, ForkRoute[]>();
  for (const r of routes) {
    const key = r.nodeIds[i + 1] ?? '';
    const part = partitions.get(key);
    if (part) part.push(r); else partitions.set(key, [r]);
  }
  const forks: ForkPath[] = [];
  let primary = routes[0];
  let later: ForkStep | undefined;
  let first = true;
  for (const [nextId, part] of partitions) {
    // Routes that continue to another broker diverge, if at all, at that broker or beyond: one
    // copy goes there and forks on arrival. Any other shared next hop (a queue or subscriber,
    // where routes end) cannot diverge later, so extra routes there fork at this broker.
    const continues = nextId !== '' && isBroker(nextId);
    if (first) {
      first = false;
      if (continues) {
        const sub = planForkTree(part, i + 1, isBroker, forkFor);
        primary = sub.primary;
        later = sub.step;
      } else {
        primary = part[0];
        for (let k = 1; k < part.length; k++) forks.push(forkFor(part[k], undefined));
      }
    } else if (continues) {
      const sub = planForkTree(part, i + 1, isBroker, forkFor);
      forks.push(forkFor(sub.primary, sub.step));
    } else {
      for (const r of part) forks.push(forkFor(r, undefined));
    }
  }
  return { primary, step: forks.length > 0 ? { nodeId: routes[0].nodeIds[i], forks, next: later } : later };
}
