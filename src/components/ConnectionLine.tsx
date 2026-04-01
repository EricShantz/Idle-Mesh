import { useState } from 'react';
import { useGameStore, type Connection } from '../store/gameStore';

type Props = {
  conn: Connection;
};

export function ConnectionLine({ conn }: Props) {
  const components = useGameStore(s => s.components);
  const startDragConnection = useGameStore(s => s.startDragConnection);
  const removeConnectionById = useGameStore(s => s.removeConnectionById);
  const [hovered, setHovered] = useState(false);

  const from = components.find(c => c.id === conn.fromId);
  const to = components.find(c => c.id === conn.toId);
  if (!from || !to) return null;

  // Output port center: node half-width + port offset
  // right: -24px positions port's right edge 24px past parent right, port is 16px wide
  // so center = halfW + (24 - 8) = halfW + 16
  const fromHalfW = from.type === 'queue' ? 70 : 60;
  const portCX = from.x + fromHalfW + 16;
  const portCY = from.y;
  const portR = 8;

  // Direction from port center to target
  const dxRaw = to.x - portCX;
  const dyRaw = to.y - portCY;
  const lenRaw = Math.hypot(dxRaw, dyRaw);

  // Start at the edge of the port circle in the direction of the target
  const startX = lenRaw > 0 ? portCX + (dxRaw / lenRaw) * portR : portCX + portR;
  const startY = lenRaw > 0 ? portCY + (dyRaw / lenRaw) * portR : portCY;

  // End line at the left edge of the target node
  const dx = to.x - startX;
  const dy = to.y - startY;
  const len = Math.hypot(dx, dy);
  const endOffset = len > 0 ? 62 / len : 0; // 60px half-width + 2px arrowhead clearance
  const endX = to.x - dx * endOffset;
  const endY = to.y - dy * endOffset;

  // Midpoint for controls
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;

  const handleDragFromMidpoint = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const svg = (e.target as SVGElement).ownerSVGElement;
    const container = svg?.parentElement;
    const rect = container?.getBoundingClientRect();
    const mx = rect ? e.clientX - rect.left : e.clientX;
    const my = rect ? e.clientY - rect.top : e.clientY;
    startDragConnection('reassign', conn.fromId, conn.id, mx, my);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    removeConnectionById(conn.id);
  };

  return (
    <g
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Visible line with arrowhead */}
      <line
        x1={startX}
        y1={startY}
        x2={endX}
        y2={endY}
        stroke={hovered ? '#4b6a82' : '#334155'}
        strokeWidth={1.5}
        strokeDasharray="4 4"
        markerEnd="url(#arrowhead)"
        style={{ transition: 'stroke 0.15s' }}
      />
      {/* Invisible wider hit area */}
      <line
        x1={startX}
        y1={startY}
        x2={endX}
        y2={endY}
        stroke="transparent"
        strokeWidth={14}
        style={{ cursor: 'pointer' }}
      />
      {/* Midpoint controls — visible on hover */}
      {hovered && (
        <g>
          {/* Drag handle (arrow icon) — drag to reassign target */}
          <circle
            cx={midX - 10}
            cy={midY}
            r={8}
            fill="#1e293b"
            stroke="#22d3ee"
            strokeWidth={1}
            style={{ cursor: 'grab' }}
            onPointerDown={handleDragFromMidpoint}
          />
          <text
            x={midX - 10}
            y={midY + 1}
            textAnchor="middle"
            dominantBaseline="central"
            fill="#22d3ee"
            fontSize={10}
            style={{ pointerEvents: 'none' }}
          >
            ↗
          </text>
          {/* Delete button */}
          <circle
            cx={midX + 10}
            cy={midY}
            r={8}
            fill="#1e293b"
            stroke="#ef4444"
            strokeWidth={1}
            style={{ cursor: 'pointer' }}
            onClick={handleDelete}
          />
          <text
            x={midX + 10}
            y={midY + 1}
            textAnchor="middle"
            dominantBaseline="central"
            fill="#ef4444"
            fontSize={10}
            fontWeight="bold"
            style={{ pointerEvents: 'none' }}
          >
            ✕
          </text>
        </g>
      )}
    </g>
  );
}
