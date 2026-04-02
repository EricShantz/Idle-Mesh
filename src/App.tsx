import { useEffect } from 'react';
import { MeshCanvas } from './components/MeshCanvas';
import { Sidebar } from './components/Sidebar';
import { TutorialModal } from './components/TutorialModal';
import { useGameLoop, useAutoPublisher } from './hooks/useGameLoop';
import { useGameStore } from './store/gameStore';

function App() {
  useGameLoop();
  useAutoPublisher();

  const showTutorial = useGameStore(s => s.showTutorial);
  useEffect(() => { showTutorial('intro'); }, []);

  return (
    <div className="flex w-screen h-screen">
      <MeshCanvas />
      <Sidebar />
      <TutorialModal />
    </div>
  );
}

export default App;
