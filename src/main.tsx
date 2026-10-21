import ReactDOM from 'react-dom/client'
import App from './App'
import { installMultiplayerMovementTraceInstrumentation } from './multiplayer/debug/MultiplayerMovementTrace'
import { MultiplayerMovementTracePanel } from './multiplayer/debug/MultiplayerMovementTracePanel'
import './styles/app.css'
import './styles/emulator.css'
import './styles/game-themes.css'
import './styles/cover-mascots.css'
import './styles/emerald-scene.css'

const params = new URLSearchParams(window.location.search)
const networkTrace = params.get('transport') === 'network'
const tracePlayer = params.get('player') === '2' ? 2 : 1

if (networkTrace) installMultiplayerMovementTraceInstrumentation()

ReactDOM.createRoot(document.getElementById('root')!).render(<>
  <App />
  {networkTrace && <MultiplayerMovementTracePanel player={tracePlayer}/>} 
</>)
