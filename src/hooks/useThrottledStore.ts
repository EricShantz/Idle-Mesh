import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '../store/gameStore';

type GameState = ReturnType<typeof useGameStore.getState>;

/**
 * Like `useGameStore(selector)`, but samples the store on a timer instead of on every commit,
 * so the component re-renders at most every `intervalMs` (and only when the selected value
 * actually changed). For display-only values that move every frame — balance, totals, the
 * rolling $/sec windows — a 60 Hz re-render of a large tree buys nothing a 10 Hz one doesn't,
 * and at high throughput the sidebar alone was a measurable slice of each frame.
 */
export function useThrottledGameStore<T>(selector: (s: GameState) => T, intervalMs = 100): T {
  const selectorRef = useRef(selector);
  useEffect(() => { selectorRef.current = selector; });
  const [value, setValue] = useState<T>(() => selector(useGameStore.getState()));
  useEffect(() => {
    const tick = () => {
      const next = selectorRef.current(useGameStore.getState());
      setValue(prev => (Object.is(prev, next) ? prev : next));
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return value;
}
