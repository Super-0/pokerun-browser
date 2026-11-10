// PRK81F native WASM futex smoke test.
// 20 valid test replies + 1 mismatched sequence + 1 timeout.
const output=document.querySelector<HTMLPreElement>('#log')
const log=(message:string)=>{
  if(output)output.textContent+=(output.textContent?'\n':'')+message
  console.info('[PRK81F]',message)
}
if(output)output.textContent=''
log('Starting PRK81F native WASM mailbox test')
log('Cross-origin isolated: '+window.crossOriginIsolated)
if(!window.crossOriginIsolated||typeof SharedArrayBuffer!=='function')
  throw Error('COOP/COEP and SharedArrayBuffer required')

type Case={sequence:number;mode:'valid'|'stale'|'timeout';expected:number}
type Msg={
  kind:string;stage?:string;message?:string;stamp?:number;
  address?:number;heap?:SharedArrayBuffer;sequence?:number;
  mode?:string;result?:number;waitMs?:number
}
const cases:Case[]=[
  ...Array.from({length:20},(_,i):Case=>({sequence:i+1,mode:'valid',expected:1})),
  {sequence:21,mode:'stale',expected:-2},
  {sequence:22,mode:'timeout',expected:0},
]
const worker=new Worker('/prk81f-native-mailbox-worker.js',{type:'classic'})
let ctrl:Int32Array|null=null
let packet:Uint8Array|null=null
let index=0
let accepted=0
let dispatched=0
let heartbeats=0
let totalWait=0
let finished=false
const started=performance.now()
const pulse=window.setInterval(()=>heartbeats++,10)
const watchdog=window.setTimeout(()=>finish('FAIL: test exceeded 15 seconds'),15000)
function finish(message:string){
  if(finished)return
  finished=true
  log(message)
  window.clearTimeout(watchdog)
  window.clearInterval(pulse)
  worker.terminate()
}
function next(){
  if(finished)return
  if(index===cases.length){
    log('Native matched replies: '+accepted+'/20')
    log('Browser replies committed: '+dispatched+'/21')
    log('Mean native wait: '+(totalWait/20).toFixed(1)+' ms')
    log('Browser heartbeats: '+heartbeats)
    log('Elapsed: '+(performance.now()-started).toFixed(1)+' ms')
    finish('PASS: native C++ accepted 20 replies, rejected a stale sequence, and timed out safely.')
    log('Actual multiplayer and Wifi.cpp host ACK handling remain untested.')
    return
  }
  const test=cases[index]
  worker.postMessage({kind:'wait',sequence:test.sequence,mode:test.mode})
}
function offerReply(sequence:number,mode:string){
  const state=ctrl,bytes=packet
  if(!state||!bytes){finish('FAIL: missing shared mailbox');return}
  const deadline=performance.now()+600
  const check=()=>{
    if(finished)return
    if(Atomics.load(state,0)!==1||Atomics.load(state,1)!==sequence){
      if(performance.now()>deadline){
        finish('FAIL: native waiter never entered WAITING for seq '+sequence)
        return
      }
      window.setTimeout(check,1)
      return
    }
    if(mode==='timeout')return // Deliberately missing packet.
    window.setTimeout(()=>{
      if(finished)return
      if(Atomics.load(state,0)!==1){
        finish('FAIL: native waiter left WAITING before seq '+sequence)
        return
      }
      bytes.fill(0)
      bytes[10]=24
      bytes[11]=0
      bytes[12]=8
      bytes[13]=1
      bytes[14]=sequence&255
      Atomics.store(state,2,mode==='stale'?sequence+1:sequence)
      Atomics.store(state,3,36)
      Atomics.store(state,4,1)
      Atomics.store(state,0,2)
      Atomics.notify(state,0,1)
      dispatched++
    },10)
  }
  check()
}
worker.onerror=e=>finish('FAIL: worker exception '+e.message)
worker.onmessageerror=()=>finish('FAIL: unreadable worker message')
worker.onmessage=(event:MessageEvent<Msg>)=>{
  if(finished)return
  const msg=event.data
  if(msg.kind==='stage'){log('Worker: '+msg.stage);return}
  if(msg.kind==='error'){finish('FAIL: '+msg.stage+': '+msg.message);return}
  if(msg.kind==='ready'){
    if(msg.stamp!==0x50524b49||!msg.heap||typeof msg.address!=='number'){
      finish('FAIL: invalid worker runtime/heap')
      return
    }
    try{
      ctrl=new Int32Array(msg.heap,msg.address,8)
      packet=new Uint8Array(msg.heap,msg.address+32,64)
      log('Real melonDS worker ready; stamp 0x'+msg.stamp.toString(16))
      log('Shared WASM heap: '+Math.round(msg.heap.byteLength/1048576)+' MB')
      log('Native mailbox address: '+msg.address)
      next()
    }catch(e){finish('FAIL: invalid mailbox '+String(e))}
    return
  }
  const expected=cases[index]
  if(!expected){finish('FAIL: extra worker response');return}
  if(msg.sequence!==expected.sequence||msg.mode!==expected.mode){
    finish('FAIL: out-of-order test response')
    return
  }
  if(msg.kind==='waiting'){
    offerReply(expected.sequence,expected.mode)
    return
  }
  if(msg.kind==='result'){
    if(msg.result!==expected.expected){
      finish('FAIL: expected '+expected.mode+' result '+expected.expected+', received '+msg.result)
      return
    }
    if(expected.mode==='valid'){
      accepted++
      totalWait+=msg.waitMs??0
      if(accepted<=3||accepted===20)
        log('Real native reply accepted '+accepted+'/20 (wait '+(msg.waitMs??0).toFixed(1)+' ms)')
    }else if(expected.mode==='stale'){
      log('Mismatched sequence correctly rejected: native result -2')
    }else{
      log('Missing reply safely timed out: native result 0')
    }
    index++
    next()
  }
}
