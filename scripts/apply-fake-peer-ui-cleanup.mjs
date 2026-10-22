import fs from 'node:fs'

const path = 'src/multiplayer/debug/FakeRemotePeerPanel.tsx'
let source = fs.readFileSync(path, 'utf8')

const oldControls = `    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 10 }}>
      <button disabled={controlsDisabled} onClick={() => peer.resetBesideHost()}>RESET BESIDE ME</button>
      <button disabled={controlsDisabled} onClick={() => peer.stopScript()}>STOP</button>
      <button disabled={controlsDisabled} onClick={() => void peer.runSouthTest()}>SOUTH WALK TEST</button>
      <button disabled={controlsDisabled} onClick={() => void peer.runOffscreenReturnTest()}>CAMERA CULL + RETURN</button>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5, marginTop: 8 }}>
      <span/>
      <button disabled={controlsDisabled} onClick={() => void peer.walk('north')}>↑ N</button>
      <span/>
      <button disabled={controlsDisabled} onClick={() => void peer.walk('west')}>← W</button>
      <button disabled={controlsDisabled} onClick={() => void peer.walk('south')}>↓ S</button>
      <button disabled={controlsDisabled} onClick={() => void peer.walk('east')}>→ E</button>
    </div>
`

const newControls = `    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 10 }}>
      <button disabled={controlsDisabled} onClick={() => peer.resetBesideHost()}>RESET BESIDE ME</button>
      <button disabled={controlsDisabled} onClick={() => peer.stopScript()}>STOP</button>
    </div>
`

if (!source.includes(oldControls)) {
  throw new Error('Expected legacy fake-peer control blocks were not found. The UI may already be cleaned up or locally changed.')
}

source = source.replace(oldControls, newControls)
fs.writeFileSync(path, source)
console.log('Removed solved fake-peer diagnostic controls; kept Reset Beside Me and Stop.')
