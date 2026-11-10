// PRK81H: two different browser tabs, each owning an independent melonDS WASM worker.
// Host calls real MP_SendCmd/MP_RecvReplies; peer calls real
// MP_RecvHostPacket/MP_SendReply. No ROM or save is loaded.
// All packets are controlled test data (not in-game wireless traffic).
const logElement=document.querySelector<HTMLPreElement>('#log')
const roleElement=document.querySelector<HTMLElement>('#role')
const otherLink=document.querySelector<HTMLAnchorElement>('#peerLink')
const log=(s:string)=>{
 if(logElement)logElement.textContent+=(logElement.textContent?'\n':'')+s
 console.info('[PRK81H]',s)
}
if(logElement)logElement.textContent=''
const url=new URL(window.location.href)
const role:'host'|'peer'=url.searchParams.get('role')==='peer'?'peer':'host'
let room=url.searchParams.get('room')??''
if(!/^[0-9a-f-]{16,64}$/i.test(room))room=crypto.randomUUID()
url.searchParams.set('role',role)
url.searchParams.set('room',room)
window.history.replaceState(null,'',url)
const otherUrl=new URL(url)
otherUrl.searchParams.set('role',role==='host'?'peer':'host')
if(roleElement)roleElement.textContent=role==='host'?'HOST (Player 1)':'PEER (Player 2)'
if(otherLink){
 otherLink.href=otherUrl.href
 otherLink.textContent=role==='host'?'Open the peer tab (Player 2)':'Open the host tab (Player 1)'
}
log('Starting PRK81H independent native worker test')
log('Role: '+role)
log('Cross-origin isolated: '+window.crossOriginIsolated)
if(!window.crossOriginIsolated||typeof SharedArrayBuffer!=='function')
 throw Error('COOP/COEP + SharedArrayBuffer required')
if(!('BroadcastChannel' in window))throw Error('BroadcastChannel unavailable')
if(role==='host')log('Open the peer tab using the link above; test will start automatically.')

