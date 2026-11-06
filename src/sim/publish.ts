// What a publisher emits per fire. Moved out of gameStore.ts: the simulation builds the dots
// itself (it owns the dot array), so this must work from a `Mesh` snapshot with no store.
import { normalizedSpeed } from '../utils/pathUtils';
import { computeOrthogonalWaypoints } from '../utils/orthogonalPath';
import { topicMatches } from '../utils/topicMatching';
import { getNodeHalfExtents } from '../store/upgradeConfig';
import {
  findNextInteractableId, firstBridgeExitNodeId, pathCrossesBridge, getQueueValueMultiplier,
  getPermanentSpeedMult, getEventValue, getAllPathsWithNodes, consumeDurationFor, BRIDGE_GOLD_COLOR, BRIDGE_VALUE_MULT,
} from './meshRules';
import { planForkTree, type ForkRoute } from './forkTree';
import type { EventDot, GameComponent, Connection, GlobalUpgrades, PrestigeState, Mesh, ForkPath, ForkStep } from './types';

let dotIdCounter = 0;
export function nextDotId() { return `dot-${++dotIdCounter}`; }
/** Prestige restarts dot ids from 1 (the dot array is cleared at the same time). */
export function resetDotIds() { dotIdCounter = 0; }

// What one publisher emits per fire, minus the per-dot identity: shared by every dot of a batch
// and by every fire until the mesh changes. Computing this used to walk the whole connection
// graph and do several components.find scans per path on every single fire (10/s per publisher).
export type PlannedDot = Pick<EventDot, 'path' | 'speed' | 'color' | 'value' | 'originalNodeIds' | 'nextNodeId' | 'bridgeGoldAfterNodeId' | 'forkStep'>;
/** `bundle`: the fire's dots carry count = fireCount (one dot per entry) instead of fireCount
 *  dots per entry; see routesBundleExact for when that is exact. */
export type PublishPlan = { fireCount: number; bundle: boolean; entries: PlannedDot[] };
type PublishPlanEntry = {
  componentsRef: GameComponent[];
  connectionsRef: Connection[];
  upgradesRef: GlobalUpgrades;
  prestigeRef: PrestigeState;
  plan: PublishPlan | null;
};
const publishPlanCache = new Map<string, PublishPlanEntry>();

export function getPublishPlan(mesh: Mesh, publisherId: string): PublishPlan | null {
  const cached = publishPlanCache.get(publisherId);
  if (cached && cached.componentsRef === mesh.components && cached.connectionsRef === mesh.connections &&
      cached.upgradesRef === mesh.upgrades && cached.prestigeRef === mesh.prestige) {
    return cached.plan;
  }
  const plan = computePublishPlan(mesh, publisherId);
  publishPlanCache.set(publisherId, {
    componentsRef: mesh.components, connectionsRef: mesh.connections,
    upgradesRef: mesh.upgrades, prestigeRef: mesh.prestige, plan,
  });
  return plan;
}

// Builds the dots one publisher fire emits, without committing anything. Returns null when the
// publisher can't fire at all (no outgoing connection, or no broker reachable to drop at), in
// which case nothing happens and the cooldown is not consumed — same as before the auto-publisher
// was batched. Shared by the manual click (via the bridge's pending fires) and the sim's
// auto-publisher poll.
export function buildPublishDots(mesh: Mesh, publisherId: string): { dots: EventDot[]; fireCount: number } | null {
  const plan = getPublishPlan(mesh, publisherId);
  if (!plan) return null;
  const dots: EventDot[] = [];
  const dotFor = (e: PlannedDot, progress: number, count: number): EventDot => ({
    id: nextDotId(),
    path: e.path,
    progress,
    speed: e.speed,
    progressPerMs: 0,
    speedUntilP: 1,
    count,
    status: 'traveling',
    color: e.color,
    opacity: 1,
    value: e.value,
    originalValue: e.value,
    originalNodeIds: e.originalNodeIds,
    nextNodeId: e.nextNodeId,
    forkStep: e.forkStep,
    bridgeGoldAfterNodeId: e.bridgeGoldAfterNodeId,
  });
  if (plan.bundle) {
    // The whole batch as one dot per entry (the plan decided that is exact for these routes).
    for (const e of plan.entries) dots.push(dotFor(e, 0, plan.fireCount));
  } else {
    for (let batch = 0; batch < plan.fireCount; batch++) {
      for (const e of plan.entries) dots.push(dotFor(e, batch * -0.04, 1));
    }
  }
  return { dots, fireCount: plan.fireCount };
}

