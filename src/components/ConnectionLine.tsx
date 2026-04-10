import { useState } from 'react';
import { useGameStore, type Connection } from '../store/gameStore';
import { buildOrthogonalSvgPath, buildVerticalFirstSvgPath, type NodeBounds } from '../utils/orthogonalPath';
import { useViewport } from '../hooks/useViewport';

type Props = {
  conn: Connection;
};

export function ConnectionLine({ conn }: Props) {
  const components = useGameStore(s => s.components);
  const startDragConnection = useGameStore(s => s.startDragConnection);
  const draggingConnection = useGameStore(s => s.draggingConnection);
  const [hovered, setHovered] = useState(false);
  const viewport = useViewport();

  const from = components.find(c => c.id === conn.fromId);
  const to = components.find(c => c.id === conn.toId);
  if (!from || !to) return null;

  // Hide the original line while it's being dragged for reassignment
  if (draggingConnection?.type === 'reassign' && draggingConnection.connectionId === conn.id) {
    return null;
  }

  // Output port center: depends on node type
  let startX: number;
  let startY: number;

  if (from.type === 'dmq') {
    // Top-center port for DMQ
    startX = from.x;
    startY = from.y - 28 - 16; // top edge - port offset
  } else {
    const fromHalfW = from.type === 'queue' ? 70 : 60;
    const portCX = from.x + fromHalfW + 16;
    const portCY = from.y;
    const portR = 8;
    startX = portCX + portR;
    startY = portCY;
  }

  // End point: bottom edge of broker for DMQ connections, left edge otherwise
  let endX: number;
  let endY: number;
  if (from.type === 'dmq') {
    endX = to.x;
    endY = to.y + 28 + 2; // bottom edge of broker
  } else {
    const toHalfW = to.type === 'queue' ? 70 : 60;
    endX = to.x - toHalfW - 2;
    endY = to.y;
  }

  // Compute node bounding boxes for routing
  const fromHalfH = 28;
  const toHalfH = 28;
  const fromHalfWFull = from.type === 'queue' ? 70 : 60;
  const toHalfWFull = to.type === 'queue' ? 70 : 60;
  const fromBounds: NodeBounds = {
    left: from.x - fromHalfWFull,
    right: from.x + fromHalfWFull + 24, // include output port
    top: from.y - fromHalfH,
    bottom: from.y + fromHalfH,
  };
  const toBounds: NodeBounds = {
    left: to.x - toHalfWFull,
    right: to.x + toHalfWFull,
    top: to.y - toHalfH,
    bottom: to.y + toHalfH,
  };

  const pathD = from.type === 'dmq'
    ? buildVerticalFirstSvgPath(startX, startY, endX, endY, 12, fromBounds, toBounds)
    : buildOrthogonalSvgPath(startX, startY, endX, endY, 12, fromBounds, toBounds);

  const isBridge = from.type === 'broker' && to.type === 'broker';

  const handleClickLine = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const svg = (e.target as SVGElement).ownerSVGElement;
    const container = svg?.parentElement;
    const rect = container?.getBoundingClientRect();
    const sx = rect ? e.clientX - rect.left : e.clientX;
    const sy = rect ? e.clientY - rect.top : e.clientY;
    const world = viewport.screenToWorld(sx, sy);
    startDragConnection('reassign', conn.fromId, conn.id, world.x, world.y);
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
        stroke={hovered ? '#4b6a82' : isBridge ? '#fb923c55' : '#334155'}
        strokeWidth={isBridge ? 2 : 1.5}
        strokeDasharray={isBridge ? '8 4' : '4 4'}
        markerEnd="url(#arrowhead)"
        style={{ transition: 'stroke 0.15s' }}
      />
      {/* Invisible wider hit area — click to detach and drag */}
      <path
        d={pathD}
        fill="none"
        stroke="transparent"
        strokeWidth={14 / viewport.ref.current.zoom}
        style={{ cursor: 'pointer' }}
        onPointerDown={handleClickLine}
      />
    </g>
  );
}
