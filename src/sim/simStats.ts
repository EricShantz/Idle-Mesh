// What the UI reads from the simulation between ticks, served from the latest TickSummary the
// bridge holds. Same signatures the game loop used to export from its own module-level state,
// so the cards and the help button are unchanged apart from the import.
import { latestSummary } from './simBridge';
import type { DropReason } from './sim';

export type { DropReason };

/** Nodes that dropped an event in the last 2 s, with the reason (the warning "!" button). */
export function getActiveDrops(): Array<{ nodeId: string; nodeLabel: string; reason: DropReason }> {
  const s = latestSummary();
  if (!s) return [];
  const now = Date.now();
  const active: Array<{ nodeId: string; nodeLabel: string; reason: DropReason }> = [];
  for (const d of s.activeDrops) {
    if (now - d.lastDropTime < 2000) {
      active.push({ nodeId: d.nodeId, nodeLabel: d.nodeLabel, reason: d.reason });
    }
  }
  return active;
}

/** Current utilization ratio (0-1+) for a broker: relays in the last 1 s over its cap. */
export function getBrokerUtilization(brokerId: string, cap: number): number {
  return (latestSummary()?.brokerRelayCounts[brokerId] ?? 0) / cap;
}

/** Start time and duration of the most recent consume at a subscriber. */
export function getSubscriberConsume(subscriberId: string): { start: number; duration: number } | undefined {
  return latestSummary()?.subscriberConsume[subscriberId];
}

/** How far across a webhook card (0..1) the furthest dot inside its box is, or -1 if none. */
export function getWebhookFill(webhookId: string): number {
  return latestSummary()?.webhookFill[webhookId] ?? -1;
}