function computePublishPlan(mesh: Mesh, publisherId: string): PublishPlan | null {
  const plan = computePublishEntries(mesh, publisherId);
  if (!plan) return null;
  return { ...plan, bundle: plan.fireCount > 1 && routesBundleExact(mesh, plan.entries) };
}

// Where a batch may travel as ONE dot carrying its count. It is exact wherever every rule the
// dot meets counts events: the broker cap takes `count` slots, a queue holds `count` slots, a
// 0 ms subscriber consumes `count` events the instant the dot arrives. Two rules are per dot, not
// per event, and there the batch keeps one dot per event as before: the occupied-webhook rule
// (a webhook with a batch inside it drops every following dot of that batch) and a timed
// subscriber (level < 11), which consumes one dot per consume duration — a bundle there would
// earn `count` events per consume. So every route of the fire, forks included, must cross no
// webhook and end at a 0 ms subscriber or at a queue whose subscribers are all 0 ms.
function routesBundleExact(mesh: Mesh, entries: PlannedDot[]): boolean {
  const byId = new Map<string, GameComponent>();
  for (const c of mesh.components) byId.set(c.id, c);
  const routeExact = (nodeIds: string[] | undefined): boolean => {
    if (!nodeIds || nodeIds.length === 0) return true;
    for (const id of nodeIds) if (byId.get(id)?.type === 'webhook') return false;
    const end = byId.get(nodeIds[nodeIds.length - 1]);
    if (!end) return true;
    if (end.type === 'subscriber') return consumeDurationFor(end) === 0;
    if (end.type === 'queue') {
      for (const conn of mesh.connections) {
        if (conn.fromId !== end.id) continue;
        const sub = byId.get(conn.toId);
        if (sub?.type === 'subscriber' && consumeDurationFor(sub) > 0) return false;
      }
    }
    return true;
  };
  const stepsExact = (step: ForkStep | undefined): boolean => {
    for (let st = step; st; st = st.next) {
      for (const f of st.forks) if (!routeExact(f.nodeIds) || !stepsExact(f.steps)) return false;
    }
    return true;
  };
  for (const e of entries) {
    if (!routeExact(e.originalNodeIds) || !stepsExact(e.forkStep)) return false;
  }
  return true;
}

