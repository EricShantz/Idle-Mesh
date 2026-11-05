import { useEffect, useRef } from 'react';
import { useGameStore } from '../store/gameStore';
import { interpolatePath } from '../utils/pathUtils';
import { useViewport } from '../hooks/useViewport';

const CONSUME_DURATION = 2500; // ms — how long the dot pauses at subscriber

type Dot = ReturnType<typeof useGameStore.getState>['eventDots'][0];
type Component = ReturnType<typeof useGameStore.getState>['components'][0];

const DOT_RADIUS = 2.5;
const GLOW_RADIUS = 4.5;
const GLOW_EXTENT = GLOW_RADIUS + 2; // world units from dot center to the glow's outer edge
// Sprites are rendered at this many pixels per world unit so they stay sharp when zoomed in.
const SPRITE_PX_PER_UNIT = 8;

// A live dot is a solid core with a radial-gradient glow over it. Both only depend on the
// dot's color, so the whole thing is rendered once per color to an offscreen canvas (core
// first, then the glow on top, in the order they used to be drawn on the main canvas) and
// stamped with a single drawImage per dot. The gradient fill alone was the most expensive
// call available; the per-dot beginPath/arc/fill for the core was the next one.
const dotSprites = new Map<string, HTMLCanvasElement>();
function getDotSprite(color: string): HTMLCanvasElement {
  const cached = dotSprites.get(color);
  if (cached) return cached;
  const size = Math.ceil(GLOW_EXTENT * 2 * SPRITE_PX_PER_UNIT);
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const sctx = sprite.getContext('2d')!;
  const c = size / 2;
  sctx.fillStyle = color;
  sctx.beginPath();
  sctx.arc(c, c, DOT_RADIUS * SPRITE_PX_PER_UNIT, 0, Math.PI * 2);
  sctx.fill();
  const gradient = sctx.createRadialGradient(
    c, c, Math.max(1, (DOT_RADIUS / 2) * SPRITE_PX_PER_UNIT),
    c, c, GLOW_EXTENT * SPRITE_PX_PER_UNIT,
  );
  gradient.addColorStop(0, color + '88');
  gradient.addColorStop(1, color + '00');
  sctx.fillStyle = gradient;
  sctx.beginPath();
  sctx.arc(c, c, GLOW_RADIUS * SPRITE_PX_PER_UNIT, 0, Math.PI * 2);
  sctx.fill();
  dotSprites.set(color, sprite);
  return sprite;
}

/** World-space rectangle currently visible, padded by a glow radius; dots outside it are skipped. */
type ViewRect = { left: number; top: number; right: number; bottom: number };

