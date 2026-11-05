// Store-free rules over the mesh snapshot: route helpers, prestige multipliers, event value and
// the publisher path walk. Moved verbatim out of gameStore.ts (which re-exports them) so the
// simulation can run without a store; functions that took `state` take the `Mesh` fields they
// actually read (`{ prestige }` is structurally satisfied by the full store state too).
import { computeOrthogonalWaypoints } from '../utils/orthogonalPath';
import { getNodeHalfExtents } from '../store/upgradeConfig';
import type { GameComponent, Connection, PrestigeState, Mesh } from './types';

/** Find the first queue or subscriber ID in a route's node list. */
export function findNextInteractableId(nodeIds: string[], components: GameComponent[]): string | undefined {
  for (const id of nodeIds) {
    const c = components.find(comp => comp.id === id);
    if (c && (c.type === 'queue' || c.type === 'subscriber')) return id;
  }
  return undefined;
}

/** The node right before the first broker-to-broker bridge hop on a route, if any. */
export function firstBridgeExitNodeId(nodeIds: string[], components: GameComponent[]): string | undefined {
  for (let i = 0; i < nodeIds.length - 1; i++) {
    const a = components.find(c => c.id === nodeIds[i]);
    const b = components.find(c => c.id === nodeIds[i + 1]);
    if (a?.type === 'broker' && b?.type === 'broker') return nodeIds[i];
  }
  return undefined;
}

/** True if a route's node list crosses a broker-to-broker bridge connection anywhere. */
export function pathCrossesBridge(nodeIds: string[], components: GameComponent[]): boolean {
  return firstBridgeExitNodeId(nodeIds, components) !== undefined;
}

export const BRIDGE_GOLD_COLOR = '#fde047';
export const BRIDGE_VALUE_MULT = 1.5;

/** Value bonus earned per queue a route passes through on its way to a subscriber. */
export const QUEUE_VALUE_BONUS_PER_HOP = 0.05;

/** Multiplier for the number of queue hops in a route's node list (1 + 5% per queue). */
export function getQueueValueMultiplier(nodeIds: string[], components: GameComponent[]): number {
  const queueHops = nodeIds.filter(id => components.find(c => c.id === id)?.type === 'queue').length;
  return 1 + queueHops * QUEUE_VALUE_BONUS_PER_HOP;
}

type WithPrestige = { prestige: PrestigeState };

// Permanent prestige speed multiplier (count of purchased speed nodes)
export function getPermanentSpeedMult(state: WithPrestige): number {
  const p = state.prestige.permanentUpgradeLevels;
  const speedNodes = ['globalSpeed1', 'globalSpeed2'].filter(k => (p[k] ?? 0) > 0).length;
  return 1 + speedNodes * 0.15;
}

// Permanent prestige cost reduction
export function getPermanentCostReduction(state: WithPrestige): number {
  return (state.prestige.permanentUpgradeLevels['globalCostRed'] ?? 0) > 0 ? 0.10 : 0;
}

// Permanent shop discount
export function getPermanentShopDiscount(state: WithPrestige): number {
  return (state.prestige.permanentUpgradeLevels['globalShopDiscount'] ?? 0) > 0 ? 0.15 : 0;
}

// Permanent value boost (count of purchased value nodes × $0.50)
export function getPermanentValueBoost(state: WithPrestige): number {
  const p = state.prestige.permanentUpgradeLevels;
  const valueNodes = ['subValue1', 'subValue2'].filter(k => (p[k] ?? 0) > 0).length;
  return valueNodes * 0.50;
}

// Permanent publisher rate multiplier (pubRoot)
export function getPermanentPubRateMult(state: WithPrestige): number {
  return (state.prestige.permanentUpgradeLevels['pubRoot'] ?? 0) > 0 ? 1.2 : 1.0;
}

// Permanent subscriber payout multiplier (subRoot)
export function getPermanentSubPayoutMult(state: WithPrestige): number {
  return (state.prestige.permanentUpgradeLevels['subRoot'] ?? 0) > 0 ? 1.25 : 1.0;
}

// Permanent broker throughput cap multiplier (brokerRouting) — stacks on top of
// whatever level the broker's "Increase Throughput" shop upgrade is at.
export function getPermanentBrokerThroughputMult(state: WithPrestige): number {
  return (state.prestige.permanentUpgradeLevels['brokerRouting'] ?? 0) > 0 ? 1.25 : 1.0;
}

// Permanent queue buffer bonus (queueRoot + queueBuffer)
export function getPermanentQueueBufferBonus(state: WithPrestige): number {
  const p = state.prestige.permanentUpgradeLevels;
  return ((p['queueRoot'] ?? 0) > 0 ? 2 : 0) + ((p['queueBuffer'] ?? 0) > 0 ? 4 : 0);
}

// Publisher network effect: each purchased publisher is permanently assigned a tier at
// purchase time (1st purchased = tier 1, 2nd = tier 2, ...), set once in addComponent via
// upgrades.networkTier. Each tier adds another 10 percentage points to that publisher's
// own base event value (tier 1 = +10%, tier 2 = +20%, tier 3 = +30%, ...), so the Nth
// publisher you buy produces events worth 10% more than the (N-1)th. This only ever pays
// off through that specific publisher's own events, so a publisher that never fires (e.g.
// unconnected) simply never realizes the bonus — no separate "is it connected" check needed.
export function getPublisherTierMultiplier(tier: number | undefined): number {
  if (!tier) return 1;
  return 1 + tier * 0.1;
}

