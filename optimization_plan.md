# Idle Mesh — Optimization Plan

## Code Optimization

### 1. Quadratic Component Lookups (CRITICAL)
- **File:** `useGameLoop.ts`
- **Problem:** The traveling dot loop calls `state.components.find(c => c.id === xxx)` multiple times per dot per frame. With 100 dots and 20+ components, that's thousands of linear searches per frame.
- **Fix:** Build a `Map<id, component>` at frame start for O(1) lookups:
  ```ts
  const componentMap = new Map(state.components.map(c => [c.id, c]));
  // Then: const comp = componentMap.get(id);  // O(1) instead of O(N)
  ```

### 2. Duplicate `getUpgradesForType()`
- **Files:** `NodeCard.tsx` + `NodeModal.tsx`
- **Problem:** Same function defined in both files. If upgrade definitions change, both must be updated.
- **Fix:** Move to `upgradeConfig.ts` as a single export.

### 3. Quadratic Collision Detection
- **File:** `useGameLoop.ts` — `isComponentOccupied()`
- **Problem:** Iterates through all dots for each dot to check occupancy. O(N²) with 100 dots = 10,000 comparisons/frame.
- **Fix:** Build an `occupiedComponents: Set<id>` at frame start. Lookups become O(1).

### 4. Prestige Helper Recalculation
- **File:** `gameStore.ts`
- **Problem:** Functions like `getPermanentSpeedMult()` are called per-component per-render, recalculating the same values.
- **Fix:** Pre-compute prestige multipliers once per frame as derived state:
  ```ts
  prestigeMultipliers: {
    speedMult: number,
    queueBufferBonus: number,
    // ...
  }
  ```

### 5. Unoptimized Topic Matching
- **File:** `gameStore.ts` — `fireEvent()`
- **Problem:** Calls `topicMatches()` for every path on every event fire with no caching.
- **Fix:** Cache topic matches when subscriptions change: `queueMatchedPublishers: Set<publisherId>`.

---

## Performance / Framerate Optimization

### 6. Canvas Resize Every Frame (CRITICAL — easy fix)
- **File:** `EventCanvas.tsx` lines 86–93
- **Problem:** Sets `canvas.width`/`canvas.height` on every frame, which triggers GPU reallocation even when dimensions haven't changed.
- **Fix:** Track last dimensions, only resize if changed:
  ```ts
  const lastSizeRef = useRef({ w: 0, h: 0 });
  const { width, height } = backCanvas.getBoundingClientRect();
  if (width !== lastSizeRef.current.w || height !== lastSizeRef.current.h) {
    backCanvas.width = width * dpr;
    backCanvas.height = height * dpr;
    lastSizeRef.current = { w: width, h: height };
  }
  ```
- **Impact:** ~20–30% canvas render time saved.

### 7. Gradient Creation Per Dot Per Frame (easy fix)
- **File:** `EventCanvas.tsx` lines 53–56
- **Problem:** Creates a new `createRadialGradient()` for every dot every frame. 100 dots = 100 gradient objects/frame.
- **Fix:** Cache gradients by color (only 3–4 unique colors):
  ```ts
  const gradientCache = new Map<string, CanvasGradient>();

  const getOrCreateGradient = (ctx: CanvasRenderingContext2D, color: string) => {
    if (!gradientCache.has(color)) {
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 4.5);
      grad.addColorStop(0, color + '88');
      grad.addColorStop(1, color + '00');
      gradientCache.set(color, grad);
    }
    return gradientCache.get(color)!;
  };
  ```
- **Impact:** ~8% canvas speedup.

### 8. Zustand Selector Re-renders (CRITICAL)
- **File:** `NodeCard.tsx` lines 45–60
- **Problem:** 10+ separate `useGameStore(s => s.xxx)` calls. Each store mutation re-renders every NodeCard even if unrelated.
- **Fix:** Use `useShallow()` to combine selectors into one object:
  ```ts
  import { useShallow } from 'zustand/react/shallow';

  const nodeData = useGameStore(useShallow(s => ({
    fireEvent: s.fireEvent,
    selectNode: s.selectNode,
    selectedNodeId: s.selectedNodeId,
    balance: s.balance,
    costReduction: s.upgrades.costReduction,
    // ...all related fields
  })));
  ```
