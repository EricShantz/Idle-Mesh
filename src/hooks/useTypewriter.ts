import { useState, useEffect, useRef } from 'react';

// Reveals `text` one character at a time while `active` is true. Shared by the intro
// sequence and the end-game win screen (Dave's speech bubbles).
export function useTypewriter(text: string, active: boolean, speed = 25) {
  const [displayed, setDisplayed] = useState('');
  const indexRef = useRef(0);

  useEffect(() => {
    if (!active) { setDisplayed(''); indexRef.current = 0; return; }
    indexRef.current = 0;
    setDisplayed('');
    const id = setInterval(() => {
      indexRef.current++;
      setDisplayed(text.slice(0, indexRef.current));
      if (indexRef.current >= text.length) clearInterval(id);
    }, speed);
    return () => clearInterval(id);
  }, [active, text, speed]);

  return displayed;
}
