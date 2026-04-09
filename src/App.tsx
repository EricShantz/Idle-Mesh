import { useEffect } from 'react';
import { MeshCanvas } from './components/MeshCanvas';
import { Sidebar } from './components/Sidebar';
import { TutorialModal } from './components/TutorialModal';
import { HelpButton } from './components/HelpButton';
import { PrestigeTreePage } from './components/PrestigeTreePage';
import { useGameLoop, useAutoPublisher } from './hooks/useGameLoop';
import { useGameStore } from './store/gameStore';

function App() {
  useGameLoop();
  useAutoPublisher();

  const showTutorial = useGameStore(s => s.showTutorial);
  const showPrestigeTree = useGameStore(s => s.showPrestigeTree);
  useEffect(() => { showTutorial('intro'); }, []);

  if (showPrestigeTree) {
    return <PrestigeTreePage />;
  }

  return (
    <div className="flex w-screen h-screen">
      <MeshCanvas />
      <Sidebar />
      <TutorialModal />
      <HelpButton />
    </div>
  );
}

export default App;
