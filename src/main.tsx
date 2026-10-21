import ReactDOM from 'react-dom/client'
import App from './App'
import { installDeepTraceDiagnostics } from './multiplayer/debug/DeepTraceDiagnostics'
import { installMultiplayerMovementTraceInstrumentation } from './multiplayer/debug/MultiplayerMovementTrace'
import { MultiplayerMovementTracePanel } from './multiplayer/debug/MultiplayerMovementTracePanel'
import { installRendererTableTraceDiagnostics } from './multiplayer/debug/RendererTableTraceDiagnostics'
import { installWhite2DedicatedTraceDiagnostics } from './multiplayer/debug/White2DedicatedTraceDiagnostics'
import './styles/app.css'
import './styles/emulator.css'
import './styles/game-themes.css'
import './styles/cover-mascots.css'
import './styles/emerald-scene.css'

const params = new URLSearchParams(window.location.search)
const networkTrace = params.get('transport') === 'network'
const tracePlayer = params.get('player') === '2' ? 2 : 1

if (networkTrace) {
  installMultiplayerMovementTraceInstrumentation()
  installDeepTraceDiagnostics()
  installWhite2DedicatedTraceDiagnostics()
  installRendererTableTraceDiagnostics()
}

ReactDOM.createRoot(document.getElementById('root')!).render(<>
  <App />
  {networkTrace && <MultiplayerMovementTracePanel player={tracePlayer}/>} 
</>)
