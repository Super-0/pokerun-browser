// PRK81I: two different browser tabs, each owning an independent melonDS WASM worker.
// Host calls real MP_SendCmd/MP_RecvReplies; peer calls real
// MP_RecvHostPacket/MP_SendReply. No ROM or save is loaded.
// All packets are controlled test data (not in-game wireless traffic).
const logElement=document.querySelector<HTMLPreElement>('#log')
const roleElement=document.querySelector<HTMLElement>('#role')
const otherLink=document.querySelector<HTMLAnchorElement>('#peerLink')
const fileInput=document.querySelector<HTMLInputElement>('#rom')
const bootButton=document.querySelector<HTMLButtonElement>('#boot')
const roomElement=document.querySelector<HTMLElement>('#roomId')
const pairingElement=document.querySelector<HTMLElement>('#pairStatus')
const log=(s:string)=>{
 if(logElement)logElement.textContent+=(logElement.textContent?'\n':'')+s
 console.info('[PRK81I]',s)
}
if(logElement)logElement.textContent=''
const url=new URL(window.location.href)
const role:'host'|'peer'=url.searchParams.get('role')==='peer'?'peer':'host'
let room=url.searchParams.get('room')??''
const validRoom=/^[0-9a-f-]{16,64}$/i.test(room)
// A peer without a host-generated room used to create its own random room.
// That appeared to work locally but cannot connect to the intended host.
if(role==='peer'&&!validRoom){
 if(roleElement)roleElement.textContent='PEER — NOT PAIRED'
 if(roomElement)roomElement.textContent='No host room supplied'
 if(pairingElement)pairingElement.textContent=
  'BLOCKED: Open the peer tab from the HOST page. A peer cannot create its own room.'
 if(otherLink){
  const hostStart=new URL(url.pathname,url.origin)
  otherLink.href=hostStart.href
  otherLink.textContent='Start a new host session'
 }
 if(bootButton)bootButton.disabled=true
 log('BLOCKED: This peer URL has no valid host room. Return to the HOST tab and click its peer link.')
 throw Error('PRK81I peer requires a valid host room ID in its URL.')
}
if(!validRoom)room=crypto.randomUUID()
url.searchParams.delete('utm_source')
url.searchParams.set('role',role)
url.searchParams.set('room',room)
window.history.replaceState(null,'',url)
const otherUrl=new URL(url)
otherUrl.searchParams.set('role',role==='host'?'peer':'host')
if(roleElement)roleElement.textContent=role==='host'?'HOST (Player 1)':'PEER (Player 2)'
if(otherLink){
 otherLink.href=otherUrl.href
 otherLink.textContent=role==='host'?'Open the paired peer tab (Player 2)':'Open the paired host tab (Player 1)'
}
if(roomElement)roomElement.textContent=room
const setPairingStatus=(message:string)=>{
 if(pairingElement)pairingElement.textContent=message
}
setPairingStatus('Waiting for matching-room player to boot 30 real DS frames.')
log('Pairing room: '+room)
log('HOST and PEER room IDs MUST match exactly. Open the peer from the HOST link.')
log('Starting PRK81I independent native worker test')
log('Role: '+role)
log('Cross-origin isolated: '+window.crossOriginIsolated)
if(!window.crossOriginIsolated||typeof SharedArrayBuffer!=='function')
 throw Error('COOP/COEP + SharedArrayBuffer required')
if(!('BroadcastChannel' in window))throw Error('BroadcastChannel unavailable')
if(role==='host')log('Open peer tab, choose the same ROM in EACH tab, and click Boot 30 frames in each.')

