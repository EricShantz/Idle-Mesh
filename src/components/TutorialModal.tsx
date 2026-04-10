import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useGameStore } from '../store/gameStore';
import { tutorialMap } from '../store/tutorialConfig.tsx';
import { PixelCharacter } from './IntroSequence';

export function TutorialModal() {
  const activeTutorial = useGameStore(s => s.activeTutorial);
  const dismissTutorial = useGameStore(s => s.dismissTutorial);
  const [slideIndex, setSlideIndex] = useState(0);

  useEffect(() => { setSlideIndex(0); }, [activeTutorial]);

  const def = activeTutorial ? tutorialMap[activeTutorial] : null;
  if (!def) return null;

  const slide = def.slides[slideIndex];
  const isFirst = slideIndex === 0;
  const isLast = slideIndex === def.slides.length - 1;
  const multiSlide = def.slides.length > 1;

  return (
    <AnimatePresence>
      <motion.div
        key={activeTutorial}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0"
        style={{ zIndex: 60, background: 'rgba(0,0,0,0.6)' }}
        onClick={() => dismissTutorial(activeTutorial!)}
      >
        {/* Dave + speech bubble container */}
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
          className="absolute bottom-6 right-6 flex items-end gap-10"
          onClick={e => e.stopPropagation()}
        >
          {/* Speech bubble (tutorial card) */}
          <div
            className="relative rounded-lg border border-gray-700 p-6 shadow-xl"
            style={{
              background: '#111827',
              maxWidth: 420,
              width: 420,
              marginBottom: 110,
              marginRight: 16,
            }}
          >
            <h2 className="text-lg font-bold text-white mb-3">{slide.title}</h2>
            {slide.graphic && (
              <div className="mb-3 rounded-lg overflow-hidden">
                <slide.graphic />
              </div>
            )}
            <p className="text-sm text-gray-300 leading-relaxed mb-5" style={{ whiteSpace: 'normal' }}>{slide.body}</p>

            <div className="flex items-center justify-between">
              <div className="flex gap-1.5">
                {multiSlide && def.slides.map((_, i) => (
                  <div
                    key={i}
                    className="w-2 h-2 rounded-full"
                    style={{ background: i === slideIndex ? '#22d3ee' : '#374151' }}
                  />
                ))}
              </div>

              <div className="flex gap-2">
                {!isFirst && (
                  <button
                    className="px-3 py-1.5 text-sm rounded border border-gray-600 text-gray-300 hover:bg-gray-800 cursor-pointer"
                    onClick={() => setSlideIndex(i => i - 1)}
                  >
                    Previous
                  </button>
                )}
                {isLast ? (
                  <button
                    className="px-3 py-1.5 text-sm rounded bg-cyan-600 hover:bg-cyan-500 text-white font-medium cursor-pointer"
                    onClick={() => dismissTutorial(activeTutorial!)}
                  >
                    Got it
                  </button>
                ) : (
                  <button
                    className="px-3 py-1.5 text-sm rounded bg-cyan-600 hover:bg-cyan-500 text-white font-medium cursor-pointer"
                    onClick={() => setSlideIndex(i => i + 1)}
                  >
                    Next
                  </button>
                )}
              </div>
            </div>

            {/* Speech tail pointing down-right toward Dave's mouth */}
            <div
              className="absolute -right-2 bottom-3 w-0 h-0"
              style={{
                borderTop: '6px solid transparent',
                borderBottom: '6px solid transparent',
                borderLeft: '8px solid #374151',
              }}
            />
            <div
              className="absolute -right-[7px] bottom-3 w-0 h-0"
              style={{
                borderTop: '5px solid transparent',
                borderBottom: '5px solid transparent',
                borderLeft: '7px solid #111827',
              }}
            />
          </div>

          {/* Dave */}
          <div className="flex-shrink-0" style={{ transform: 'scale(2.5)', transformOrigin: 'bottom right' }}>
            <PixelCharacter frustrated={false} />
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
