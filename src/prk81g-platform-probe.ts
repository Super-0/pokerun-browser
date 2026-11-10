// PRK81G: prove native MP_SendCmd publishes a command before
// MP_RecvReplies enters its bounded native wait. Reply is a controlled
// synthetic TEST packet, not a peer's wireless packet or forged ACK.
const logEl=document.querySelector<HTMLPreElement>('#log')
const log=(message:string)=>{if(logEl)logEl.textContent+=(logEl.textContent?'\n':'')+message;console.info('[PRK81G]',message)}
if(logEl)logEl.textContent=''
log('Starting PRK81G native platform callback test')
log('Cross-origin isolated: '+window.crossOriginIsolated)
if(!window.crossOriginIsolated||typeof SharedArrayBuffer!=='function')
  throw Error('Cross-origin isolation + SharedArrayBuffer required.')
type Counters={matched:number;rejected:number;timedOut:number;dropped:number}
type WorkerMsg={
 kind:string;stage?:string;message?:string;stamp?:number;
 txPtr?:number;rxPtr?:number;heap?:SharedArrayBuffer;
 marker?:number;result?:number;ms?:number;stats?:Counters
}
type Case={marker:number;mode:'valid'|'stale'|'timeout';result:number}
const cases:Case[]=[
 {marker:11,mode:'valid',result:2},
 {marker:22,mode:'stale',result:0},
 {marker:33,mode:'timeout',result:0}
]
const worker=new Worker('/prk81g-platform-worker.js',{type:'classic'})
let txCtrl:Int32Array|null=null,txData:Uint8Array|null=null
let rxCtrl:Int32Array|null=null,rxData:Uint8Array|null=null
let index=0,finished=false,heartbeats=0,committed=0
let lastStats:Counters|null=null
const start=performance.now()
const pulse=window.setInterval(()=>heartbeats++,10)
const watchdog=window.setTimeout(()=>finish('FAIL: PRK81G timed out after 10 seconds'),10000)
function finish(message:string){
 if(finished)return
 finished=true;log(message)
 window.clearInterval(pulse);window.clearTimeout(watchdog);worker.terminate()
}
function next(){
 if(index===cases.length){
  const stats=lastStats
  if(!stats||stats.matched!==1||stats.rejected!==1||stats.timedOut!==1||stats.dropped!==0){
   finish('FAIL: incorrect native counters '+JSON.stringify(stats));return
  }
  log('Native matched: '+stats.matched)
  log('Native rejected wrong sequence: '+stats.rejected)
  log('Native timed out on missing reply: '+stats.timedOut)
  log('Unpublished commands: '+stats.dropped)
  log('Browser test replies committed: '+committed+'/2')
  log('Browser heartbeats: '+heartbeats)
  log('Elapsed: '+(performance.now()-start).toFixed(1)+' ms')
  finish('PASS: actual platform CMD callback published before native reply wait, with valid/reject/timeout outcomes.')
  log('No real peer gameplay or native ACK correctness was tested.')
  return
 }
 worker.postMessage({kind:'run',marker:cases[index].marker})
}
function handleCommand(test:Case){
 const cmd=txCtrl,frame=txData,reply=rxCtrl,replyBytes=rxData
 if(!cmd||!frame||!reply||!replyBytes){finish('FAIL: mailboxes unavailable');return}
 const until=performance.now()+750
 const check=()=>{
  if(finished)return
  if(Atomics.load(cmd,0)!==1){
   if(performance.now()>until){finish('FAIL: native MP_SendCmd never published marker '+test.marker);return}
   window.setTimeout(check,1);return
  }
  const sequence=Atomics.load(cmd,1)
  const len=Atomics.load(cmd,2)
  const stampLow=Atomics.load(cmd,3)
  const stampHigh=Atomics.load(cmd,4)
  if(sequence!==index+1||len!==36||stampLow!==1000||stampHigh!==0||
     frame[10]!==24||frame[11]!==0||frame[14]!==test.marker){
   finish('FAIL: outgoing native CMD invalid (seq='+sequence+', len='+len+')');return
  }
  log('Native MP_SendCmd published seq='+sequence+' marker='+test.marker)
  // Copy before freeing slot; this retains the original C++ radio frame.
  const cmdBytes=frame.slice(0,len)
  Atomics.store(cmd,0,0)
  const waitForReply=()=>{
   if(finished)return
   if(Atomics.load(reply,0)!==1){
    if(performance.now()>until){finish('FAIL: native MP_RecvReplies did not wait for seq '+sequence);return}
    window.setTimeout(waitForReply,1);return
   }
   if(test.mode==='timeout'){log('Deliberately withheld reply for timeout test');return}
   window.setTimeout(()=>{
    if(finished)return
    if(Atomics.load(reply,0)!==1){finish('FAIL: native waiter left state before packet commit');return}
    replyBytes.fill(0)
    replyBytes.set(cmdBytes)
    Atomics.store(reply,1,test.mode==='stale'?sequence+1:sequence)
    Atomics.store(reply,2,cmdBytes.length)
    Atomics.store(reply,3,1)
    Atomics.store(reply,0,2)
    Atomics.notify(reply,0,1)
    committed++
   },10)
  }
  waitForReply()
 }
 check()
}
worker.onerror=e=>finish('FAIL: worker '+e.message)
worker.onmessageerror=()=>finish('FAIL: unreadable worker message')
worker.onmessage=(event:MessageEvent<WorkerMsg>)=>{
 if(finished)return
 const m=event.data
 if(m.kind==='stage'){log('Worker: '+m.stage);return}
 if(m.kind==='error'){finish('FAIL: '+m.stage+': '+m.message);return}
 if(m.kind==='ready'){
  if(m.stamp!==0x50524b4a||!m.heap||m.txPtr===undefined||m.rxPtr===undefined){
   finish('FAIL: invalid runtime/heap from Worker');return
  }
  try{
   txCtrl=new Int32Array(m.heap,m.txPtr,8)
   txData=new Uint8Array(m.heap,m.txPtr+32,2048)
   rxCtrl=new Int32Array(m.heap,m.rxPtr,8)
   rxData=new Uint8Array(m.heap,m.rxPtr+32,1024)
   log('Runtime stamp: 0x'+m.stamp.toString(16))
   log('Native CMD mailbox: '+m.txPtr+'; reply mailbox: '+m.rxPtr)
   next()
  }catch(e){finish('FAIL: could not map native mailboxes '+String(e))}
  return
 }
 const test=cases[index]
 if(!test||m.marker!==test.marker){finish('FAIL: unexpected worker response');return}
 if(m.kind==='calling'){handleCommand(test);return}
 if(m.kind==='result'){
  if(m.result!==test.result){finish('FAIL: '+test.mode+' expected '+test.result+', got '+m.result);return}
  log('Callback '+test.mode+': native result='+m.result+' ('+(m.ms??0).toFixed(1)+' ms)')
  lastStats=m.stats??null
  index++;next()
 }
}
