import { useState } from 'react';
import { useGameStore, type Connection } from '../store/gameStore';
import { buildOrthogonalSvgPath } from '../utils/orthogonalPath';

type Props = {
  conn: Connection;
};

export function ConnectionLine({ conn }: Props) {
  const components = useGameStore(s => s.components);
  const startDragConnection = useGameStore(s => s.startDragConnection);
  const draggingConnection = useGameStore(s => s.draggingConnection);
  const [hovered, setHovered] = useState(false);

  const from = components.find(c => c.id === conn.fromId);
  const to = components.find(c => c.id === conn.toId);
  if (!from || !to) return null;

  // Hide the original line while it's being dragged for reassignment
  if (draggingConnection?.type === 'reassign' && draggingConnection.connectionId === conn.id) {
    return null;
  }

  // Output port center: node half-width + port offset
  const fromHalfW = from.type === 'queue' ? 70 : 60;
  const portCX = from.x + fromHalfW + 16;
  const portCY = from.y;
  const portR = 8;

  // Start at port edge (right side)
  const startX = portCX + portR;
  const startY = portCY;

  // End at left edge of target node
  const toHalfW = to.type === 'queue' ? 70 : 60;
  const endX = to.x - toHalfW - 2;
  const endY = to.y;

  const pathD = buildOrthogonalSvgPath(startX, startY, endX, endY);

  const handleClickLine = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const svg = (e.target as SVGElement).ownerSVGElement;
    const container = svg?.parentElement;
    const rect = container?.getBoundingClientRect();
    const mx = rect ? e.clientX - rect.left : e.clientX;
    const my = rect ? e.clientY - rect.top : e.clientY;
    startDragConnection('reassign', conn.fromId, conn.id, mx, my);
  };

  return (
    <g
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Visible path with arrowhead */}
      <path
        d={pathD}
        fill="none"
        stroke={hovered ? '#4b6a82' : '#334155'}
        strokeWidth={1.5}
        strokeDasharray="4 4"
        markerEnd="url(#arrowhead)"
        style={{ transition: 'stroke 0.15s' }}
      />
      {/* Invisible wider hit area — click to detach and drag */}
      <path
        d={pathD}
        fill="none"
        stroke="transparent"
        strokeWidth={14}
        style={{ cursor: 'pointer' }}
        onPointerDown={handleClickLine}
      />
    </g>
  );
}
