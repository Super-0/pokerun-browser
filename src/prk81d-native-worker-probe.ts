// PRK81D: test actual melonDS runtime initialization inside one classic Worker.
// Only the generated runtime is loaded; there is no ROM or game frame.
const el=document.querySelector<HTMLPreElement>('#report')
const log=(s:string)=>{if(el)el.textContent+=(el.textContent?'\n':'')+s;console.info('[PRK81D]',s)}
async function main() {
 if(el)el.textContent=''
 log('Starting PRK81D native worker bootstrap probe')
 log('Cross-origin isolated: '+window.crossOriginIsolated)
 if(!window.crossOriginIsolated)throw Error('Cross-origin isolation required.')
 const worker=new Worker('/prk81d-native-worker.js',{type:'classic'})
 let heartbeats=0
 const pulse=window.setInterval(()=>heartbeats++,10)
 const start=performance.now()
 try {
   await new Promise<void>((resolve,reject)=>{
     let finished=false
     const done=(error?:Error)=>{if(finished)return;finished=true;window.clearTimeout(watchdog);if(error)reject(error);else resolve()}
     const watchdog=window.setTimeout(()=>done(Error('Worker startup timed out after 25 seconds.')),25000)
     worker.onerror=e=>done(Error(e.message||'Worker crashed'))
     worker.onmessageerror=()=>done(Error('Malformed worker message'))
     worker.onmessage=(event:MessageEvent<{kind:string;stage?:string;error?:string;stamp?:number;budget?:number;count?:number;isolated?:boolean}>)=>{
       const m=event.data
       if(m.kind==='stage')log('Worker: '+m.stage+(m.isolated===undefined?'':' (isolated='+m.isolated+')'))
       else if(m.kind==='failed')done(Error('Worker '+m.stage+': '+m.error))
       else if(m.kind==='passed'){
         log('Runtime stamp: 0x'+m.stamp?.toString(16))
         log('ARM9 call budget: '+m.budget)
         log('Reply RX count: '+m.count)
         done()
       }
     }
     worker.postMessage({kind:'start'})
   })
   log('Main-thread heartbeats: '+heartbeats)
   log('Elapsed: '+(performance.now()-start).toFixed(1)+' ms')
   log('PASS: native WASM initialized in a worker. No ROM or frame execution tested.')
 }finally { window.clearInterval(pulse);worker.terminate() }
}
void main().catch(error=>log('FAIL: '+String(error?.stack||error)))