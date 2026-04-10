import { createContext, useContext, useRef, useCallback, useMemo, type MutableRefObject } from 'react';

export type Viewport = {
  panX: number;
  panY: number;
  zoom: number;
};

export type ViewportApi = {
  ref: MutableRefObject<Viewport>;
  subscribe: (cb: () => void) => () => void;
  notify: () => void;
  screenToWorld: (sx: number, sy: number) => { x: number; y: number };
  worldToScreen: (wx: number, wy: number) => { x: number; y: number };
  getZoom: () => number;
};

export const ViewportContext = createContext<ViewportApi>(null!);

export function useViewport(): ViewportApi {
  return useContext(ViewportContext);
}

export function useViewportApi(): ViewportApi {
  const ref = useRef<Viewport>({ panX: 0, panY: 0, zoom: 1 });
  const subscribers = useRef(new Set<() => void>());

  const subscribe = useCallback((cb: () => void) => {
    subscribers.current.add(cb);
    return () => { subscribers.current.delete(cb); };
  }, []);

  const notify = useCallback(() => {
    for (const cb of subscribers.current) cb();
  }, []);

  const screenToWorld = useCallback((sx: number, sy: number) => {
    const v = ref.current;
    return { x: (sx - v.panX) / v.zoom, y: (sy - v.panY) / v.zoom };
  }, []);

  const worldToScreen = useCallback((wx: number, wy: number) => {
    const v = ref.current;
    return { x: wx * v.zoom + v.panX, y: wy * v.zoom + v.panY };
  }, []);

  const getZoom = useCallback(() => ref.current.zoom, []);

  return useMemo(() => ({
    ref, subscribe, notify, screenToWorld, worldToScreen, getZoom,
  }), [subscribe, notify, screenToWorld, worldToScreen, getZoom]);
}
