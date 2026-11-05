import { useState, useEffect } from 'react';
import { MeshCanvas } from './components/MeshCanvas';
import { Sidebar } from './components/Sidebar';
import { TutorialModal } from './components/TutorialModal';
import { HelpButton } from './components/HelpButton';
import { PrestigeTreePage } from './components/PrestigeTreePage';
import { IntroSequence } from './components/IntroSequence';
import { WinScreen } from './components/WinScreen';
import { useSimBridge } from './hooks/useSimBridge';
import { useGameStore } from './store/gameStore';

function App() {
  useSimBridge();

  const introSeen = useGameStore(s => s.tutorialsSeen['introSequence']);
  const dismissTutorial = useGameStore(s => s.dismissTutorial);
  const showTutorial = useGameStore(s => s.showTutorial);
  const showPrestigeTree = useGameStore(s => s.showPrestigeTree);
  const [introComplete, setIntroComplete] = useState(!!introSeen);

  useEffect(() => {
    if (introComplete) showTutorial('intro');
  }, [introComplete]);

  if (!introComplete) {
    return <IntroSequence onComplete={() => {
      dismissTutorial('introSequence');
      setIntroComplete(true);
    }} />;
  }

  if (showPrestigeTree) {
    return <PrestigeTreePage />;
  }

  return (
    <div className="flex w-screen h-screen">
      <MeshCanvas />
      <Sidebar />
      <TutorialModal />
      <HelpButton />
      <WinScreen />
    </div>
  );
}

export default App;