function computePublishEntries(mesh: Mesh, publisherId: string): { fireCount: number; entries: PlannedDot[] } | null {
  const pub = mesh.components.find(c => c.id === publisherId);
  if (!pub) return null;
  const fireCount = mesh.upgrades.batchFire > 0 ? mesh.upgrades.batchFire : 1;
  const entries: PlannedDot[] = [];

  const allPaths = getAllPathsWithNodes(mesh.components, mesh.connections, publisherId);
  const allValidPaths = allPaths.filter(p => p.waypoints.length >= 2);
  if (allValidPaths.length === 0) {
    // No valid paths — fire event to the first connected node and let it drop there
    const directConn = mesh.connections.find(c => c.fromId === publisherId);
    if (!directConn) return null;
    const target = mesh.components.find(c => c.id === directConn.toId);
    if (!target) return null;
    // Build path using node centers, then expand orthogonally with bounds
    const nodePath = [{ x: pub.x, y: pub.y }, { x: target.x, y: target.y }];
    const truncatedWaypoints: { x: number; y: number }[] = [nodePath[0]];
    if (Math.abs(nodePath[0].y - nodePath[1].y) >= 10) {
      const { halfW: pubHalfW, halfH: pubHalfH } = getNodeHalfExtents(pub);
      const { halfW: tgtHalfW, halfH: tgtHalfH } = getNodeHalfExtents(target);
      const portStartX = pub.x + pubHalfW + 24;
      const portEndX = target.x - tgtHalfW - 2;
      const fromBounds = {
        left: pub.x - pubHalfW,
        right: pub.x + pubHalfW + 24,
        top: pub.y - pubHalfH,
        bottom: pub.y + pubHalfH,
      };
      const toBounds = {
        left: target.x - tgtHalfW,
        right: target.x + tgtHalfW,
        top: target.y - tgtHalfH,
        bottom: target.y + tgtHalfH,
      };
      const segWaypoints = computeOrthogonalWaypoints(portStartX, pub.y, portEndX, target.y, fromBounds, toBounds);
      for (let w = 1; w < segWaypoints.length - 1; w++) {
        truncatedWaypoints.push(segWaypoints[w]);
      }
    }
    truncatedWaypoints.push(nodePath[1]);
    const baseValue = getEventValue(mesh, publisherId);
    const bridgeExitNodeId = firstBridgeExitNodeId([publisherId, target.id], mesh.components);
    const queueMult = getQueueValueMultiplier([publisherId, target.id], mesh.components);
    const value = (bridgeExitNodeId ? baseValue * BRIDGE_VALUE_MULT : baseValue) * queueMult;
    const speed = normalizedSpeed(0.0007 * mesh.upgrades.propagationSpeed * getPermanentSpeedMult(mesh), truncatedWaypoints);
    entries.push({
      path: truncatedWaypoints,
      speed,
      color: '#22d3ee',
      value,
      originalNodeIds: [publisherId, target.id],
      nextNodeId: findNextInteractableId([publisherId, target.id], mesh.components),
      bridgeGoldAfterNodeId: bridgeExitNodeId,
    });
    return { fireCount, entries };
  }

  // Topic filtering: only keep paths where the queue's subscription matches the publisher's topic
  const pubTopic = pub.topic;
  const validPaths = pubTopic
    ? allValidPaths.filter(p => {
      const queueId = p.nodeIds.find(id =>
        mesh.components.find(c => c.id === id)?.type === 'queue');
      if (!queueId) return true; // no queue in path, allow
      const queue = mesh.components.find(c => c.id === queueId);
      return !queue?.subscriptionTopic || topicMatches(pubTopic, queue.subscriptionTopic);
    })
    : allValidPaths;
  if (validPaths.length === 0) {
    // No matching queues — create a dot that travels to the broker and drops there
    // Find any path that reaches a broker
    const anyPath = allValidPaths[0];
    if (!anyPath) return null;
    const brokerIdx = anyPath.nodeIds.findIndex(id =>
      mesh.components.find(c => c.id === id)?.type === 'broker');
    if (brokerIdx < 0) return null;
    const broker = mesh.components.find(c => c.id === anyPath.nodeIds[brokerIdx])!;
    // Build a truncated path: publisher → broker left edge
    const brokerLeftEdge = { x: broker.x - 62, y: broker.y };
    // Find the last waypoint before the broker and append the edge point
    const truncatedWaypoints = [anyPath.waypoints[0]];
    for (const wp of anyPath.waypoints.slice(1)) {
      if (Math.abs(wp.x - broker.x) < 80 && Math.abs(wp.y - broker.y) < 40) break;
      truncatedWaypoints.push(wp);
    }
    truncatedWaypoints.push(brokerLeftEdge);
    const truncatedNodeIds = anyPath.nodeIds.slice(0, brokerIdx + 1);

    const baseValue = getEventValue(mesh, publisherId);
    const bridgeExitNodeId = firstBridgeExitNodeId(truncatedNodeIds, mesh.components);
    const queueMult = getQueueValueMultiplier(truncatedNodeIds, mesh.components);
    const value = (bridgeExitNodeId ? baseValue * BRIDGE_VALUE_MULT : baseValue) * queueMult;
    const speed = normalizedSpeed(0.0007 * mesh.upgrades.propagationSpeed * getPermanentSpeedMult(mesh), truncatedWaypoints);
    entries.push({
      path: truncatedWaypoints,
      speed,
      color: '#22d3ee',
      value,
      originalNodeIds: truncatedNodeIds,
      nextNodeId: findNextInteractableId(truncatedNodeIds, mesh.components),
      bridgeGoldAfterNodeId: bridgeExitNodeId,
    });
    return { fireCount, entries };
  }

  // Broker fan-out: send to ALL matching queues (one path per unique queue per broker)
  // Group paths by their broker (the node before the queue where paths diverge)
  const selectedPaths: typeof validPaths = [];
  const groupedByBroker = new Map<string, typeof validPaths>();

  for (const p of validPaths) {
    const queueNode = p.nodeIds.find(id => mesh.components.find(c => c.id === id)?.type === 'queue');
    if (!queueNode) {
      // No queue in path (e.g. direct broker→subscriber), always include
      selectedPaths.push(p);
      continue;
    }
    // Find the node before the queue (the broker) as the grouping key
    const queueIdx = p.nodeIds.indexOf(queueNode);
    const brokerId = queueIdx > 0 ? p.nodeIds[queueIdx - 1] : 'none';
    if (!groupedByBroker.has(brokerId)) groupedByBroker.set(brokerId, []);
    groupedByBroker.get(brokerId)!.push(p);
  }

  // Broker fans out to ALL matching queues (real EDA behavior).
  // Deduplicate so we get one path per unique queue.
  for (const [, group] of groupedByBroker) {
    const seen = new Set<string>();
    for (const p of group) {
      const queueId = p.nodeIds.find(id => mesh.components.find(c => c.id === id)?.type === 'queue');
      if (!queueId) { selectedPaths.push(p); continue; }
      if (!seen.has(queueId)) {
        seen.add(queueId);
        selectedPaths.push(p);
      }
    }
  }

  const baseValue = getEventValue(mesh, publisherId);
  const baseSpeed = 0.0007 * mesh.upgrades.propagationSpeed * getPermanentSpeedMult(mesh);
  const valueForPath = (nodeIds: string[]) => {
    const bridgeMult = pathCrossesBridge(nodeIds, mesh.components) ? BRIDGE_VALUE_MULT : 1;
    const queueMult = getQueueValueMultiplier(nodeIds, mesh.components);
    return baseValue * bridgeMult * queueMult;
  };
  const colorForPath = (nodeIds: string[]) =>
    pathCrossesBridge(nodeIds, mesh.components) ? BRIDGE_GOLD_COLOR : '#22d3ee';

  // Group selected paths by their first broker so we create one dot per broker fork point
  const forkGroups = new Map<string, typeof selectedPaths>();
  for (const p of selectedPaths) {
    // Find first broker in the path (index 1 is typically the broker after publisher)
    const firstBrokerId = p.nodeIds.find(id =>
      mesh.components.find(c => c.id === id)?.type === 'broker') ?? 'none';
    if (!forkGroups.has(firstBrokerId)) forkGroups.set(firstBrokerId, []);
    forkGroups.get(firstBrokerId)!.push(p);
  }

  // One dot per group. Where the group's routes diverge along it, the dot (and each copy it
  // spawns) carries fork steps (forkTree.ts): one copy per other next hop at each broker, so a
  // bridged cluster relays one copy per link and the far cluster fans out by itself. A group
  // with no broker on its routes has nowhere to fork: its first route travels alone, as before.
  const byId = new Map<string, GameComponent>();
  for (const c of mesh.components) byId.set(c.id, c);
  const isBroker = (id: string) => byId.get(id)?.type === 'broker';
  const forkFor = (r: ForkRoute, steps: ForkStep | undefined): ForkPath =>
    ({ waypoints: r.waypoints, nodeIds: r.nodeIds, value: valueForPath(r.nodeIds), color: colorForPath(r.nodeIds), steps });
  for (const [brokerId, group] of forkGroups) {
    const { primary, step } = brokerId !== 'none'
      ? planForkTree(group, group[0].nodeIds.indexOf(brokerId), isBroker, forkFor)
      : { primary: group[0], step: undefined };
    entries.push({
      path: primary.waypoints,
      speed: normalizedSpeed(baseSpeed, primary.waypoints),
      color: '#22d3ee',
      value: valueForPath(primary.nodeIds),
      originalNodeIds: primary.nodeIds,
      nextNodeId: findNextInteractableId(primary.nodeIds, mesh.components),
      forkStep: step,
      bridgeGoldAfterNodeId: firstBridgeExitNodeId(primary.nodeIds, mesh.components),
    });
  }
  return entries.length > 0 ? { fireCount, entries } : null;
}