function drawDot(
  ctx: CanvasRenderingContext2D,
  dot: Dot,
  componentById: Map<string, Component>,
  subscriberByPos: Map<string, Component>,
  view: ViewRect,
) {
  if (dot.status === 'traveling' || dot.status === 'pausing' || dot.status === 'queued') {
    let pos = interpolatePath(dot.path, Math.min(dot.progress, 1));

    // Snap queued dots to their queue node center so they don't peek out
    if (dot.status === 'queued' && dot.queuedAtNodeId) {
      const queue = componentById.get(dot.queuedAtNodeId);
      if (queue) pos = { x: queue.x, y: queue.y };
    }

    if (pos.x < view.left || pos.x > view.right || pos.y < view.top || pos.y > view.bottom) return;

    ctx.globalAlpha = Math.max(0, dot.opacity);

    // Calculate shrink scale for pausing dots
    let scale = 1;
    if (dot.status === 'pausing') {
      // Find the subscriber this dot is at and check fasterConsumption
      const subscriberPos = dot.path[dot.path.length - 1];
      const sub = subscriberByPos.get(`${Math.round(subscriberPos.x)},${Math.round(subscriberPos.y)}`);
      const fasterConsumptionLevel = sub && Math.hypot(sub.x - subscriberPos.x, sub.y - subscriberPos.y) < 1
        ? (sub.upgrades['fasterConsumption'] ?? 0)
        : 0;
      const effectiveConsumeDuration = CONSUME_DURATION * Math.pow(0.95, fasterConsumptionLevel);

      const elapsed = Date.now() - (dot.pauseStartTime ?? 0);
      const shrinkProgress = Math.max(0, 1 - elapsed / effectiveConsumeDuration);
      scale = shrinkProgress;
      ctx.globalAlpha = Math.max(0, dot.opacity * shrinkProgress);
    }

    // Core + glow in one stamp — globalAlpha already carries the dot's opacity/shrink fade
    const extent = GLOW_EXTENT * scale;
    ctx.drawImage(getDotSprite(dot.color), pos.x - extent, pos.y - extent, extent * 2, extent * 2);
  } else if (dot.status === 'dropped') {
    ctx.globalAlpha = Math.max(0, dot.opacity);
    const x = dot.dropX ?? dot.path[0].x;
    const y = dot.dropY ?? dot.path[0].y;

    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = dot.color;
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}

export function EventCanvas() {
  const backCanvasRef = useRef<HTMLCanvasElement>(null);
  const frontCanvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const viewportApi = useViewport();

  useEffect(() => {
    const backCanvas = backCanvasRef.current;
    const frontCanvas = frontCanvasRef.current;
    if (!backCanvas || !frontCanvas) return;

    const backCtx = backCanvas.getContext('2d')!;
    const frontCtx = frontCanvas.getContext('2d')!;

    // Assigning canvas.width/height reallocates the backing store (and implicitly clears), so
    // only do it when the on-screen size or DPR actually changes — not every frame.
    let sizedW = 0;
    let sizedH = 0;
    let sizedDpr = 0;
    // The front canvas only ever holds pausing dots (a handful). Skip its full-screen clear
    // on frames where it was empty and stays empty.
    let frontHadContent = false;

    const render = () => {
      const width = backCanvas.clientWidth;
      const height = backCanvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;

      if (width !== sizedW || height !== sizedH || dpr !== sizedDpr) {
        sizedW = width;
        sizedH = height;
        sizedDpr = dpr;
        backCanvas.width = width * dpr;
        backCanvas.height = height * dpr;
        frontCanvas.width = width * dpr;
        frontCanvas.height = height * dpr;
      }

      const { eventDots: dots, components } = useGameStore.getState();
      let hasPausing = false;
      for (const dot of dots) if (dot.status === 'pausing') { hasPausing = true; break; }

      // Clear
      backCtx.setTransform(1, 0, 0, 1, 0, 0);
      backCtx.clearRect(0, 0, backCanvas.width, backCanvas.height);
      if (frontHadContent || hasPausing) {
        frontCtx.setTransform(1, 0, 0, 1, 0, 0);
        frontCtx.clearRect(0, 0, frontCanvas.width, frontCanvas.height);
      }
      frontHadContent = hasPausing;

      // Apply viewport transform: DPR scaling + pan + zoom
      const vp = viewportApi.ref.current;
      const tx = vp.panX * dpr;
      const ty = vp.panY * dpr;
      const s = vp.zoom * dpr;
      backCtx.setTransform(s, 0, 0, s, tx, ty);
      frontCtx.setTransform(s, 0, 0, s, tx, ty);

      // Visible world rect (padded by a glow radius) — dots panned/zoomed off screen are skipped
      const view: ViewRect = {
        left: -vp.panX / vp.zoom - GLOW_EXTENT,
        top: -vp.panY / vp.zoom - GLOW_EXTENT,
        right: (width - vp.panX) / vp.zoom + GLOW_EXTENT,
        bottom: (height - vp.panY) / vp.zoom + GLOW_EXTENT,
      };

      // Per-frame lookups so drawDot doesn't linearly search components per dot
      const componentById = new Map<string, Component>();
      const subscriberByPos = new Map<string, Component>();
      for (const c of components) {
        componentById.set(c.id, c);
        if (c.type === 'subscriber') {
          const k = `${Math.round(c.x)},${Math.round(c.y)}`;
          if (!subscriberByPos.has(k)) subscriberByPos.set(k, c);
        }
      }

      for (const dot of dots) {
        if (dot.status === 'pausing') {
          drawDot(frontCtx, dot, componentById, subscriberByPos, view);
        } else {
          drawDot(backCtx, dot, componentById, subscriberByPos, view);
        }
      }

      animRef.current = requestAnimationFrame(render);
    };

    animRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animRef.current);
  }, [viewportApi]);

  return (
    <>
      <canvas
        ref={backCanvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ zIndex: 19 }}
      />
      <canvas
        ref={frontCanvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ zIndex: 25 }}
      />
    </>
  );
}