type Mode='valid'|'stale'|'timeout'
type Case={marker:number;mode:Mode;expected:number}
type NativeStats={matched:number;rejected:number;timedOut:number;dropped:number}
type WorkerMsg={
 kind:string;stage?:string;message?:string;stamp?:number;role?:string;
 frames?:number;callbacks?:number;saveWrites?:number;firmwareRole?:number;
 tx?:number;rx?:number;heap?:SharedArrayBuffer;marker?:number;
 sequence?:number;frame?:Uint8Array;timestamp?:number;aid?:number;
 result?:number;elapsed?:number;stats?:NativeStats
}
type WireMessage={
 kind:'hello'|'ready'|'command'|'reply'|'finish'|'peer-complete';
 room:string;role:'host'|'peer';from:string;to?:string;
 sequence?:number;marker?:number;mode?:Mode;frame?:Uint8Array;
 timestamp?:number;aid?:number;frames?:number;callbacks?:number;saveWrites?:number
}
const scenarios:Case[]=[
 {marker:11,mode:'valid',expected:2},
 {marker:22,mode:'valid',expected:2},
 {marker:33,mode:'valid',expected:2},
 {marker:44,mode:'stale',expected:0},
 {marker:55,mode:'timeout',expected:0},
]
const me=crypto.randomUUID()
const channel=new BroadcastChannel('pokerun-prk81i-live-frames-v1-'+room)
// Display-only discovery: warns about wrong-room tabs. It never carries
// native packets or automatically joins a different room.
const discoveryChannel=new BroadcastChannel('pokerun-prk81i-discovery-v1')
let reportedDifferentRoom=false
const advertise=()=>{
 if(done)return
 discoveryChannel.postMessage({kind:'presence',from:me,role,room})
}
const advertiseTimer=window.setInterval(advertise,1000)
discoveryChannel.onmessage=(event:MessageEvent<{
 kind?:string;from?:string;role?:string;room?:string
}>)=>{
 const m=event.data
 if(done||!m||m.kind!=='presence'||m.from===me||
    m.role===role||typeof m.room!=='string')return
 if(m.room!==room&&!remote&&!reportedDifferentRoom){
  reportedDifferentRoom=true
  const warning='ROOM MISMATCH: other '+m.role+' uses '+m.room+
   ' but this tab uses '+room+'. Close the mismatched tab and open the peer from the HOST link.'
  log(warning)
  setPairingStatus(warning)
 }
}
advertise()
const channel=new BroadcastChannel('pokerun-prk81i-live-frames-v1-'+room)
const worker=new Worker('/prk81i-live-frame-worker.js?role='+role,{type:'classic'})
let remote:string|null=null
let peerAcked=false
let wasmReady=false,bootRequested=false,workerReady=false,started=false,done=false
let nativeFinished=false,localAfter=false,remoteAfter=false,peerAfterRequested=false
let txCtrl:Int32Array|null=null,rxCtrl:Int32Array|null=null
let txObserver:Worker|null=null,rxCommitter:Worker|null=null
let txReady=false,rxReady=false,transportStarted=false,txArmed=false,txFinished=false
let forwardedCommands=0
let testIndex=0,pending:{sequence:number;marker:number;mode:Mode}|null=null
let stats:NativeStats|null=null
let receivedFromPeer=0,peerRepliesProduced=0,withheld=0
let heartbeats=0
const pulse=window.setInterval(()=>heartbeats++,10)
const sessionStarted=performance.now()
let watchdog:number|null=null
fileInput?.addEventListener('change',()=>{
 if(bootButton)bootButton.disabled=!wasmReady||bootRequested||!fileInput.files?.length
})
bootButton?.addEventListener('click',async()=>{
 if(!wasmReady||bootRequested||!fileInput?.files?.length)return
 const file=fileInput.files[0]
 if(!file.name.toLowerCase().endsWith('.nds')||
    file.size<1048576||file.size>536870912){
  log('FAIL: Select an uncompressed .nds ROM between 1 MB and 512 MB.')
  return
 }
 bootRequested=true
 bootButton.disabled=true
 log('Reading local ROM ('+file.size+' bytes), no network upload.')
 try{
  const bytes=await file.arrayBuffer()
  log('Booting '+role+' DS with ephemeral firmware and save path.')
  worker.postMessage({kind:'boot',rom:bytes},[bytes])
 }catch(error){closeSession('Could not read ROM: '+String(error),true)}
})
const announce=()=>{
 if(done||!workerReady)return
 const hello:WireMessage={kind:'hello',room,role,from:me}
 channel.postMessage(hello)
}
const signalReady=()=>{
 if(done||!workerReady||!remote)return
 channel.postMessage({kind:'ready',room,role,from:me,to:remote} satisfies WireMessage)
}
const helloTimer=window.setInterval(announce,400)
function closeSession(message:string,fail=false){
 if(done)return
 done=true
 log((fail?'FAIL: ':'')+message)
 setPairingStatus((fail?'FAILED: ':'COMPLETED: ')+message)
 window.clearInterval(pulse)
 window.clearInterval(helloTimer)
 window.clearInterval(advertiseTimer)
 discoveryChannel.close()
 if(watchdog!==null)window.clearTimeout(watchdog)
 worker.terminate()
 txObserver?.terminate()
 rxCommitter?.terminate()
 channel.close()
}
function startIfReady(){
 if(done||started||role!=='host'||!workerReady||!remote||!peerAcked)return
 if(!txCtrl||!rxCtrl||txCtrl.buffer!==rxCtrl.buffer||
    !(txCtrl.buffer instanceof SharedArrayBuffer)){
  closeSession('Native WASM shared memory missing for transport.',true);return
 }
 started=true
 setPairingStatus('CONNECTED: matching room and two booted DS cores. Native callback tests running.')
 watchdog=window.setTimeout(()=>closeSession('Transport or peer callbacks exceeded 20 seconds.',true),20000)
 const heap=txCtrl.buffer,peer=remote
 txObserver=new Worker('/prk81i-tx-observer.js',{type:'classic'})
 rxCommitter=new Worker('/prk81i-rx-committer.js',{type:'classic'})
 txObserver.onerror=e=>closeSession('Native TX observer crashed: '+e.message,true)
 rxCommitter.onerror=e=>closeSession('Native RX committer crashed: '+e.message,true)
 txObserver.onmessageerror=()=>closeSession('Unreadable TX observer message.',true)
 rxCommitter.onmessageerror=()=>closeSession('Unreadable RX committer message.',true)
 txObserver.onmessage=(event:MessageEvent<{
  kind:string;stage?:string;message?:string;sequence?:number;
  marker?:number;mode?:Mode;count?:number
 }>)=>{
  if(done)return
  const m=event.data
  if(m.kind==='error'){
   closeSession('TX transport '+m.stage+': '+m.message,true)
  }else if(m.kind==='ready'){
   txReady=true
   log('Native TX observer ready (no browser polling timer).')
   armTransport()
  }else if(m.kind==='armed'){
   if(!transportStarted||txArmed){
    closeSession('Unexpected native TX observer state.',true);return
   }
   txArmed=true
   log('Native TX observer armed; both DS cores have completed 30 frames.')
   next()
  }else if(m.kind==='forwarded'){
   const expected=scenarios[(m.sequence??0)-1]
   if(!expected||m.marker!==expected.marker||m.mode!==expected.mode||
      m.sequence!==forwardedCommands+1){
    closeSession('TX observer saw an invalid or out-of-order command.',true);return
   }
   forwardedCommands++
   log('Native CMD '+m.sequence+' forwarded directly to peer ('+m.mode+').')
  }else if(m.kind==='complete'){
   if(m.count!==5||forwardedCommands!==5){
    closeSession('Native TX observer completion mismatch.',true);return
   }
   txFinished=true
  }
 }
 rxCommitter.onmessage=(event:MessageEvent<{
  kind:string;stage?:string;message?:string;sequence?:number;mode?:Mode
 }>)=>{
  if(done)return
  const m=event.data
  if(m.kind==='error'){
   closeSession('RX transport '+m.stage+': '+m.message,true)
  }else if(m.kind==='ready'){
   rxReady=true
   log('Native RX committer ready (peer reply + Atomics.notify).')
   armTransport()
  }else if(m.kind==='delivered'){
   if(m.sequence!==receivedFromPeer+1||
      m.mode!==(m.sequence===4?'stale':'valid')){
    closeSession('Native peer reply order mismatch.',true);return
   }
   receivedFromPeer++
   log('Peer native reply '+m.sequence+' committed to host WASM ('+m.mode+').')
  }
 }
 txObserver.postMessage({
  kind:'init',heap,tx:txCtrl.byteOffset,room,from:me,to:peer,
  cases:scenarios.map(t=>({marker:t.marker,mode:t.mode}))
 })
 rxCommitter.postMessage({kind:'init',heap,rx:rxCtrl.byteOffset,room,from:me,to:peer})
}
function armTransport(){
 if(done||!started||!txReady||!rxReady||transportStarted)return
 transportStarted=true
 txObserver?.postMessage({kind:'start'})
}
function finishIfReady(){
 if(done||!nativeFinished||!localAfter||!remoteAfter)return
 log('Native matched replies: '+stats?.matched+'/3')
 log('Native wrong-sequence rejects: '+stats?.rejected+'/1')
 log('Native missing-reply timeouts: '+stats?.timedOut+'/1')
 log('Peer native replies received: '+receivedFromPeer+'/4')
 log('Browser heartbeats: '+heartbeats)
 log('Elapsed: '+(performance.now()-sessionStarted).toFixed(1)+' ms')
 closeSession('PASS: two independent DS cores executed 60 frames each around five native cross-tab callback checks.')
 log('Test replies are still controlled native callback data, not in-game Pokémon wireless packets.')
}
function next(){
 if(done)return
 if(testIndex===scenarios.length){
  if(!stats||stats.matched!==3||stats.rejected!==1||
     stats.timedOut!==1||stats.dropped!==0||receivedFromPeer!==4||
     forwardedCommands!==5||!txFinished){
   closeSession('Native packet counters incorrect: '+JSON.stringify({stats,receivedFromPeer}),true)
   return
  }
  nativeFinished=true
  log('Five native cross-tab callbacks passed. Requesting final 30 DS frames in both tabs.')
  const msg:WireMessage={kind:'finish',room,role:'host',from:me,to:remote??undefined}
  channel.postMessage(msg)
  worker.postMessage({kind:'post-frames'})
  return
 }
 // TX observer is armed already; the native worker can now publish a CMD.
 const test=scenarios[testIndex]
 if(pending){closeSession('Prior native callback still pending.',true);return}
 pending={sequence:testIndex+1,marker:test.marker,mode:test.mode}
 worker.postMessage({kind:'host-test',marker:test.marker})
}
worker.onerror=e=>closeSession('Worker error: '+e.message,true)
worker.onmessageerror=()=>closeSession('Unreadable WASM worker message.',true)
worker.onmessage=(event:MessageEvent<WorkerMsg>)=>{
 const m=event.data
 if(done)return
 if(m.kind==='stage'){log('Worker: '+m.stage);return}
 if(m.kind==='error'){closeSession((m.stage||'unknown')+': '+m.message,true);return}
 if(m.kind==='runtime-ready'){
  if(m.stamp!==0x50524b4b||m.role!==role){
   closeSession('Wrong WASM runtime or worker role.',true);return
  }
  wasmReady=true
  if(bootButton)bootButton.disabled=!fileInput?.files?.length
  log('Native WASM runtime ready (0x50524b4b). Select ROM and click Boot.')
  return
 }
 if(m.kind==='booted'){
  if(m.stamp!==0x50524b4b||m.role!==role||
     m.frames!==30||m.callbacks!==30||
     m.firmwareRole!==(role==='host'?1:2)){
   closeSession('First 30 native frames or distinct firmware role failed: '+
    JSON.stringify({frames:m.frames,callbacks:m.callbacks,firmwareRole:m.firmwareRole}),true)
   return
  }
  if(role==='host'){
   if(!m.heap||m.tx===undefined||m.rx===undefined){closeSession('Missing native mailbox.',true);return}
   try{
    txCtrl=new Int32Array(m.heap,m.tx,8)
    rxCtrl=new Int32Array(m.heap,m.rx,8)
   }catch(e){closeSession('Could not map native WASM mailboxes: '+String(e),true);return}
  }
  workerReady=true
  if(!peerAcked)setPairingStatus('Local '+role+' game booted; waiting for other player to finish booting in room '+room)
  log('Native '+role+' DS boot: '+m.frames+'/30 frames, '+m.callbacks+'/30 callbacks, firmware role '+m.firmwareRole+'.')
  announce()
  signalReady()
  startIfReady()
  return
 }
 if(m.kind==='post-frames'){
  if(m.frames!==60||m.callbacks!==60){
   closeSession('Post-exchange native frame/callback mismatch: '+JSON.stringify(m),true)
   return
  }
  log('Local '+role+' DS completed 60/60 real frames (60 callbacks; '+m.saveWrites+' temporary save writes).')
  if(role==='host'){
   localAfter=true
   finishIfReady()
  }else{
   const response:WireMessage={kind:'peer-complete',room,role:'peer',from:me,
    to:remote??undefined,frames:m.frames,callbacks:m.callbacks,saveWrites:m.saveWrites}
   channel.postMessage(response)
   log('Peer sent post-frame completion to host.')
  }
  return
 }
 if(role==='peer'&&m.kind==='peer-reply'){
  if(!remote||!(m.frame instanceof Uint8Array)||m.aid!==1||
     !Number.isSafeInteger(m.sequence)||m.timestamp!==1000){
   closeSession('Invalid native peer response.',true);return
  }
  const reply:WireMessage={
   kind:'reply',room,role:'peer',from:me,to:remote,
   sequence:m.sequence,marker:m.marker,frame:m.frame,timestamp:m.timestamp,aid:m.aid
  }
  channel.postMessage(reply)
  peerRepliesProduced++
  log('Native MP_SendReply sent response '+m.sequence+' across tabs.')
  if(peerRepliesProduced===4&&withheld===1)
   log('PEER COMPLETE: four native replies produced, one deliberately withheld.')
  return
 }
 if(role==='host'){
  const test=scenarios[testIndex]
  if(!test||m.marker!==test.marker){closeSession('Unexpected host worker result.',true);return}
  if(m.kind==='calling'){log('Native host callback entered for marker '+m.marker);return}
  if(m.kind==='host-result'){
   if(!pending||m.result!==test.expected){
    closeSession('Native '+test.mode+' returned '+m.result+' instead of '+test.expected+
     ' (native '+(m.elapsed??0).toFixed(1)+'ms, txState='+
     (txCtrl?Atomics.load(txCtrl,0):'n/a')+', rxState='+
     (rxCtrl?Atomics.load(rxCtrl,0):'n/a')+', peerAck='+peerAcked+
     ', forwarded='+forwardedCommands+', received='+receivedFromPeer+
     ', counters='+JSON.stringify(m.stats)+')',true)
    return
   }
   log('Host native '+test.mode+': result '+m.result+' ('+(m.elapsed??0).toFixed(1)+' ms)')
   stats=m.stats??null
   pending=null
   testIndex++
   next()
  }
 }
}
channel.onmessageerror=()=>closeSession('BroadcastChannel message decoding failed.',true)
channel.onmessage=(event:MessageEvent<WireMessage>)=>{
 if(done)return
 const m=event.data
 if(!m||typeof m!=='object'||m.room!==room||m.from===me||
    typeof m.from!=='string')return
 const otherRole=role==='host'?'peer':'host'
 if(m.role!==otherRole)return
 if(m.kind==='hello'){
  if(remote&&remote!==m.from){closeSession('Multiple peers in one room are not supported.',true);return}
  if(!remote){
   remote=m.from
   log('Other tab discovered IN MATCHING ROOM '+room+'; answering hello immediately.')
   setPairingStatus('Matching-room tab found. Waiting for its real DS core to finish booting.')
   announce()
  }
  signalReady()
  return
 }
 if(m.kind==='ready'){
  if(remote===m.from&&m.to===me&&workerReady){
   if(!peerAcked){
    peerAcked=true
    log('Other tab acknowledged this worker in room '+room+'; two-way handshake ready.')
    setPairingStatus('Both cores booted and room matched; preparing transport workers.')
   }
   startIfReady()
  }
  return
 }
 if(!remote||m.from!==remote||m.to!==me||!workerReady)return
 if(role==='peer'&&m.kind==='finish'){
  if(peerAfterRequested)return
  if(peerRepliesProduced!==4||withheld!==1){
   closeSession('Final frames requested before all test replies completed.',true)
   return
  }
  peerAfterRequested=true
  log('Host confirmed callback checks. Running 30 post-exchange real DS frames.')
  worker.postMessage({kind:'post-frames'})
  return
 }
 if(role==='host'&&m.kind==='peer-complete'){
  if(!nativeFinished||m.frames!==60||m.callbacks!==60){
   closeSession('Peer native post-frame result invalid: '+JSON.stringify(m),true)
   return
  }
  remoteAfter=true
  log('Peer confirmed 60/60 native DS frames and 60 frame callbacks.')
  finishIfReady()
  return
 }
 if(role==='peer'&&m.kind==='command'){
  if(!(m.frame instanceof Uint8Array)||m.frame.length!==36||
     !Number.isSafeInteger(m.sequence)||!Number.isSafeInteger(m.marker)||
     m.timestamp!==1000||!['valid','stale','timeout'].includes(m.mode as string)){
   closeSession('Invalid test command from host.',true);return
  }
  if(m.mode==='timeout'){
   withheld++
   log('Deliberately withholding native reply for final timeout test.')
   if(peerRepliesProduced===4)
    log('PEER COMPLETE: four native replies produced, one deliberately withheld.')
  }else{
   log('Peer received CMD '+m.sequence+'; passing it to native MP_RecvHostPacket.')
   worker.postMessage({
    kind:'peer-command',sequence:m.sequence,marker:m.marker,
    frame:m.frame,timestamp:m.timestamp
   })
  }
 }else if(role==='host'&&m.kind==='reply'){
  // Dedicated RX committer has its own BroadcastChannel subscription.
 }
}
