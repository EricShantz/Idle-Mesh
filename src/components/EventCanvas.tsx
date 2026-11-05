import { useEffect, useRef } from 'react';
import { useViewport } from '../hooks/useViewport';
import { getPositions } from '../sim/simBridge';
import { FLOATS_PER_DOT, DOT_RADIUS, GLOW_RADIUS, GLOW_EXTENT, GLOW_DROPPED, GLOW_PAUSING } from '../sim/positions';

// The dots are drawn from the position buffer the sim fills once per tick (src/sim/positions.ts:
// [x, y, extent, r, g, b, a, glow] per drawable dot). The canvas never sees dot objects or the
// store; the interpolation, queue snap, pausing shrink and color parsing live in the sim.

// Sprites are rendered at this many pixels per world unit so they stay sharp when zoomed in.
const SPRITE_PX_PER_UNIT = 8;

// ---------------------------------------------------------------------------------------------
// 2D path. Used for the front canvas (the handful of pausing dots, which shrink and sit above
// the node cards) and as the whole-scene fallback when WebGL is unavailable.
// ---------------------------------------------------------------------------------------------

// A live dot is a solid core with a radial-gradient glow over it. Both only depend on the
// dot's color, so the whole thing is rendered once per color to an offscreen canvas (core
// first, then the glow on top) and stamped with a single drawImage per dot.
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