type Mode='valid'|'stale'|'timeout'
type Case={marker:number;mode:Mode;expected:number}
type NativeStats={matched:number;rejected:number;timedOut:number;dropped:number}
type WorkerMsg={
 kind:string;stage?:string;message?:string;stamp?:number;role?:string;
 tx?:number;rx?:number;heap?:SharedArrayBuffer;marker?:number;
 sequence?:number;frame?:Uint8Array;timestamp?:number;aid?:number;
 result?:number;elapsed?:number;stats?:NativeStats
}
type WireMessage={
 kind:'hello'|'ready'|'command'|'reply';
 room:string;role:'host'|'peer';from:string;to?:string;
 sequence?:number;marker?:number;mode?:Mode;frame?:Uint8Array;
 timestamp?:number;aid?:number
}
const scenarios:Case[]=[
 {marker:11,mode:'valid',expected:2},
 {marker:22,mode:'valid',expected:2},
 {marker:33,mode:'valid',expected:2},
 {marker:44,mode:'stale',expected:0},
 {marker:55,mode:'timeout',expected:0},
]
const me=crypto.randomUUID()
const channel=new BroadcastChannel('pokerun-prk81h-cross-tab-v1-'+room)
const worker=new Worker('/prk81h-cross-tab-worker.js?role='+role,{type:'classic'})
let remote:string|null=null
let peerAcked=false
let workerReady=false,started=false,done=false
let txCtrl:Int32Array|null=null,txFrame:Uint8Array|null=null
let rxCtrl:Int32Array|null=null,rxFrame:Uint8Array|null=null
let testIndex=0,pending:{sequence:number;marker:number;mode:Mode;sentAt:number}|null=null
let stats:NativeStats|null=null
let receivedFromPeer=0,peerRepliesProduced=0,withheld=0
let heartbeats=0
const pulse=window.setInterval(()=>heartbeats++,10)
const sessionStarted=performance.now()
let watchdog:number|null=null
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
 window.clearInterval(pulse)
 window.clearInterval(helloTimer)
 if(watchdog!==null)window.clearTimeout(watchdog)
 worker.terminate()
 channel.close()
}
function startIfReady(){
 if(done||started||role!=='host'||!workerReady||!remote||!peerAcked)return
 started=true
 watchdog=window.setTimeout(()=>closeSession('Peer round trips did not complete within 20 seconds.',true),20000)
 log('Two-way ready acknowledged; starting five native callback exchanges.')
 next()
}
function next(){
 if(done)return
 if(testIndex===scenarios.length){
  if(!stats||stats.matched!==3||stats.rejected!==1||
     stats.timedOut!==1||stats.dropped!==0||receivedFromPeer!==4){
   closeSession('Native statistics or peer delivery count incorrect: '+JSON.stringify({stats,receivedFromPeer}),true)
   return
  }
  log('Native matched replies: '+stats.matched+'/3')
  log('Native wrong-sequence rejects: '+stats.rejected+'/1')
  log('Native missing-reply timeouts: '+stats.timedOut+'/1')
  log('Peer-produced replies received: '+receivedFromPeer+'/4')
  log('Native TX publication drops: '+stats.dropped)
  log('Browser heartbeats: '+heartbeats)
  log('Elapsed: '+(performance.now()-sessionStarted).toFixed(1)+' ms')
  closeSession('PASS: two independent native WASM instances exchanged test packets via cross-tab BroadcastChannel.')
  log('Actual Pokémon DS frames, radio negotiation, and gameplay ACK behavior remain untested.')
  return
 }
 // Arm polling before native execution; worker message delivery can be late.
 handleHostCalling(scenarios[testIndex].marker)
 if(!done)worker.postMessage({kind:'host-test',marker:scenarios[testIndex].marker})
}
function handleHostCalling(marker:number){
 const test=scenarios[testIndex]
 const control=txCtrl,bytes=txFrame
 if(!test||!control||!bytes||marker!==test.marker||pending){
  closeSession('Host native test state mismatch.',true)
  return
 }
 const until=performance.now()+600
 const poll=()=>{
  if(done)return
  if(Atomics.load(control,0)!==1){
   if(performance.now()>until){closeSession('Native MP_SendCmd did not publish command.',true);return}
   window.setTimeout(poll,1)
   return
  }
  const sequence=Atomics.load(control,1)
  const len=Atomics.load(control,2)
  const timestampLow=Atomics.load(control,3)
  const timestampHigh=Atomics.load(control,4)
  if(sequence!==testIndex+1||len!==36||timestampLow!==1000||timestampHigh!==0||
     bytes[10]!==24||bytes[11]!==0||bytes[14]!==test.marker){
   closeSession('Invalid native command publication seq='+sequence+' len='+len,true)
   return
  }
  const frame=bytes.slice(0,len)
  Atomics.store(control,0,0)
  pending={sequence,marker,mode:test.mode,sentAt:performance.now()}
  log('Host native CMD '+sequence+' published at +'+(performance.now()-sessionStarted).toFixed(1)+'ms; forwarding to peer.')
  if(!remote){closeSession('Peer disappeared.',true);return}
  const msg:WireMessage={
   kind:'command',room,role:'host',from:me,to:remote,
   sequence,marker,mode:test.mode,frame,timestamp:1000
  }
  channel.postMessage(msg)
 }
 poll()
}
function commitRemoteReply(message:WireMessage){
 const p=pending,control=rxCtrl,bytes=rxFrame
 if(!p||!control||!bytes||message.sequence!==p.sequence||
    message.marker!==p.marker||p.mode==='timeout'){
  closeSession('Unsolicited or out-of-order peer reply.',true)
  return
 }
 log('Remote reply arrived after '+(performance.now()-p.sentAt).toFixed(1)+'ms')
 const frame=message.frame
 if(!(frame instanceof Uint8Array)||frame.length!==36||
    frame[10]!==24||frame[11]!==0||
    frame[14]!==p.marker||frame[15]!==0xA7||
    message.aid!==1||message.timestamp!==1000){
  closeSession('Peer callback reply failed frame and origin validation.',true)
  return
 }
 // Store exactly the packet received from the second WASM instance.
 // Only the stale negative test deliberately corrupts the mailbox sequence.
 const until=performance.now()+100
 const poll=()=>{
  if(done)return
  if(Atomics.load(control,0)!==1){
   if(performance.now()>until){closeSession('Native host no longer waiting for peer.',true);return}
   window.setTimeout(poll,1)
   return
  }
  window.setTimeout(()=>{
   if(done)return
   if(Atomics.load(control,0)!==1){closeSession('Native host timed out before delivery.',true);return}
   bytes.fill(0)
   bytes.set(frame)
   Atomics.store(control,1,p.mode==='stale'?p.sequence+1:p.sequence)
   Atomics.store(control,2,frame.length)
   Atomics.store(control,3,1)
   Atomics.store(control,0,2)
   Atomics.notify(control,0,1)
   receivedFromPeer++
   log('Remote native reply '+p.sequence+' delivered ('+p.mode+')')
  },2)
 }
 poll()
}
worker.onerror=e=>closeSession('Worker error: '+e.message,true)
worker.onmessageerror=()=>closeSession('Unreadable WASM worker message.',true)
worker.onmessage=(event:MessageEvent<WorkerMsg>)=>{
 const m=event.data
 if(done)return
 if(m.kind==='stage'){log('Worker: '+m.stage);return}
 if(m.kind==='error'){closeSession((m.stage||'unknown')+': '+m.message,true);return}
 if(m.kind==='ready'){
  if(m.stamp!==0x50524b4b||m.role!==role){closeSession('Wrong WASM runtime or worker role.',true);return}
  if(role==='host'){
   if(!m.heap||m.tx===undefined||m.rx===undefined){closeSession('Missing native mailbox.',true);return}
   try{
    txCtrl=new Int32Array(m.heap,m.tx,8)
    txFrame=new Uint8Array(m.heap,m.tx+32,2048)
    rxCtrl=new Int32Array(m.heap,m.rx,8)
    rxFrame=new Uint8Array(m.heap,m.rx+32,1024)
   }catch(e){closeSession('Could not map native WASM mailboxes: '+String(e),true);return}
  }
  workerReady=true
  log('Real melonDS worker ready; stamp 0x'+m.stamp.toString(16))
  announce()
  signalReady()
  startIfReady()
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
     ', forwarded='+Boolean(pending)+', received='+receivedFromPeer+
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
   log('Other tab discovered; answering hello immediately.')
   announce()
  }
  signalReady()
  return
 }
 if(m.kind==='ready'){
  if(remote===m.from&&m.to===me&&workerReady){
   if(!peerAcked){
    peerAcked=true
    log('Other tab acknowledged this worker; two-way handshake ready.')
   }
   startIfReady()
  }
  return
 }
 if(!remote||m.from!==remote||m.to!==me||!workerReady)return
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
  commitRemoteReply(m)
 }
}