- **Impact:** ~50% fewer re-renders.

### 9. Game Loop State Thrashing (CRITICAL)
- **File:** `useGameLoop.ts`
- **Problem:** Every dot update writes to Zustand, triggering React re-render cycles. With many dots, this causes continuous render thrashing.
- **Fix:** Update dots in a ref, commit to Zustand once per frame (or every N frames):
  ```ts
  const gameStateRef = useRef({ dots: [], components: [] });

  const loop = (time: number) => {
    // Update game state in ref (no React updates)
    gameStateRef.current.dots = updateDots(gameStateRef.current.dots);

    // Commit to Zustand once per frame (batched)
    useGameStore.setState({ eventDots: gameStateRef.current.dots });
  };
  ```

### 10. Viewport Re-render Cascade
- **File:** `MeshCanvas.tsx` lines 48–51
- **Problem:** `forceRender()` on every pan/zoom re-renders the entire tree (all NodeCards, ConnectionLines, etc.).
- **Fix:** Use `useSyncExternalStore()` so only the SVG transform re-renders, not children. Or move viewport into a separate context that only re-renders SVG.

### 11. Publisher Cooldown RAF Overhead
- **File:** `NodeCard.tsx` lines 88–111
- **Problem:** Each publisher runs its own `requestAnimationFrame` loop for cooldown display, even when cooldown is done. 60 RAF calls/sec per publisher.
- **Fix:** Move cooldown progress to the store, computed once per game loop frame. Component becomes a simple selector + CSS render, no RAF needed.

### 12. Memory Allocation in Hot Path
- **File:** `useGameLoop.ts`
- **Problem:** Every dot creates new spread objects (`{ ...dot, status: 'queued' }`), and `rebuildPathFromNodeIds()` allocates new arrays per dot per frame. High GC pressure causes frame drops.
- **Fix:** Mutate dot objects in-place where possible. Cache path rebuilds by node ID key.

### 13. Double `interpolatePath()` Calls
- **File:** `EventCanvas.tsx`
- **Problem:** Called per dot for rendering, then again for collision detection. 200 calls for 100 dots.
- **Fix:** Cache `_cachedPos` on the dot object during the game loop, read it in the canvas renderer:
  ```ts
  // In useGameLoop before render:
  dots.forEach(dot => {
    dot._cachedPos = interpolatePath(dot.path, dot.progress);
  });

  // In EventCanvas drawDot():
  const pos = dot._cachedPos; // O(1) lookup
  ```

### 14. Connection Line Recomputation
- **File:** `ConnectionLine.tsx`
- **Problem:** Recomputes orthogonal SVG path geometry on every render, even when positions haven't changed.
- **Fix:** Cache pathD in a ref, only recalculate if endpoints moved.

---

## Quick Wins Summary

| Fix | Effort | Impact |
|-----|--------|--------|
| Cache canvas dimensions before resize (#6) | Very Low | ~20% canvas speedup |
| Build component `Map` at loop start (#1) | Low | ~15% loop speedup |
| Pre-compute gradient cache (#7) | Very Low | ~8% canvas speedup |
| `useShallow()` for NodeCard selectors (#8) | Low | ~50% fewer re-renders |
| Cache `interpolatePath` on dot (#13) | Low | ~5% speedup |
| Move cooldown to store, kill per-publisher RAF (#11) | Low | 50% less RAF overhead |

---

## Priority Order

1. **#6** — Canvas resize cache (easiest, big impact)
2. **#7** — Gradient cache (easiest, solid impact)
3. **#1** — Component Map in game loop (easy, big impact)
4. **#3** — Occupancy Set (easy, big impact with many dots)
5. **#8** — useShallow selectors (low effort, halves re-renders)
6. **#9** — Game loop state batching (medium effort, critical for scaling)
7. **#13** — Cache interpolatePath (low effort, removes duplicate work)
8. **#11** — Cooldown RAF cleanup (low effort, reduces overhead)
9. **#10** — Viewport re-render isolation (medium effort)
10. **#14** — Connection line caching (low effort)
11. **#12** — In-place dot mutation (medium effort, reduces GC)
12. **#2** — Extract shared getUpgradesForType (low effort, maintainability)
13. **#4** — Prestige multiplier caching (low effort)
14. **#5** — Topic match caching (low effort)
