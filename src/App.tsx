import { MeshCanvas } from './components/MeshCanvas';
import { Sidebar } from './components/Sidebar';
import { useGameLoop, useAutoPublisher } from './hooks/useGameLoop';

function App() {
  useGameLoop();
  useAutoPublisher();

  return (
    <div className="flex w-screen h-screen">
      <MeshCanvas />
      <Sidebar />
    </div>
  );
}

export default App;