// '#rrggbb' for an entry's r, g, b floats (the sprite cache key and the dropped-dot fill).
// Colors round-trip exactly: the sim parsed them from 8-bit hex.
const cssColors = new Map<number, string>();
function cssColor(r: number, g: number, b: number): string {
  const key = (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
  let css = cssColors.get(key);
  if (!css) {
    css = '#' + key.toString(16).padStart(6, '0');
    cssColors.set(key, css);
  }
  return css;
}

/** World-space rectangle currently visible, padded by a glow radius; dots outside it are skipped. */
type ViewRect = { left: number; top: number; right: number; bottom: number };

/** Draws buffer entry at float offset `o` with the 2D API. */
function drawEntry(ctx: CanvasRenderingContext2D, data: Float32Array, o: number, view: ViewRect) {
  const x = data[o];
  const y = data[o + 1];
  const color = cssColor(data[o + 3], data[o + 4], data[o + 5]);
  if (data[o + 7] === GLOW_DROPPED) {
    ctx.globalAlpha = data[o + 6];
    ctx.beginPath();
    ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    if (x < view.left || x > view.right || y < view.top || y > view.bottom) return;
    // Core + glow in one stamp — the entry's alpha already carries the dot's opacity/shrink fade
    // and its extent the pausing shrink
    const extent = data[o + 2];
    ctx.globalAlpha = data[o + 6];
    ctx.drawImage(getDotSprite(color), x - extent, y - extent, extent * 2, extent * 2);
  }

  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------------------------
// WebGL path for the back canvas (traveling, queued and dropped dots — i.e. nearly all of them).
// Every dot is one point-sprite vertex; the fragment shader reproduces the 2D sprite (solid core,
// radial glow clipped at GLOW_RADIUS) so the look is the same. The position buffer is uploaded
// as-is (its layout is the vertex layout) in one buffer upload and one draw call per frame, so
// drawing no longer costs a canvas API call per dot — at several thousand dots the per-dot
// drawImage calls were the biggest single slice of the frame. Pausing entries (glow 2) sit in
// the same buffer for the front canvas; the vertex shader clips them away here.
// ---------------------------------------------------------------------------------------------

const VERT_SRC = `
attribute vec2 a_pos;
attribute float a_extent;
attribute vec4 a_color;
attribute float a_glow;
uniform vec2 u_pan;
uniform float u_zoom;
uniform float u_dpr;
uniform vec2 u_res;
varying vec4 v_color;
varying float v_glow;
varying float v_px;
void main() {
  if (a_glow > 1.5) { // pausing dot: drawn on the front canvas, clipped away here
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 1.0;
    v_px = 1.0;
    v_color = vec4(0.0);
    v_glow = 0.0;
    return;
  }
  vec2 screen = (a_pos * u_zoom + u_pan) * u_dpr;
  vec2 clip = screen / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  float px = a_extent * 2.0 * u_zoom * u_dpr;
  gl_PointSize = px;
  v_px = px;
  v_color = a_color;
  v_glow = a_glow;
}`;

// Ratios of the 2D sprite, as fractions of the point's half-size (GLOW_EXTENT):
//   core edge   = DOT_RADIUS / GLOW_EXTENT
//   glow start  = (DOT_RADIUS / 2) / GLOW_EXTENT   (gradient's inner stop, alpha 0x88)
//   glow clip   = GLOW_RADIUS / GLOW_EXTENT         (the arc the gradient was filled within)
const FRAG_SRC = `
precision mediump float;
varying vec4 v_color;
varying float v_glow;
varying float v_px;
const float CORE = ${(DOT_RADIUS / GLOW_EXTENT).toFixed(5)};
const float INNER = ${((DOT_RADIUS / 2) / GLOW_EXTENT).toFixed(5)};
const float GLOWR = ${(GLOW_RADIUS / GLOW_EXTENT).toFixed(5)};
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float fw = 2.0 / max(v_px, 1.0); // about one device pixel, for anti-aliased edges
  float a;
  if (v_glow > 0.5) {
    float core = 1.0 - smoothstep(CORE - fw, CORE + fw, d);
    float g = clamp(1.0 - (d - INNER) / (1.0 - INNER), 0.0, 1.0) * 0.5333
      * (1.0 - smoothstep(GLOWR - fw, GLOWR + fw, d));
    a = g + core * (1.0 - g); // glow composited over the core, same color
  } else {
    a = 1.0 - smoothstep(1.0 - fw, 1.0, d); // dropped dots: plain disc, extent = DOT_RADIUS
  }
  a *= v_color.a;
  gl_FragColor = vec4(v_color.rgb * a, a); // premultiplied
}`;

type GlRenderer = {
  gl: WebGLRenderingContext;
  uPan: WebGLUniformLocation;
  uZoom: WebGLUniformLocation;
  uDpr: WebGLUniformLocation;
  uRes: WebGLUniformLocation;
};

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('EventCanvas shader failed to compile:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function createGlRenderer(canvas: HTMLCanvasElement): GlRenderer | null {
  const gl = canvas.getContext('webgl', {
    alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
  });
  if (!gl) return null;
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('EventCanvas program failed to link:', gl.getProgramInfoLog(program));
    return null;
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const stride = FLOATS_PER_DOT * 4;
  const attr = (name: string, size: number, offsetFloats: number) => {
    const loc = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offsetFloats * 4);
  };
  attr('a_pos', 2, 0);
  attr('a_extent', 1, 2);
  attr('a_color', 4, 3);
  attr('a_glow', 1, 7);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  const u = (name: string) => gl.getUniformLocation(program, name)!;
  return { gl, uPan: u('u_pan'), uZoom: u('u_zoom'), uDpr: u('u_dpr'), uRes: u('u_res') };
}

/** Upload the position buffer (`count` entries) and draw every back-canvas dot in one call. */
function renderGl(
  r: GlRenderer,
  canvas: HTMLCanvasElement,
  data: Float32Array,
  count: number,
  vp: { panX: number; panY: number; zoom: number },
  dpr: number,
) {
  const { gl } = r;
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (count === 0) return;
  gl.uniform2f(r.uPan, vp.panX, vp.panY);
  gl.uniform1f(r.uZoom, vp.zoom);
  gl.uniform1f(r.uDpr, dpr);
  gl.uniform2f(r.uRes, canvas.width, canvas.height);
  gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * FLOATS_PER_DOT), gl.DYNAMIC_DRAW);
  gl.drawArrays(gl.POINTS, 0, count);
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

    // Back canvas: WebGL when available, otherwise the 2D sprite path. Decided once — a canvas
    // can't switch context types after the first getContext.
    let glr: GlRenderer | null = createGlRenderer(backCanvas);
    const backCtx: CanvasRenderingContext2D | null = glr ? null : backCanvas.getContext('2d');
    const frontCtx = frontCanvas.getContext('2d')!;
    (window as unknown as { __eventCanvasRenderer?: string }).__eventCanvasRenderer = glr ? 'webgl' : '2d';

    // A lost GL context (GPU reset, too many contexts) is recreated on restore; nothing is drawn
    // on the back canvas in between.
    const onLost = (e: Event) => { e.preventDefault(); glr = null; };
    const onRestored = () => { glr = createGlRenderer(backCanvas); };
    if (!backCtx) {
      backCanvas.addEventListener('webglcontextlost', onLost);
      backCanvas.addEventListener('webglcontextrestored', onRestored);
    }

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

      const { buf, count } = getPositions();
      let hasPausing = false;
      for (let i = 0; i < count; i++) {
        if (buf[i * FLOATS_PER_DOT + 7] === GLOW_PAUSING) { hasPausing = true; break; }
      }

      const vp = viewportApi.ref.current;
      const tx = vp.panX * dpr;
      const ty = vp.panY * dpr;
      const s = vp.zoom * dpr;

      // Visible world rect (padded by a glow radius) for the 2D paths' culling
      const view: ViewRect = {
        left: -vp.panX / vp.zoom - GLOW_EXTENT,
        top: -vp.panY / vp.zoom - GLOW_EXTENT,
        right: (width - vp.panX) / vp.zoom + GLOW_EXTENT,
        bottom: (height - vp.panY) / vp.zoom + GLOW_EXTENT,
      };

      // Front canvas: pausing dots only
      if (frontHadContent || hasPausing) {
        frontCtx.setTransform(1, 0, 0, 1, 0, 0);
        frontCtx.clearRect(0, 0, frontCanvas.width, frontCanvas.height);
      }
      frontHadContent = hasPausing;
      if (hasPausing) {
        frontCtx.setTransform(s, 0, 0, s, tx, ty);
        for (let i = 0; i < count; i++) {
          const o = i * FLOATS_PER_DOT;
          if (buf[o + 7] === GLOW_PAUSING) drawEntry(frontCtx, buf, o, view);
        }
      }

      // Back canvas: everything else
      if (glr) {
        renderGl(glr, backCanvas, buf, count, vp, dpr);
      } else if (backCtx) {
        backCtx.setTransform(1, 0, 0, 1, 0, 0);
        backCtx.clearRect(0, 0, backCanvas.width, backCanvas.height);
        backCtx.setTransform(s, 0, 0, s, tx, ty);
        for (let i = 0; i < count; i++) {
          const o = i * FLOATS_PER_DOT;
          if (buf[o + 7] !== GLOW_PAUSING) drawEntry(backCtx, buf, o, view);
        }
      }

      animRef.current = requestAnimationFrame(render);
    };

    animRef.current = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(animRef.current);
      backCanvas.removeEventListener('webglcontextlost', onLost);
      backCanvas.removeEventListener('webglcontextrestored', onRestored);
    };
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
