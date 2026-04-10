import { type ComponentType, type GameComponent, type Connection } from '../store/gameStore';

const ALLOWED_TARGETS: Record<ComponentType, ComponentType[]> = {
  publisher: ['broker', 'webhook'],
  webhook: ['queue', 'subscriber'],
  broker: ['queue', 'subscriber', 'broker'],
  queue: ['subscriber'],
  subscriber: [],
  dmq: ['broker'],
};

export function canConnect(fromType: ComponentType, toType: ComponentType): boolean {
  return ALLOWED_TARGETS[fromType]?.includes(toType) ?? false;
}

export function getValidTargets(
  fromId: string,
  components: GameComponent[],
  connections: Connection[],
): GameComponent[] {
  const from = components.find(c => c.id === fromId);
  if (!from) return [];

  const existingTargetIds = new Set(
    connections.filter(c => c.fromId === fromId).map(c => c.toId)
  );

  // Count outgoing connections by target type for slot limits
  const outgoingByType: Record<string, number> = {};
  for (const c of connections) {
    if (c.fromId === fromId) {
      const target = components.find(comp => comp.id === c.toId);
      if (target) {
        outgoingByType[target.type] = (outgoingByType[target.type] ?? 0) + 1;
      }
    }
  }

  return components.filter(c => {
    if (c.id === fromId) return false;
    if (!canConnect(from.type, c.type)) return false;
    if (existingTargetIds.has(c.id)) return false;

    // Broker → queue slot limit
    if (from.type === 'broker' && c.type === 'queue') {
      const maxSlots = 1 + (from.upgrades['addQueueSlot'] ?? 0);
      if ((outgoingByType['queue'] ?? 0) >= maxSlots) return false;
    }

    // Queue → subscriber slot limit
    if (from.type === 'queue' && c.type === 'subscriber') {
      const maxSlots = 1 + (from.upgrades['addSubscriberSlot'] ?? 0);
      if ((outgoingByType['subscriber'] ?? 0) >= maxSlots) return false;
    }

    // Broker → broker bridge slot limit (starts at 0, must upgrade)
    // Both brokers must have an available bridge slot (connection is bidirectional)
    if (from.type === 'broker' && c.type === 'broker') {
      const fromMaxSlots = from.upgrades['addBridgeSlot'] ?? 0;
      if ((outgoingByType['broker'] ?? 0) >= fromMaxSlots) return false;

      // Check target broker's available bridge slots
      const toMaxSlots = c.upgrades['addBridgeSlot'] ?? 0;
      const toUsedSlots = connections.filter(cn => {
        if (cn.fromId === c.id) {
          return components.find(comp => comp.id === cn.toId)?.type === 'broker';
        }
        if (cn.toId === c.id) {
          return components.find(comp => comp.id === cn.fromId)?.type === 'broker';
        }
        return false;
      }).length;
      if (toUsedSlots >= toMaxSlots) return false;
    }

    // Publisher → single broker limit
    if (from.type === 'publisher') {
      const totalOutgoing = connections.filter(cn => cn.fromId === fromId).length;
      if (totalOutgoing >= 1) return false;
    }

    return true;
  });
}