/** Wall-clock milliseconds between fires for a publisher at its current publishSpeed level. */
export function getPublisherCooldownMs(pub: { upgrades: Record<string, number> }, state: WithPrestige): number {
  const publishSpeedLevel = pub.upgrades['publishSpeed'] ?? 0;
  const baseCooldown = 1000; // 1 second base cooldown
  const publishBoostPct = publishSpeedLevel * (publishSpeedLevel + 9) / 2;
  return baseCooldown * (1 - publishBoostPct / 100) / getPermanentPubRateMult(state);
}

/** Base value of one event from a publisher (its eventValue level, prestige value boost and
 *  network tier). The store's `getEventValue` delegates here. */
export function getEventValue(mesh: Pick<Mesh, 'components' | 'prestige'>, publisherId: string): number {
  const pub = mesh.components.find(c => c.id === publisherId);
  if (!pub) return 0.5;
  const valueLevel = pub.upgrades['eventValue'] ?? 0;
  const base = 1.0 + valueLevel * 0.45 + valueLevel * valueLevel * 0.05 + getPermanentValueBoost(mesh);
  return base * getPublisherTierMultiplier(pub.upgrades['networkTier']);
}

/** Every route from a publisher to a queue or subscriber, as orthogonal waypoints plus the node
 *  ids along it. The body of the store's `_getAllPathsWithNodes`, with the store's
 *  `components`/`connections` as parameters. */
export function getAllPathsWithNodes(
  components: GameComponent[],
  connections: Connection[],
  publisherId: string,
): { waypoints: { x: number; y: number }[]; nodeIds: string[] }[] {
  const results: { waypoints: { x: number; y: number }[]; nodeIds: string[] }[] = [];

  function walk(nodeId: string, currentPath: { x: number; y: number }[], currentNodeIds: string[], visited: Set<string>) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = components.find(c => c.id === nodeId);
    if (!node) return;
    const path = [...currentPath, { x: node.x, y: node.y }];
    const nodeIds = [...currentNodeIds, nodeId];

    // Outgoing connections + reverse bridge connections (bridges are bidirectional)
    const nextConns = connections.filter(c => c.fromId === nodeId);
    const reverseBridgeConns = node.type === 'broker'
      ? connections.filter(c => c.toId === nodeId &&
        components.find(comp => comp.id === c.fromId)?.type === 'broker')
      : [];
    const allNext = [
      ...nextConns.map(c => c.toId),
      ...reverseBridgeConns.map(c => c.fromId),
    ];
    if (allNext.length === 0) {
      // Only record paths that end at a subscriber or a queue (for buffering)
      if (node.type === 'subscriber' || node.type === 'queue') {
        results.push({ waypoints: path, nodeIds });
      }
    } else {
      for (const nextId of allNext) {
        walk(nextId, path, nodeIds, new Set(visited));
      }
    }
  }

  walk(publisherId, [], [], new Set());

  // Expand node-center paths into orthogonal waypoints
  // Uses computeOrthogonalWaypoints to match SVG connection line routing
  return results.map(({ waypoints: nodePath, nodeIds }) => {
    if (nodePath.length < 2) return { waypoints: nodePath, nodeIds };
    const expanded: { x: number; y: number }[] = [nodePath[0]];
    for (let i = 0; i < nodePath.length - 1; i++) {
      const a = nodePath[i];
      const b = nodePath[i + 1];
      if (Math.abs(a.y - b.y) >= 10) {
        const aNode = components.find(c => c.id === nodeIds[i]);
        const bNode = components.find(c => c.id === nodeIds[i + 1]);
        // Detect reverse bridge traversal: dot goes a→b but connection is b→a
        const isReverseBridge = aNode?.type === 'broker' && bNode?.type === 'broker' &&
          !connections.some(c => c.fromId === nodeIds[i] && c.toId === nodeIds[i + 1]) &&
          connections.some(c => c.fromId === nodeIds[i + 1] && c.toId === nodeIds[i]);
        const src = isReverseBridge ? b : a;
        const dst = isReverseBridge ? a : b;
        const srcNode = isReverseBridge ? bNode : aNode;
        const dstNode = isReverseBridge ? aNode : bNode;
        const { halfW: srcHalfW, halfH: srcHalfH } = srcNode ? getNodeHalfExtents(srcNode) : { halfW: 60, halfH: 28 };
        const { halfW: dstHalfW, halfH: dstHalfH } = dstNode ? getNodeHalfExtents(dstNode) : { halfW: 60, halfH: 28 };
        const portStartX = src.x + srcHalfW + 24; // port right edge
        const portEndX = dst.x - dstHalfW - 2;    // target left edge
        const fromBounds = {
          left: src.x - srcHalfW,
          right: src.x + srcHalfW + 24,
          top: src.y - srcHalfH,
          bottom: src.y + srcHalfH,
        };
        const toBounds = {
          left: dst.x - dstHalfW,
          right: dst.x + dstHalfW,
          top: dst.y - dstHalfH,
          bottom: dst.y + dstHalfH,
        };
        const segWaypoints = computeOrthogonalWaypoints(portStartX, src.y, portEndX, dst.y, fromBounds, toBounds);
        const intermediates = segWaypoints.slice(1, -1);
        if (isReverseBridge) intermediates.reverse();
        for (const wp of intermediates) {
          expanded.push(wp);
        }
      }
      expanded.push(b);
    }
    return { waypoints: expanded, nodeIds };
  });
}
