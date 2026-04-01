import { type ComponentType, type GameComponent, type Connection } from '../store/gameStore';

const ALLOWED_TARGETS: Record<ComponentType, ComponentType[]> = {
  publisher: ['broker', 'webhook'],
  webhook: ['queue', 'subscriber'],
  broker: ['queue', 'subscriber'],
  queue: ['subscriber'],
  subscriber: [],
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

  return components.filter(c =>
    c.id !== fromId &&
    canConnect(from.type, c.type) &&
    !existingTargetIds.has(c.id)
  );
}
